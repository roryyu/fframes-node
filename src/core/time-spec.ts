/**
 * Addressing frames and frame ranges by frame number, time, percentage or scene.
 *
 * Port of `.source/fframes/fframes/src/time_spec.rs`. The syntax table of the Rust module header
 * is reproduced in {@link TimeSpec}:
 *
 * | spec              | meaning                                                      |
 * |-------------------|--------------------------------------------------------------|
 * | `120`, `120f`     | frame 120                                                    |
 * | `3.2s`, `1:05.5`  | a timestamp (`m:ss`, `h:mm:ss` work too)                     |
 * | `50%`             | a fraction of the whole video                                |
 * | `start`, `end`    | the first / last frame of the video                          |
 * | `Intro`           | the first frame of the scene named `Intro` (case-insensitive)|
 * | `#3`              | the first frame of the scene with index 3 (0-based)          |
 * | `Intro[1]`        | the second scene of type `Intro`                             |
 * | `Intro@1.2s`      | 1.2 seconds into the scene (also `@12`, `@50%`, `@end`)      |
 *
 * Ranges are `a..b` (end exclusive), `a..`, `..b`, or a single scene (`Intro`) for the whole
 * scene. A scene name on the right side of `..` means the end of that scene.
 */

import type { ResolvedScene } from './scenes.ts';

/** `TimeSpecError` — the five failure classes of the Rust version. */
export type TimeSpecError =
  | { readonly kind: 'invalid'; readonly spec: string }
  | { readonly kind: 'unknownScene'; readonly query: string; readonly available: readonly string[] }
  | { readonly kind: 'ambiguousScene'; readonly query: string; readonly indexes: readonly number[] }
  | { readonly kind: 'outOfRange'; readonly frame: number; readonly duration: number }
  | { readonly kind: 'emptyRange'; readonly start: number; readonly end: number };

/** Which end of a point is being resolved — `end` means "one past the last frame". */
type Side = 'start' | 'end';

/** A frame range, end exclusive — the same shape as a Rust `Range<usize>`. */
export interface FrameRange {
  /** First frame of the range, inclusive. */
  readonly start: number;
  /** Last frame of the range, exclusive. */
  readonly end: number;
}

/** A scene as seen by the addressing: its name and resolved frames. */
export interface TimelineScene {
  readonly index: number;
  /** Short name, e.g. `Intro` for `my_video::scenes::Intro`. */
  readonly name: string;
  /** Name as returned by `Scene.name`. */
  readonly fullName: string;
  /** First frame of the scene, inclusive. */
  readonly startFrame: number;
  /** Last frame of the scene, exclusive. */
  readonly endFrame: number;
}

/** `my_video::scenes::Intro<'_>` -> `Intro` */
export function shortSceneName(name: string): string {
  const withoutGenerics = name.split('<')[0] ?? name;
  return withoutGenerics.split('::').pop() ?? withoutGenerics;
}

const SYNTAX_HINT =
  'use a frame (120), time (3.2s, 1:05), percentage (50%), scene (Intro, #3, Intro@1.5s) or start/end';

/**
 * `str::parse::<f64>()` — the strict number parse of the Rust side.
 *
 * `Number.parseFloat` is the wrong tool here because it accepts any numeric **prefix**: it turns
 * `12abcs`, `5xx s` and `1..2s` into numbers, so three typos that Rust rejects with `Err` silently
 * resolved to a frame. The grammar below is what `f64::from_str` accepts (an optional sign, digits
 * with at most one dot, an optional exponent) — nothing more.
 */
function parseF64Strict(raw: string): number | undefined {
  const s = raw.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) {
    return undefined;
  }
  const value = Number(s);
  return Number.isNaN(value) ? undefined : value;
}

