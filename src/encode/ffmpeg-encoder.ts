/**
 * The encoder: PNG frames on stdin, an `.mp4` (or any ffmpeg container) on disk.
 *
 * Port of `.source/fframes/fframes/src/renderer/encoder.rs` + `ffmpeg_helper.rs` +
 * `stream.rs`, reduced to what the contract keeps (M1): one serial frame pipe, libx264, an
 * optional WAV muxed as a second input, no segment splitting, no concatenation.
 *
 * ## The two hard pipeline constraints (contract §7)
 *
 * 1. **The video enters ffmpeg as PNGs, not raw pixels.** The Rust side hands `pixmap.data()`
 *    (raw RGBA) to a segment writer; the measured route is
 *    `-f image2pipe -vcodec png -r FPS -i pipe:0` (probe P5, 37.5 fps end to end at 1080p).
 *    The alternative — `-f rawvideo -pix_fmt rgba` over `RenderedImage.pixels` — measured 363 fps
 *    for the encode step alone (probe P2), so it is available as `inputFormat: 'rawvideo'`, but
 *    the PNG route is the default because the contract pins it.
 * 2. **The audio is a second `-i`, never a second pipe.** Two producers writing one stdin
 *    deadlock (contract R2), so the mix is written to a temporary WAV first (`audio/mixer.ts`
 *    `mixAudioToFile`) and passed as an input path here.
 *
 * ## Backpressure
 *
 * `stdin.write` returning `false` means the kernel buffer is full; the frame is not lost, the
 * write just has to wait for `drain`. `once(stdin, 'drain')` is the only flow control used
 * (contract §7).
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';

/** How the frames reach ffmpeg's stdin. */
export type FrameInputFormat = 'png' | 'rawvideo';

export interface EncodeVideoOptions {
  /** Intrinsic frame width (`Video.width`), before `scale`. */
  readonly width: number;
  /** Intrinsic frame height. */
  readonly height: number;
  readonly fps: number;
  /** Where to write. The parent directory has to exist. */
  readonly outPath: string;
  /**
   * The frames, in order. A callback is the shape the render loop uses; an iterable is the shape
   * short one-off renders use.
   */
  readonly frames: ((index: number) => Buffer | Promise<Buffer>) | Iterable<Buffer>;
  /** How many frames the callback produces. Required with the callback form. */
  readonly frameCount?: number;
  /** How the frames are encoded on the pipe. `png` by default (contract §7). */
  readonly inputFormat?: FrameInputFormat;
  /** Resolution multiplier; the frames must already be rasterized at this scale. */
  readonly scale?: number;
  /** A mixed WAV to mux in. Never fed through stdin (see the module header). */
  readonly audioWavPath?: string | null;
  /** `ultrafast` and a higher CRF — what `--draft` asks for (`cli.rs:568-577`). */
  readonly draft?: boolean;
  /** libx264 preset; `medium` unless `draft`. */
  readonly preset?: string;
  /** x264 CRF, `23` by default, `30` with `draft` (the Rust draft value). */
  readonly crf?: number;
  /** Audio encoder bitrate for the WAV input. */
  readonly audioBitrate?: string;
  /** Overrides `-c:v`, e.g. `libx265`. */
  readonly videoCodec?: string;
  /** ffmpeg stderr verbosity, kept for the error message. `error` by default. */
  readonly logLevel?: string;
  /** Called with the number of frames written so far. */
  readonly onFrame?: ((written: number, total: number) => void) | null;
  /** The ffmpeg binary; `ffmpeg` by default. */
  readonly binary?: string;
}

export interface EncodeVideoResult {
  /** Frames written to the pipe. */
  readonly frames: number;
  /** Seconds between spawning ffmpeg and its exit. */
  readonly elapsedSeconds: number;
  /** ffmpeg's stderr, trimmed. */
  readonly stderr: string;
}

/**
 * The argument vector, exported so it can be asserted on without spawning anything.
 *
 * Video input:
 *
 * ```text
 * -y -v error -f image2pipe -vcodec png -r 30 -i pipe:0
 * ```
 *
 * Audio input, muxed as a file (never a second pipe):
 *
 * ```text
 * -i mix.wav -c:a aac -b:a 192k -shortest
 * ```
 *
 * Video output:
 *
 * ```text
 * -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p out.mp4
 * ```
 */
export function buildFfmpegArgs(options: EncodeVideoOptions): string[] {
  const scale = options.scale ?? 1;
  const width = Math.max(1, Math.round(options.width * scale));
  const height = Math.max(1, Math.round(options.height * scale));
  const format = options.inputFormat ?? 'png';

  const args: string[] = ['-y', '-v', options.logLevel ?? 'error'];

  if (format === 'png') {
    // `-r` belongs to the input here: it declares the rate of the images in the pipe.
    args.push('-f', 'image2pipe', '-vcodec', 'png', '-r', String(options.fps), '-i', 'pipe:0');
  } else {
    args.push(
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-r',
      String(options.fps),
      '-i',
      'pipe:0',
    );
  }

  const wav = options.audioWavPath;
  if (wav !== undefined && wav !== null && wav !== '') {
    args.push('-i', wav, '-c:a', 'aac', '-b:a', options.audioBitrate ?? '192k', '-shortest');
  }

  args.push(
    '-c:v',
    options.videoCodec ?? 'libx264',
    '-preset',
    options.preset ?? (options.draft === true ? 'ultrafast' : 'medium'),
    '-crf',
    String(options.crf ?? (options.draft === true ? 30 : 23)),
    '-pix_fmt',
    'yuv420p',
    options.outPath,
  );

  return args;
}

