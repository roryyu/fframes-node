/**
 * `timeline` — the structure of the video, without rendering it.
 *
 * Port of `fn timeline` in `.source/fframes/fframes/src/renderer/cli.rs:813-870`, which prints
 * `previewer.timeline_report()`: the size, the fps, the length, every scene with its frame and
 * second range, and every audio track with its mix settings.
 *
 * The `--json` shape is the one the contract fixes:
 * `{fps, width, height, durationFrames, durationSeconds, scenes[…], audio{sampleRate, tracks[…]}}`.
 * The human text keeps Rust's column layout, so the two are diffable against the original.
 */

import { resolveSessionAudio } from '../render/resvg-backend.ts';
import type { RenderSession } from '../render/resvg-backend.ts';
import type { CliIo } from './args.ts';
import { printReport } from './args.ts';

/** One scene, as `TimelineReport.scenes` spells it. */
export interface TimelineSceneReport {
  readonly index: number;
  readonly name: string;
  readonly fullName: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/** One audio track, as `TimelineReport.audio` spells it. */
export interface TimelineTrackReport {
  readonly file: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly gainDb: number;
  readonly volume: number;
  readonly pan: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly fadeCurve: string;
  /** Where in the file the track starts playing, in seconds. The contract spells it `offsetSeconds`. */
  readonly offsetSeconds: number;
  readonly voice: boolean;
  readonly ducking: {
    readonly depthDb: number;
    readonly attack: number;
    readonly hold: number;
    readonly release: number;
    readonly mergeGap: number;
  } | null;
}

/** The whole report. */
export interface TimelineReport {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationFrames: number;
  readonly durationSeconds: number;
  readonly scenes: TimelineSceneReport[];
  readonly audio: {
    readonly sampleRate: number;
    readonly tracks: TimelineTrackReport[];
  };
}

/** Builds the report of a session. No rendering, no decoding: only the resolved timeline. */
export function timelineReport(session: RenderSession): TimelineReport {
  const fps = session.video.fps;
  const sampleRate = session.options.sampleRate ?? 44100;

  return {
    fps,
    width: session.video.width,
    height: session.video.height,
    durationFrames: session.durationInFrames,
    durationSeconds: session.durationInFrames / fps,
    scenes: (session.scenes?.timeline ?? []).map((scene) => ({
      index: scene.index,
      name: scene.name,
      fullName: scene.fullName,
      startFrame: scene.startFrame,
      endFrame: scene.endFrame,
      startSeconds: scene.startFrame / fps,
      endSeconds: scene.endFrame / fps,
    })),
    audio: {
      sampleRate,
      tracks: resolveSessionAudio(session).map((track) => ({
        file: track.file,
        startSeconds: track.range.start / sampleRate,
        endSeconds: track.range.end / sampleRate,
        startFrame: Math.trunc((track.range.start * fps) / sampleRate),
        endFrame: Math.trunc((track.range.end * fps) / sampleRate),
        gainDb: track.mix.gainDb,
        // The linear level the dB means: `volume(0.5)` in Rust stores `20·log10(0.5)` in
        // `gain_db`, so the inverse is what a caller who set a volume wants to read back.
        volume: track.mix.gainDb === 0 ? 1 : 10 ** (track.mix.gainDb / 20),
        pan: track.mix.pan,
        fadeIn: track.mix.fadeIn,
        fadeOut: track.mix.fadeOut,
        fadeCurve: track.mix.fadeCurve,
        offsetSeconds: track.mix.offset,
        voice: track.mix.voice,
        ducking:
          track.mix.duck === null
            ? null
            : {
                depthDb: track.mix.duck.depthDb,
                attack: track.mix.duck.attack,
                hold: track.mix.duck.hold,
                release: track.mix.duck.release,
                mergeGap: track.mix.duck.mergeGap,
              },
      })),
    },
  };
}

/**
 * The human report, with Rust's column layout (`cli.rs:817-867`).
 *
 * The extra mix notes are the ones the Rust text adds conditionally: a non zero gain, a pan, any
 * fade, a non zero offset, `voice` and `ducked`.
 */
export function timelineText(report: TimelineReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.width}x${report.height} @ ${report.fps} fps, ${report.durationFrames} frames ` +
      `(${report.durationSeconds.toFixed(2)}s)`,
  );

  if (report.scenes.length === 0) {
    lines.push('no scenes');
  }
  for (const scene of report.scenes) {
    lines.push(
      `#${String(scene.index).padEnd(3)} ${scene.name.padEnd(28)} ` +
        `frames ${`${scene.startFrame}..${scene.endFrame}`.padStart(14)} ` +
        `${`${scene.startSeconds.toFixed(2)}s..${scene.endSeconds.toFixed(2)}s`.padStart(18)}`,
    );
  }

  for (const track of report.audio.tracks) {
    const extra: string[] = [];
    if (track.gainDb !== 0) {
      extra.push(`${track.gainDb >= 0 ? '+' : ''}${track.gainDb.toFixed(1)} dB`);
    }
    if (track.pan !== 0) {
      extra.push(`pan ${track.pan >= 0 ? '+' : ''}${track.pan.toFixed(2)}`);
    }
    if (track.fadeIn > 0 || track.fadeOut > 0) {
      extra.push(`fades ${track.fadeIn.toFixed(2)}s/${track.fadeOut.toFixed(2)}s`);
    }
    if (track.offsetSeconds > 0) {
      extra.push(`from ${track.offsetSeconds.toFixed(2)}s of the file`);
    }
    if (track.voice) {
      extra.push('voice');
    }
    if (track.ducking !== null) {
      extra.push('ducked');
    }
    // Rust prints the range right after the padded name, with a space separating the two columns
    // (`cli.rs:858-865`); the extra notes follow, comma separated.
    lines.push(
      `audio ${track.file.padEnd(28)} ` +
        `${`${track.startSeconds.toFixed(3)}s..${track.endSeconds.toFixed(3)}s`.padStart(20)} ` +
        extra.join(', '),
    );
  }

  return lines.join('\n').trimEnd();
}

/**
 * The `timeline` command.
 *
 * Nothing is rasterized and nothing is decoded, so it cannot fail: the report is built from the
 * resolved timeline and the resolved audio map alone. That is also why it is the cheapest way to
 * see whether a video is set up the way you meant.
 */
export function timelineCommand(session: RenderSession, options: { json: boolean; io: CliIo }): number {
  const report = timelineReport(session);
  printReport(options.io, options.json, report, () => timelineText(report));
  return 0;
}