/** `impl fmt::Display for TimeSpecError` — the message style of the Rust version. */
export function formatTimeSpecError(error: TimeSpecError): string {
  switch (error.kind) {
    case 'invalid':
      return `can not parse "${error.spec}": ${SYNTAX_HINT}`;
    case 'unknownScene': {
      const head = `no scene "${error.query}"`;
      if (error.available.length === 0) {
        return `${head}, the video does not define scenes`;
      }
      return `${head}, available: ${error.available.join(', ')}`;
    }
    case 'ambiguousScene':
      // `{indexes:?}` on a `Vec<usize>` prints `[1, 2]` — Rust's `Debug` for a slice separates with
      // `, `, which `JSON.stringify` does not (`[1,2]`).
      return `"${error.query}" matches scenes [${error.indexes.join(', ')}], use ${error.query}[n] or #index`;
    case 'outOfRange':
      return `frame ${error.frame} is outside the video (0..${error.duration})`;
    case 'emptyRange':
      return `range ${error.start}..${error.end} is empty`;
  }
}

/** A `TimeSpecError` carrying its class, thrown by the resolvers. */
export class TimeSpecResolveError extends Error {
  readonly error: TimeSpecError;

  constructor(error: TimeSpecError) {
    super(formatTimeSpecError(error));
    this.name = 'TimeSpecResolveError';
    this.error = error;
  }

  get kind(): TimeSpecError['kind'] {
    return this.error.kind;
  }
}

/** `TimelineIndex` — everything needed to resolve the time specs of one video. */
export class TimelineIndex {
  readonly fps: number;
  readonly durationInFrames: number;
  readonly scenes: readonly TimelineScene[];

  constructor(
    fps: number,
    durationInFrames: number,
    scenes: readonly TimelineScene[] = [],
  ) {
    this.fps = fps;
    this.durationInFrames = durationInFrames;
    this.scenes = scenes;
  }

  /** Builds an index from the timeline resolved by `Scenes`. */
  static fromScenes(fps: number, durationInFrames: number, scenes: readonly ResolvedScene[]): TimelineIndex {
    return new TimelineIndex(
      fps,
      durationInFrames,
      scenes.map((scene) => ({
        index: scene.index,
        name: scene.name,
        fullName: scene.fullName,
        startFrame: scene.startFrame,
        endFrame: scene.endFrame,
      })),
    );
  }

  /** `TimelineIndex::duration_in_seconds` */
  durationInSeconds(): number {
    return this.durationInFrames / this.fps;
  }

  /** `TimelineIndex::frame_to_seconds` */
  frameToSeconds(frame: number): number {
    return frame / this.fps;
  }

  /** `TimelineIndex::scenes_at` — the scenes visible at a frame. */
  scenesAt(frame: number): TimelineScene[] {
    return this.scenes.filter((scene) => frame >= scene.startFrame && frame < scene.endFrame);
  }

  /** `TimelineIndex::full_range` */
  fullRange(): FrameRange {
    return { start: 0, end: this.durationInFrames };
  }

  private unknownScene(query: string): TimeSpecError {
    return {
      kind: 'unknownScene',
      query,
      available: this.scenes.map((scene) => `#${scene.index} ${scene.name}`),
    };
  }

  /** `TimelineIndex::find_scene` */
  findScene(query: string): TimelineScene {
    if (query.startsWith('#')) {
      const digits = query.slice(1);
      if (!/^\d+$/.test(digits)) {
        throw new TimeSpecResolveError({ kind: 'invalid', spec: query });
      }
      const scene = this.scenes[Number.parseInt(digits, 10)];
      if (scene === undefined) {
        throw new TimeSpecResolveError(this.unknownScene(query));
      }
      return scene;
    }

    let name = query;
    let nth: number | undefined;
    const bracket = query.indexOf('[');
    if (query.endsWith(']') && bracket > 0) {
      name = query.slice(0, bracket);
      const digits = query.slice(bracket + 1, -1);
      if (!/^\d+$/.test(digits)) {
        throw new TimeSpecResolveError({ kind: 'invalid', spec: query });
      }
      nth = Number.parseInt(digits, 10);
    }

    // `intro`, `Intro`, `intro_scene` and `IntroScene` all name the scene `IntroScene`.
    const wanted = normalizeSceneName(name);
    const matches = this.scenes.filter(
      (scene) => normalizeSceneName(scene.name) === wanted || normalizeSceneName(scene.fullName) === wanted,
    );

    if (matches.length === 0) {
      throw new TimeSpecResolveError(this.unknownScene(query));
    }
    if (nth === undefined) {
      if (matches.length === 1) {
        return matches[0] as TimelineScene;
      }
      throw new TimeSpecResolveError({
        kind: 'ambiguousScene',
        query: name,
        indexes: matches.map((scene) => scene.index),
      });
    }
    const scene = matches[nth];
    if (scene === undefined) {
      throw new TimeSpecResolveError(this.unknownScene(query));
    }
    return scene;
  }

