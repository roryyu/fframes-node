/**
 * `render` — the default command: the whole video, or a range of it, to a file.
 *
 * Port of `fn render` in `.source/fframes/fframes/src/renderer/cli.rs:549-607` plus the frame
 * loop of `renderer/cpu.rs:121-175`.
 *
 * ## The order of the steps
 *
 * 1. build the session (timeline, duration, context) — `Previewer::new` in Rust,
 * 2. resolve `--frame-range`, or take the whole video (`timeline.full_range()`),
 * 3. `--draft` means half resolution *unless* `--scale` was given, plus the fastest preset
 *    (`cli.rs:568-577`),
 * 4. mix the audio of the range to a temporary WAV — two stages, never two pipes (§7),
 * 5. spawn ffmpeg once and write one PNG per frame, waiting for `drain` on backpressure,
 * 6. report, and delete the temporary WAV in a `finally`.
 *
 * ## Range and audio
 *
 * `RenderOptions::frame_range` renders part of a video **with matching audio**: the mixer's output
 * range is the frame range converted to samples, so `--frame-range 10s..20s` produces a 10 second
 * clip that starts at 10 s, not a 10 second clip of the beginning. That is why the mix is built
 * for `range` and not for the whole video.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { mixAudioToFile } from '../audio/mixer.ts';
import type { MixerOptions } from '../audio/mixer.ts';
import { encodeVideo } from '../encode/ffmpeg-encoder.ts';
import {
  decodeSessionAudio,
  missingAudioFilesOf,
  renderFramePng,
  resolveSessionAudio,
  scaledSize,
} from '../render/resvg-backend.ts';
import type { RenderSession } from '../render/resvg-backend.ts';
import type { FrameRange } from '../core/time-spec.ts';
import type { Video } from '../core/types.ts';
import type { ArgSpec } from './args.ts';

export const RENDER_SPECS: readonly ArgSpec[] = [
  { name: 'frame-range', kind: 'string', help: 'Only render this range, e.g. Intro, 10s..20s.' },
  { name: 'output', kind: 'string', short: 'o', help: 'Output file, out.mp4 by default.' },
  { name: 'draft', kind: 'boolean', help: 'Half resolution (unless --scale) and fastest preset.' },
  { name: 'crf', kind: 'number', help: 'x264 quality, 23 by default and 30 with --draft.' },
  { name: 'preset', kind: 'string', help: 'libx264 preset, medium by default, ultrafast with --draft.' },
  { name: 'float-audio', kind: 'boolean', help: 'Write the temporary mix as 32-bit float.' },
];

/** The `--json` document: `RenderResult` of `cli.rs:538-547` plus the fields the contract adds. */
export interface RenderReport {
  readonly output: string;
  readonly frames: { readonly start: number; readonly end: number };
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly seconds: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly audio: boolean;
  readonly missingAudioFiles: string[];
  readonly elapsedSeconds: number;
}

/** The `defaultOutput` of a video, or `out.mp4` — the Rust `Runner` default (`cli.rs:281`). */
export function defaultOutputFor(video: Video): string {
  return video.defaultOutput ?? 'out.mp4';
}

/** Creates the parent directory of `path`; `ensure_parent` of `cli.rs:531-537`. */
export function ensureParent(path: string): void {
  const parent = dirname(path);
  if (parent !== '' && parent !== '.') {
    mkdirSync(parent, { recursive: true });
  }
}

/** The one line the Rust CLI prints after a successful render (`cli.rs:593-605`). */
export function renderText(report: RenderReport): string {
  return (
    `${report.output} frames ${report.frames.start}..${report.frames.end} ` +
    `(${report.startSeconds.toFixed(2)}s..${report.endSeconds.toFixed(2)}s) ` +
    `${report.width}x${report.height} in ${report.elapsedSeconds.toFixed(1)}s`
  );
}

