/**
 * `audio render | analyze | at` — mix, measure and query the audio.
 *
 * Port of `fn audio` and `fn mixer_for` in `.source/fframes/fframes/src/renderer/cli.rs:1049-1283`.
 *
 * All three subcommands share the same first step, which is `mixer_for`: the range is converted
 * to samples, the total is the whole video in samples, and every file of the map is decoded. The
 * mixer is stateful (the limiter has a delay line), so it is rendered in one pass, in order.
 *
 * `analyze --waveform` (the waveform PNG) is out of scope per contract §1, so the flag is
 * reported as unsupported rather than silently ignored.
 */

import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeAudio } from '../audio/analysis.ts';
import type { AudioAnalysis, AnalysisSection } from '../audio/analysis.ts';
import { mixAudioToFile } from '../audio/mixer.ts';
import { readWav } from '../audio/wav.ts';
import {
  createSessionMixer,
  decodeSessionAudio,
  missingAudioFilesOf,
  resolveSessionAudio,
} from '../render/resvg-backend.ts';
import type { RenderSession } from '../render/resvg-backend.ts';
import type { FrameRange } from '../core/time-spec.ts';
import type { CliIo } from './args.ts';
import { printReport } from './args.ts';
import { ensureParent } from './render.ts';

export const AUDIO_SPECS = [
  { name: 'frame-range', kind: 'string', help: 'Range of the video to mix, all of it by default.' },
  {
    name: 'output',
    kind: 'string',
    short: 'o',
    help: 'Where audio render writes, <defaultOutput>.wav (out.wav without one) by default.',
  },
  { name: 'float', kind: 'boolean', help: 'Write 32-bit float instead of 16-bit PCM.' },
  { name: 'at', kind: 'string', help: 'Times to query with audio at.' },
] as const;

/**
 * The default file `audio render` writes, derived from the video's `defaultOutput`.
 *
 * The contract §3 fixes the rule as "`<defaultOutput> without its extension`.wav, or `out.wav`", so
 * a video whose `defaultOutput` is `out.mp4` mixes to `out.wav` next to it. Rust spells the
 * constant `audio.wav` (`cli.rs:226`); where the contract and the original disagree the contract is
 * the single source of truth for this port, and the derivation is a superset of the constant
 * (`out.mp4 -> out.wav`, no `defaultOutput -> out.wav`).
 */
export function defaultAudioOutput(defaultOutput?: string | null): string {
  if (defaultOutput === undefined || defaultOutput === null || defaultOutput.trim() === '') {
    return 'out.wav';
  }
  const dot = defaultOutput.lastIndexOf('.');
  const slash = Math.max(defaultOutput.lastIndexOf('/'), defaultOutput.lastIndexOf('\\'));
  // Only a real extension counts: a dot inside a directory name is not one.
  const base = dot > slash && dot > 0 ? defaultOutput.slice(0, dot) : defaultOutput;
  return `${base}.wav`;
}

/**
 * Mixes a range and writes it to a WAV.
 *
 * The WAV is the two stage half of the pipeline (contract §7): it is what `encodeVideo` passes to
 * ffmpeg as a second `-i`, and what `analyze` reads back to measure what was actually written.
 */
export async function renderAudioToFile(
  session: RenderSession,
  options: {
    readonly range: FrameRange;
    readonly output: string;
    readonly float?: boolean;
  },
): Promise<{
  readonly path: string;
  readonly missingFiles: string[];
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly sampleRate: number;
}> {
  const sampleRate = session.options.sampleRate ?? 44100;
  ensureParent(options.output);

  // The mix reads samples, so the files have to be decoded first. The session caches them, so
  // `audio at` and `analyze` after an `audio render` pay the decode once.
  await decodeSessionAudio(session);

  const startSample = Math.trunc((options.range.start * sampleRate) / session.video.fps);
  const endSample = Math.trunc((options.range.end * sampleRate) / session.video.fps);

  mixAudioToFile(
    {
      tracks: resolveSessionAudio(session),
      audio: session.audioCache,
      sampleRate,
      mapSampleRate: sampleRate,
      outputRange: { start: startSample, end: endSample },
      totalSamples: Math.trunc((session.durationInFrames * sampleRate) / session.video.fps),
      options: session.options.mixerOptions,
    },
    options.output,
    { float: options.float === true },
  );

  return {
    path: options.output,
    // The same rule `render` uses — a property of the media directory, not of the decode cache —
    // read after `decodeSessionAudio` above, so a file that exists but that ffmpeg refuses counts as
    // missing too (it contributed no samples either way).
    missingFiles: missingAudioFilesOf(session),
    startSeconds: startSample / sampleRate,
    endSeconds: endSample / sampleRate,
    sampleRate,
  };
}

/**
 * The scenes of the range, as the per scene sections of the loudness report.
 *
 * `cli.rs:1129-1144` rounds the frame to the nearest sample, clamps it into the range and then
 * makes it relative to the range start, because the analyser only sees the excerpt.
 */