  /**
   * `TimelineIndex::resolve_frame` — a single point (`3.2s`, `Intro@50%`, …) to a frame index
   * inside the video.
   */
  resolveFrame(spec: string): number {
    const frame = this.resolvePoint(spec.trim(), 'start');
    if (frame >= this.durationInFrames) {
      throw new TimeSpecResolveError({
        kind: 'outOfRange',
        frame,
        duration: this.durationInFrames,
      });
    }
    return frame;
  }

  /**
   * `TimelineIndex::resolve_range` — a range (`10s..20s`, `Intro`, `Intro..Outro`, `5s..`) to
   * frames, end exclusive, clamped to the video.
   */
  resolveRange(spec: string): FrameRange {
    const trimmed = spec.trim();
    let range: FrameRange;

    const separator = trimmed.indexOf('..');
    if (separator >= 0) {
      const left = trimmed.slice(0, separator).trim();
      const right = trimmed.slice(separator + 2).trim();
      const start = left === '' ? 0 : this.resolvePoint(left, 'start');
      const end = right === '' ? this.durationInFrames : this.resolvePoint(right, 'end');
      range = { start, end };
    } else if (trimmed === 'all' || trimmed === '*') {
      range = this.fullRange();
    } else {
      try {
        const scene = this.findScene(trimmed);
        range = { start: scene.startFrame, end: scene.endFrame };
      } catch (error) {
        if (!(error instanceof TimeSpecResolveError)) {
          throw error;
        }
        // A single point is a one-frame range.
        const frame = this.resolvePoint(trimmed, 'start');
        range = { start: frame, end: frame + 1 };
      }
    }

    const clamped = {
      start: Math.min(range.start, this.durationInFrames),
      end: Math.min(range.end, this.durationInFrames),
    };
    if (clamped.start >= clamped.end) {
      throw new TimeSpecResolveError({ kind: 'emptyRange', start: clamped.start, end: clamped.end });
    }
    return clamped;
  }

  /** `TimelineIndex::resolve_point` */
  private resolvePoint(spec: string, side: Side): number {
    if (spec === 'start') {
      return 0;
    }
    if (spec === 'end') {
      return side === 'start'
        ? Math.max(0, this.durationInFrames - 1)
        : this.durationInFrames;
    }

    const at = spec.indexOf('@');
    if (at >= 0) {
      const scene = this.findScene(spec.slice(0, at).trim());
      const length = scene.endFrame - scene.startFrame;
      const rawOffset = spec.slice(at + 1).trim();
      let offset: number;
      if (rawOffset === 'start') {
        offset = 0;
      } else if (rawOffset === 'end') {
        offset = side === 'start' ? Math.max(0, length - 1) : length;
      } else {
        offset = this.parseOffset(rawOffset, length);
      }
      return scene.startFrame + offset;
    }

    const offset = this.tryParseOffset(spec, this.durationInFrames);
    if (offset !== undefined) {
      return offset;
    }

    let scene: TimelineScene;
    try {
      scene = this.findScene(spec);
    } catch (error) {
      if (
        error instanceof TimeSpecResolveError &&
        error.error.kind === 'unknownScene' &&
        error.error.available.length === 0
      ) {
        // Not a number and not a scene, the most useful message is the syntax.
        throw new TimeSpecResolveError({ kind: 'invalid', spec });
      }
      throw error;
    }

    return side === 'start' ? scene.startFrame : scene.endFrame;
  }