function writeToStdin(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) {
    return Promise.resolve();
  }
  // The kernel buffer is full: the frame is queued, it just has to wait for room.
  return once(stream, 'drain').then(() => undefined);
}

/** The frames of a callback form, produced one at a time. */
async function* callbackFrames(
  produce: (index: number) => Buffer | Promise<Buffer>,
  count: number,
): AsyncGenerator<Buffer> {
  for (let index = 0; index < count; index += 1) {
    yield await produce(index);
  }
}

/** The frames of the iterable form. */
async function* iterableFrames(frames: Iterable<Buffer>): AsyncGenerator<Buffer> {
  for (const frame of frames) {
    yield frame;
  }
}

/**
 * `encodeVideo` — writes the frames and waits for ffmpeg.
 *
 * ```ts
 * await encodeVideo({
 *   width: 1920, height: 1080, fps: 30, outPath: 'out.mp4',
 *   frameCount: range.end - range.start,
 *   frames: (i) => renderSvgToPng(renderFrame(range.start + i), backend),
 *   audioWavPath: mixWav,
 * });
 * ```
 *
 * Frames are produced lazily, one at a time: the render loop is serial this round, and a
 * generator keeps the peak memory at one PNG instead of the whole video.
 */
export async function encodeVideo(options: EncodeVideoOptions): Promise<EncodeVideoResult> {
  if (!Number.isFinite(options.fps) || options.fps <= 0) {
    throw new RangeError(`encodeVideo: fps must be positive, got ${String(options.fps)}`);
  }
  const wav = options.audioWavPath;
  if (wav !== undefined && wav !== null && wav !== '' && !existsSync(wav)) {
    throw new Error(`encodeVideo: audio input "${wav}" does not exist`);
  }

  const iterable = typeof options.frames === 'function' ? null : (options.frames as Iterable<Buffer>);
  const producer =
    iterable === null
      ? callbackFrames(options.frames as (index: number) => Buffer | Promise<Buffer>, options.frameCount ?? 0)
      : iterableFrames(iterable);
  const total = options.frameCount ?? (Array.isArray(iterable) ? iterable.length : 0);

  const started = performance.now();
  const binary = options.binary ?? 'ffmpeg';
  const child = spawn(binary, buildFfmpegArgs(options), { stdio: ['pipe', 'ignore', 'pipe'] });

  const stdin = child.stdin;
  if (stdin === null) {
    child.kill('SIGKILL');
    throw new Error('encodeVideo: ffmpeg was started without a stdin pipe');
  }

  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  let written = 0;
  let feedError: unknown;
  // The pipe we write to has its own error event, and a write to a dead ffmpeg raises EPIPE there
  // asynchronously. Without this listener that event is unhandled and takes the whole process down
  // with an `Unhandled 'error' event`, losing the stderr text collected above — which is the only
  // useful part of the report. Recording it as `feedError` keeps the failure graceful: the message
  // below still mentions ffmpeg's own stderr, and the exit is a normal non-zero throw.
  stdin.on('error', (error: Error) => {
    if (feedError === undefined) {
      feedError = error;
    }
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal });
    });
  });
  // A spawn error (no ffmpeg in PATH) rejects here instead of surfacing as an exit code.
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    child.on('error', (error: Error) => {
      reject(new Error(`${binary} could not be started: ${error.message}`));
    });
  });

  const feeding = (async () => {
    try {
      for await (const frame of producer) {
        await writeToStdin(stdin, frame);
        written += 1;
        options.onFrame?.(written, total);
      }
      // Half-close: ffmpeg sees EOF and finishes the file.
      stdin.end();
    } catch (error) {
      // Either the producer threw or the pipe broke (ffmpeg died mid-write, EPIPE).
      feedError = error;
      stdin.destroy();
    }
  })();

  // Normally the producer finishes first and ffmpeg exits after EOF. Racing the two means a
  // failing ffmpeg is noticed immediately instead of waiting for a drain that will never come.
  await Promise.race([feeding, exited, spawnFailure]);
  if (feedError !== undefined) {
    throw feedError instanceof Error ? feedError : new Error(String(feedError));
  }
  const settled = await exited;

  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  if (settled.code !== 0) {
    const reason = settled.code === null ? `signal ${String(settled.signal)}` : `code ${String(settled.code)}`;
    throw new Error(
      `ffmpeg failed (${reason}) while writing "${options.outPath}": ${stderr === '' ? '<no stderr>' : stderr}`,
    );
  }

  return { frames: written, elapsedSeconds: (performance.now() - started) / 1000, stderr };
}