export function sectionsForRange(
  session: RenderSession,
  range: FrameRange,
  startSample: number,
  endSample: number,
  sampleRate: number,
): AnalysisSection[] {
  const fps = session.video.fps;
  const toSample = (frame: number): number =>
    Math.min(Math.max(Math.round((frame * sampleRate) / fps), startSample), endSample) - startSample;

  return (session.scenes?.timeline ?? [])
    .filter((scene) => scene.startFrame < range.end && scene.endFrame > range.start)
    .map((scene) => ({
      name: scene.name,
      start: toSample(scene.startFrame),
      end: toSample(scene.endFrame),
    }));
}

/**
 * Mixes a range to a temporary WAV and measures it.
 *
 * The report's section and silence times are shifted by the range's start, exactly as
 * `cli.rs:1146-1154` does, so `audio analyze --frame-range 5s..` reports absolute timeline
 * seconds rather than seconds from the start of the excerpt.
 */
export async function analyzeAudioRange(
  session: RenderSession,
  options: { readonly range: FrameRange; readonly sections?: boolean },
): Promise<{ readonly report: AudioAnalysis; readonly missingFiles: string[] }> {
  const sampleRate = session.options.sampleRate ?? 44100;
  const path = join(tmpdir(), `fframes-audio-${randomUUID()}.wav`);

  try {
    const written = await renderAudioToFile(session, { range: options.range, output: path });
    const wav = readWav(path);
    const startSample = Math.trunc((options.range.start * sampleRate) / session.video.fps);
    const endSample = Math.trunc((options.range.end * sampleRate) / session.video.fps);

    const sections =
      options.sections === false
        ? []
        : sectionsForRange(session, options.range, startSample, endSample, sampleRate);

    // The WAV is interleaved; `analyzeAudio` splits it, and a mono file counts as two passes,
    // which is the `left.chain(right)` semantics of the Rust analyser.
    //
    // `sections` is the **second parameter** of `analyzeAudio` (`analysis.ts:469`), not a field of
    // `AnalyzeAudioInput`: named sample ranges, measured with the same two gates as the whole
    // excerpt — `loudness.integrated(start, end)` for the LUFS and the 4x interpolated peak of
    // the slice for dBTP (`analysis.ts:531-537`), which is what `cli.rs:1129-1154` reports per
    // scene. The samples are already relative to the range start (see `sectionsForRange`).
    const report = analyzeAudio(
      {
        interleaved: wav.samples,
        channels: wav.header.channels,
        sampleRate,
      },
      sections,
    );

    // Shift the timeline back onto the video, like `cli.rs:1146-1154`.
    const offset = written.startSeconds;
    const shifted: AudioAnalysis = {
      ...report,
      sections: report.sections.map((section) => ({
        ...section,
        startSeconds: section.startSeconds + offset,
        endSeconds: section.endSeconds + offset,
      })),
      silentRanges: report.silentRanges.map(([start, end]) => [start + offset, end + offset]),
    };

    return { report: shifted, missingFiles: written.missingFiles };
  } finally {
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }
}

/** The loudness report as text, `audio_report_text` of `cli.rs:1240-1283`. */
export function analyzeText(report: AudioAnalysis, missingFiles: readonly string[]): string {
  const db = (value: number | null, unit: string): string =>
    value === null ? 'silent' : `${value.toFixed(1)} ${unit}`;

  let text =
    `integrated ${db(report.integratedLufs, 'LUFS')}, ` +
    `range ${report.loudnessRangeLu === null ? '-' : `${report.loudnessRangeLu.toFixed(1)} LU`}, ` +
    `max momentary ${db(report.maxMomentaryLufs, 'LUFS')}, ` +
    `max short-term ${db(report.maxShortTermLufs, 'LUFS')}\n` +
    `sample peak ${db(report.samplePeakDb, 'dBFS')}, ` +
    `true peak ${db(report.truePeakDb, 'dBTP')}, ` +
    `clipped samples ${report.clippingSamples}`;

  if (report.silent) {
    text += '\nthe mix is digitally silent';
  }
  for (const [start, end] of report.silentRanges) {
    text += `\nsilent ${start.toFixed(2)}s..${end.toFixed(2)}s`;
  }
  for (const section of report.sections) {
    text +=
      `\n${section.name.padEnd(28)} ` +
      `${`${section.startSeconds.toFixed(2)}s..${section.endSeconds.toFixed(2)}s`.padStart(18)} ` +
      `${db(section.integratedLufs, 'LUFS')} / peak ${db(section.truePeakDb, 'dBTP')}`;
  }
  for (const file of missingFiles) {
    text += `\nwarning: audio "${file}" is not in the media provider`;
  }
  return text;
}