  /** `TimelineIndex::parse_offset` */
  private parseOffset(spec: string, length: number): number {
    const offset = this.tryParseOffset(spec, length);
    if (offset === undefined) {
      throw new TimeSpecResolveError({ kind: 'invalid', spec });
    }
    return offset;
  }

  /** `TimelineIndex::try_parse_offset` — frames, seconds, clock time or a percentage. */
  private tryParseOffset(spec: string, length: number): number | undefined {
    const toFrames = (value: number): number => Math.max(0, Math.round(value * this.fps));

    if (spec.endsWith('%')) {
      const percent = parseF64Strict(spec.slice(0, -1));
      if (percent === undefined) {
        return undefined;
      }
      const frame = Math.floor((length * percent) / 100);
      // 100% is the last frame, not one past it. The lower clamp is Rust's saturating
      // `f64 as usize` (`time_spec.rs:304-306`): a negative percentage lands on frame 0 rather
      // than on a negative frame number that then fails the `start >= end` check.
      return Math.max(0, Math.min(frame, Math.max(0, length - 1)));
    }

    if (spec.endsWith('ms')) {
      const value = parseF64Strict(spec.slice(0, -2));
      if (value === undefined) {
        return undefined;
      }
      return toFrames(value / 1000);
    }

    if (spec.endsWith('s')) {
      const value = parseF64Strict(spec.slice(0, -1));
      if (value === undefined) {
        return undefined;
      }
      return toFrames(value);
    }

    if (spec.includes(':')) {
      let seconds = 0;
      for (const part of spec.split(':')) {
        const value = parseF64Strict(part);
        if (value === undefined) {
          return undefined;
        }
        seconds = seconds * 60 + value;
      }
      return toFrames(seconds);
    }

    const bare = spec.endsWith('f') ? spec.slice(0, -1) : spec;
    const value = Number.parseInt(bare, 10);
    if (Number.isNaN(value) || !/^\d+$/.test(bare)) {
      return undefined;
    }
    return value;
  }
}

/** `intro`, `Intro`, `intro_scene` and `IntroScene` all name the scene `IntroScene`. */
export function normalizeSceneName(name: string): string {
  const stripped = name.replace(/[_\-\s]/g, '').toLowerCase();
  if (stripped.endsWith('scene') && stripped.length > 'scene'.length) {
    return stripped.slice(0, -'scene'.length);
  }
  return stripped;
}

/** Parses a single point spec into a frame number, mirroring `TimelineIndex::resolve_frame`. */
export function parseTimeSpec(spec: string, index: TimelineIndex): number {
  return index.resolveFrame(spec);
}

/**
 * `TimeSpec` — the facade the CLI uses to address frames of a video.
 *
 * ```ts
 * const index = TimeSpec.index(video.fps, durationInFrames, scenes);
 * TimeSpec.resolveRange(index, 'Intro..Outro');
 * ```
 */
export class TimeSpec {
  /** Builds the index a spec is resolved against. */
  static index(
    fps: number,
    durationInFrames: number,
    scenes: readonly TimelineScene[] = [],
  ): TimelineIndex {
    return new TimelineIndex(fps, durationInFrames, scenes);
  }

  /** A single point (`3.2s`, `Intro@50%`, …) to a frame index. */
  static resolveFrame(index: TimelineIndex, spec: string): number {
    return index.resolveFrame(spec);
  }

  /** A range (`10s..20s`, `Intro`, `5s..`) to frames, end exclusive. */
  static resolveRange(index: TimelineIndex, spec: string): FrameRange {
    return index.resolveRange(spec);
  }
}