export interface RenderVideoOptions {
  readonly range: FrameRange;
  readonly output: string;
  /** Half resolution (unless `scale` is set) plus `ultrafast`. */
  readonly draft?: boolean;
  /** The already decided resolution multiplier, so `--scale` after `--draft` wins. */
  readonly scale?: number;
  readonly crf?: number;
  readonly preset?: string;
  readonly floatAudio?: boolean;
  readonly mixer?: MixerOptions;
  /** Progress, one call per frame. */
  readonly onProgress?: (frame: number, total: number) => void;
}
/**
 * `renderVideo` — renders a range of a session to a file.
 *
 * ```ts
 * const session = createRenderSession(video, { fps: video.fps, width: video.width, height: video.height });
 * await renderVideo(session, { range: session.index.fullRange(), output: 'out.mp4' });
 * ```
 */
export async function renderVideo(
  session: RenderSession,
  options: RenderVideoOptions,
): Promise<RenderReport> {
  const started = performance.now();
  const fps = session.video.fps;
  const total = Math.max(0, options.range.end - options.range.start);
  const sampleRate = session.options.sampleRate ?? 44100;

  ensureParent(options.output);

  // A video whose audio map names a file the media directory does not have still renders: the
  // frames are the point, the missing track is reported, and the mix is silent. The reason is on
  // the session (`audioResolveError`) for `inspect` to report; here it only means there is no WAV.
  const mixable = !session.audioMap.isNone() && total > 0 && session.audioResolveError === null;
  let wavPath: string | null = null;

  // Asked of the media directory rather than of the decode cache, which is still empty at report
  // time — every track of a healthy video used to be reported as missing. See `missingAudioFiles`
  // in the backend for the Rust rule this mirrors. Re-read after the decode inside the `try`,
  // because a file that exists but that ffmpeg refuses only becomes "missing" once the decode has
  // failed; when nothing is decoded this first read is already the answer.
  let missingAudioFiles = missingAudioFilesOf(session);

  // The temporary WAV is created inside the `try` and deleted in the `finally`: the try used to
  // start after the mix, so anything the mix itself threw (a zero sample WAV, an unwritable
  // tmpdir) leaked the file. `wavPath` is only non-null once the name is known, which is what
  // keeps the delete conditional — the same shape as `audio-cmd.ts:137-182`.
  try {
    if (mixable) {
      // Decoding happens once and is memoized on the session, so the mixer below reads samples
      // that are already in memory.
      await decodeSessionAudio(session);
      wavPath = join(tmpdir(), `fframes-${randomUUID()}.wav`);
      mixAudioToFile(
        {
          tracks: resolveSessionAudio(session),
          audio: session.audioCache,
          sampleRate,
          mapSampleRate: sampleRate,
          outputRange: {
            start: Math.trunc((options.range.start * sampleRate) / fps),
            end: Math.trunc((options.range.end * sampleRate) / fps),
          },
          totalSamples: Math.trunc((session.durationInFrames * sampleRate) / fps),
          options: options.mixer ?? session.options.mixerOptions,
        },
        wavPath,
        { float: options.floatAudio === true },
      );
      // Read after the decode: a file that exists but that ffmpeg refuses only becomes "missing"
      // once the decode has failed, and `decodeSessionAudio` records exactly that.
      missingAudioFiles = missingAudioFilesOf(session);
    }

    const encoded = await encodeVideo({
      width: session.video.width,
      height: session.video.height,
      fps,
      outPath: options.output,
      scale: options.scale,
      frameCount: total,
      draft: options.draft,
      crf: options.crf,
      preset: options.preset,
      audioWavPath: wavPath,
      frames: (index) => renderFramePng(session, options.range.start + index),
      onFrame: (written, frames) => options.onProgress?.(options.range.start + written, frames),
    });

    const size = scaledSize(session.video.width, session.video.height, options.scale ?? 1);
    const end = options.range.start + encoded.frames;
    return {
      output: options.output,
      frames: { start: options.range.start, end },
      startSeconds: options.range.start / fps,
      endSeconds: end / fps,
      seconds: encoded.frames / fps,
      width: size.width,
      height: size.height,
      fps,
      audio: wavPath !== null,
      missingAudioFiles,
      elapsedSeconds: (performance.now() - started) / 1000,
    };
  } finally {
    if (wavPath !== null && existsSync(wavPath)) {
      rmSync(wavPath, { force: true });
    }
  }
}