/** The `--json` document of `audio analyze`, the fields the contract names plus the rest. */
export function analyzeJson(report: AudioAnalysis, missingFiles: readonly string[]): unknown {
  return {
    integratedLufs: report.integratedLufs,
    loudnessRangeLu: report.loudnessRangeLu,
    maxMomentaryLufs: report.maxMomentaryLufs,
    maxShortTermLufs: report.maxShortTermLufs,
    truePeakDb: report.truePeakDb,
    samplePeakDb: report.samplePeakDb,
    clippingSamples: report.clippingSamples,
    silent: report.silent,
    silentRanges: report.silentRanges,
    momentary: report.momentary,
    shortTerm: report.shortTerm,
    sections: report.sections,
    durationSeconds: report.durationSeconds,
    missingFiles,
  };
}

/** One `audio at` answer, `cli.rs:1192-1198`. */
export interface AudioAtReport {
  readonly spec: string;
  readonly frame: number;
  readonly seconds: number;
  readonly tracks: {
    readonly file: string;
    readonly positionInFileSeconds: number;
    readonly gainDb: number;
    readonly voice: boolean;
    readonly duckedDb: number;
  }[];
}

/** `audio at` — which tracks play at the given times, where in the file and how loud. */
export async function audioAt(
  session: RenderSession,
  specs: readonly { spec: string; frame: number }[],
): Promise<AudioAtReport[]> {
  const sampleRate = session.options.sampleRate ?? 44100;
  const mixer = await createSessionMixer(session, session.index.fullRange());

  return specs.map(({ spec, frame }) => ({
    spec,
    frame,
    seconds: frame / session.video.fps,
    tracks: mixer
      .activeTracksAt(Math.round((frame * sampleRate) / session.video.fps))
      .map((track) => ({
        file: track.file,
        positionInFileSeconds: track.fileSeconds,
        gainDb: track.gainDb,
        voice: track.voice,
        duckedDb: track.duckedDb,
      })),
  }));
}

/** The `audio at` text, `cli.rs:1200-1233`. */
export function audioAtText(reports: readonly AudioAtReport[]): string {
  return reports
    .map((report) => {
      let line = `${report.spec} (${report.seconds.toFixed(3)}s):`;
      if (report.tracks.length === 0) {
        return `${line} silence`;
      }
      for (const track of report.tracks) {
        // A track inside a fade in / de-click ramp can be at gain 0, which is `-inf` dB rather than
        // a number; printing `-inf dB` says "silent right now", which is what it means.
        const gain = Number.isFinite(track.gainDb) ? `${track.gainDb.toFixed(1)} dB` : '-inf dB';
        line += `\n  ${track.file} at ${track.positionInFileSeconds.toFixed(3)}s of the file, ${gain}`;
        if (track.voice) {
          line += ', voice';
        }
        // Rust prints the ducking only when it is audible: `Some(d) if d < -0.05` (cli.rs:1224-1225).
        if (track.duckedDb < -0.05) {
          line += `, ducked ${track.duckedDb.toFixed(1)} dB`;
        }
      }
      return line;
    })
    .join('\n');
}

/** `audio render` — mix to a WAV. */
export async function audioRenderCommand(
  session: RenderSession,
  options: {
    readonly range: FrameRange;
    readonly output?: string | null;
    /** `video.defaultOutput`, so the default mix path follows the video's own output (contract §3). */
    readonly defaultOutput?: string | null;
    readonly float?: boolean;
    readonly json: boolean;
    readonly io: CliIo;
  },
): Promise<number> {
  const output = options.output ?? defaultAudioOutput(options.defaultOutput);
  const written = await renderAudioToFile(session, {
    range: options.range,
    output,
    float: options.float,
  });

  printReport(
    options.io,
    options.json,
    {
      output: written.path,
      startSeconds: written.startSeconds,
      endSeconds: written.endSeconds,
      sampleRate: written.sampleRate,
      missingFiles: written.missingFiles,
    },
    () => {
      let text = `${written.path} ${written.startSeconds.toFixed(2)}s..${written.endSeconds.toFixed(2)}s`;
      for (const file of written.missingFiles) {
        text += `\nwarning: audio "${file}" is not in the media provider`;
      }
      return text;
    },
  );
  return 0;
}

/** `audio analyze` — the loudness report. */
export async function audioAnalyzeCommand(
  session: RenderSession,
  options: { readonly range: FrameRange; readonly json: boolean; readonly io: CliIo },
): Promise<number> {
  const { report, missingFiles } = await analyzeAudioRange(session, { range: options.range });
  printReport(options.io, options.json, analyzeJson(report, missingFiles), () =>
    analyzeText(report, missingFiles),
  );
  return 0;
}

/** `audio at` — the tracks playing at the given times. */
export async function audioAtCommand(
  session: RenderSession,
  options: {
    readonly specs: readonly { spec: string; frame: number }[];
    readonly json: boolean;
    readonly io: CliIo;
  },
): Promise<number> {
  const reports = await audioAt(session, options.specs);
  printReport(options.io, options.json, reports, () => audioAtText(reports));
  return 0;
}
