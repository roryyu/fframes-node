/**
 * The audio map: which files play, where on the timeline, and how they are mixed.
 *
 * Port of `.source/fframes/fframes/src/audio_map.rs`. A `Video.audio()` returns an {@link AudioMap}
 * of {@link AudioTrack}s; {@link resolve} turns it into {@link ResolvedAudioTrack}s whose ranges
 * are **sample** indexes on the output timeline, which is what the mixer places exactly.
 *
 * The Rust `AudioTimestamp` tree (`Eof`, `Frame`, `Second`, `Time`, `DurationOfAudio`, `+`, `-`)
 * is reduced here to the contract's {@link AudioDuration}: `start`/`end` in seconds inside the
 * file, where a missing `end` means `Eof` ("until the end of the file, minus the offset").
 */

import { secondsToFramesFloor } from '../core/duration.ts';

/**
 * `FadeCurve` — the shape of a fade.
 *
 * - `linear` — amplitude changes linearly, good for very short de-click fades,
 * - `equalPower` — `sin(t * PI / 2)`, constant power, the default,
 * - `sCurve` — raised cosine, gentle start and end,
 * - `exponential` — linear in decibels (-60 dB to 0 dB), for long music fade outs.
 */
export type FadeCurve = 'linear' | 'equalPower' | 'sCurve' | 'exponential';

/** `FadeCurve::default()` — `EqualPower`. */
export const DEFAULT_FADE_CURVE: FadeCurve = 'equalPower';

/** Every fade curve, in declaration order. */
export const FADE_CURVES: readonly FadeCurve[] = ['linear', 'equalPower', 'sCurve', 'exponential'];

/**
 * `FadeCurve::gain` — the gain for the fade progress `t` in `0..=1` (0 silent, 1 full level).
 *
 * The Rust port clamps `t` before the match; so does this one.
 */
export function fadeCurveGain(curve: FadeCurve, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  switch (curve) {
    case 'linear':
      return clamped;
    case 'equalPower':
      return Math.sin((clamped * Math.PI) / 2);
    case 'sCurve':
      return (1 - Math.cos(clamped * Math.PI)) * 0.5;
    case 'exponential':
      return clamped <= 0 ? 0 : 10 ** (-60 * (1 - clamped) / 20);
  }
}

/**
 * `Ducking` — lowers a track while voice tracks play.
 *
 * Driven by the timeline, not by the signal: the level drops before the voice starts and comes
 * back after it ends. Every field is optional; {@link resolveDucking} fills in
 * {@link DEFAULT_DUCKING}.
 */
export interface Ducking {
  /** Attenuation while a voice plays, e.g. `-12`. */
  readonly depthDb?: number;
  /** Seconds before the voice starts over which the level goes down. */
  readonly attack?: number;
  /** Seconds the level stays down after the voice ends. */
  readonly hold?: number;
  /** Seconds over which the level comes back. */
  readonly release?: number;
  /** Voice ranges closer than this (seconds) are merged so the music does not pump. */
  readonly mergeGap?: number;
}

/** A {@link Ducking} with every field filled in. */
export type ResolvedDucking = Required<Ducking>;

/** `Ducking::default()` */
export const DEFAULT_DUCKING: ResolvedDucking = {
  depthDb: -12,
  attack: 0.2,
  hold: 0.3,
  release: 0.8,
  mergeGap: 0.8,
};

/** Fills the missing fields of a partial ducking with {@link DEFAULT_DUCKING}. */
export function resolveDucking(input: Ducking | null | undefined): ResolvedDucking {
  return {
    depthDb: input?.depthDb ?? DEFAULT_DUCKING.depthDb,
    attack: input?.attack ?? DEFAULT_DUCKING.attack,
    hold: input?.hold ?? DEFAULT_DUCKING.hold,
    release: input?.release ?? DEFAULT_DUCKING.release,
    mergeGap: input?.mergeGap ?? DEFAULT_DUCKING.mergeGap,
  };
}

/**
 * `TrackMix` — how a track is mixed. Everything defaults to "play the file as is".
 *
 * The field names mirror `TrackMix` (`gain_db`, `fade_in`, …) in camel case.
 */
export interface TrackMix {
  /** Level in decibels, `0` is the file's level. */
  readonly gainDb: number;
  /** `-1` left .. `1` right. Mono files are centered at unity gain. */
  readonly pan: number;
  /** Seconds. */
  readonly fadeIn: number;
  /** Seconds, ending at the end of the track's range. */
  readonly fadeOut: number;
  readonly fadeCurve: FadeCurve;
  /** Seconds of the file skipped before the track starts playing. */
  readonly offset: number;
  /** Duck this track under voice tracks. */
  readonly duck: ResolvedDucking | null;
  /** This track is a voice: other tracks with `duck` get quieter while it plays. */
  readonly voice: boolean;
}

/** `TrackMix::default()` */
export const DEFAULT_TRACK_MIX: TrackMix = {
  gainDb: 0,
  pan: 0,
  fadeIn: 0,
  fadeOut: 0,
  fadeCurve: DEFAULT_FADE_CURVE,
  offset: 0,
  duck: null,
  voice: false,
};

/**
 * `AudioDuration` — the part of the file a track plays, in **seconds inside the file**.
 *
 * A missing `start` means `0`; a missing `end` means `Eof` ("to the end of the file", minus the
 * track's {@link TrackMix.offset}).
 */
export interface AudioDuration {
  readonly start?: number;
  readonly end?: number;
}

/** A half-open range, used by the resolved map. */
export interface AudioRange {
  readonly start: number;
  readonly end: number;
}

/**
 * `AudioTrack` — one audio file placed on the timeline, with its mix settings.
 *
 * ```ts
 * import { AudioMap, audioTrack } from './src/index.ts';
 *
 * AudioMap.of([
 *   audioTrack('music.mp3').gainDb(-14).fadeOut(2).duckUnderVoice(),
 *   audioTrack('voice.wav', { start: 1.5 }).voice(),
 *   audioTrack('whoosh.wav', { start: 4.25 }).pan(-0.5),
 * ]);
 * ```
 *
 * Every builder method returns a new track, so a configured track can be shared.
 */
export class AudioTrack {
  /** The media directory name of the file. */
  readonly file: string;
  /** The part of the file this track plays. */
  readonly range: AudioDuration;
  /** The mix settings, read them directly or use the builders. */
  readonly mix: TrackMix;

  constructor(file: string, range: AudioDuration = {}, mix: TrackMix = DEFAULT_TRACK_MIX) {
    this.file = file;
    this.range = range;
    this.mix = mix;
  }

  private withMix(patch: Partial<TrackMix>): AudioTrack {
    return new AudioTrack(this.file, this.range, { ...this.mix, ...patch });
  }

  /** `AudioTrack::gain_db` — level in decibels. */
  gainDb(gainDb: number): AudioTrack {
    return this.withMix({ gainDb });
  }

  /** `AudioTrack::volume` — linear level, `0.5` is about -6 dB. */
  volume(volume: number): AudioTrack {
    return this.gainDb(20 * Math.log10(Math.max(volume, 1e-6)));
  }

  /** `AudioTrack::pan` — `-1` left .. `1` right, clamped like the Rust builder. */
  pan(pan: number): AudioTrack {
    return this.withMix({ pan: Math.min(1, Math.max(-1, pan)) });
  }

  /** `AudioTrack::fade_in` — seconds, clamped at zero. */
  fadeIn(seconds: number): AudioTrack {
    return this.withMix({ fadeIn: Math.max(0, seconds) });
  }

  /** `AudioTrack::fade_out` — seconds, ending at the end of the range, clamped at zero. */
  fadeOut(seconds: number): AudioTrack {
    return this.withMix({ fadeOut: Math.max(0, seconds) });
  }

  /** `AudioTrack::fade_curve` */
  fadeCurve(curve: FadeCurve): AudioTrack {
    return this.withMix({ fadeCurve: curve });
  }

  /** `AudioTrack::offset` — starts playing the file `seconds` into it, clamped at zero. */
  offset(seconds: number): AudioTrack {
    return this.withMix({ offset: Math.max(0, seconds) });
  }

  /** `AudioTrack::voice` — ducks tracks created with {@link AudioTrack.duckUnderVoice}. */
  voice(): AudioTrack {
    return this.withMix({ voice: true });
  }

  /** `AudioTrack::duck_under_voice` — lowers this track by 12 dB while voice tracks play. */
  duckUnderVoice(): AudioTrack {
    return this.duck(DEFAULT_DUCKING);
  }

  /** `AudioTrack::duck` */
  duck(ducking: Ducking): AudioTrack {
    return this.withMix({ duck: resolveDucking(ducking) });
  }

  /** The effective level in dB, `TrackMix::gain_db` written back from `volume()`. */
  effectiveGainDb(): number {
    return this.mix.gainDb;
  }
}

/** `AudioTrack::new` — a track playing the whole file, built functionally. */
export function audioTrack(file: string, range: AudioDuration = {}): AudioTrack {
  return new AudioTrack(file, range);
}

/** The whole file (`Eof`), the common case. */
export function audioTrackAll(file: string): AudioTrack {
  return new AudioTrack(file, {});
}

/**
 * `AudioMap` — when and how long each audio file plays within a video or a scene.
 *
 * A scene's map is always relative to the scene timestamp, which is resolved from
 * `Video.defineScenes()`.
 *
 * ```ts
 * class Demo implements Video {
 *   audio(): AudioMap { return AudioMap.of([audioTrack('sine.wav').gainDb(-6)]) }
 * }
 * ```
 */
export class AudioMap {
  /** The tracks, or `null` for {@link AudioMap.none}. */
  readonly tracks: readonly AudioTrack[] | null;

  constructor(tracks: readonly AudioTrack[] | null) {
    this.tracks = tracks;
  }

  /**
   * `AudioMap::none` — no audio files will be played. A video whose duration is
   * `fromAudio(...)` or whose scenes are missing can not be rendered from an empty map.
   */
  static none(): AudioMap {
    return new AudioMap(null);
  }

  /** `AudioMap::from([...])` — the tracks of the video. */
  static of(tracks: Iterable<AudioTrack> | null | undefined): AudioMap {
    if (tracks === null || tracks === undefined) {
      return AudioMap.none();
    }
    return new AudioMap([...tracks]);
  }

  /** Whether this is {@link AudioMap.none}. */
  isNone(): boolean {
    return this.tracks === null;
  }

  /** Whether any track plays. */
  isEmpty(): boolean {
    return this.tracks === null || this.tracks.length === 0;
  }

  /** The file names of every track. */
  trackNames(): string[] {
    return this.tracks === null ? [] : [...new Set(this.tracks.map((track) => track.file))];
  }

  /**
   * `AudioMap::used_audio_files` — the files whose range ends at `Eof`, so the ones a duration
   * has to be probed for. `null` when the map is {@link AudioMap.none}.
   */
  usedAudioFiles(): string[] | null {
    if (this.tracks === null) {
      return null;
    }
    const used: string[] = [];
    for (const track of this.tracks) {
      if (track.range.end === undefined && !used.includes(track.file)) {
        used.push(track.file);
      }
    }
    return used;
  }

  /** `AudioMap::unstable_flatten_with_scenes` — the video tracks plus the scene tracks. */
  flattenWithScenes(sceneMaps: Iterable<AudioMap>): AudioMap {
    if (this.tracks === null) {
      const collected = [...sceneMaps];
      if (collected.every((map) => map.isNone())) {
        return AudioMap.none();
      }
      return AudioMap.of(collected.flatMap((map) => map.tracks ?? []));
    }
    const extra = [...sceneMaps].flatMap((map) => map.tracks ?? []);
    return AudioMap.of([...this.tracks, ...extra]);
  }
}

/** A track with its position on the timeline resolved. */
export interface ResolvedAudioTrack {
  readonly file: string;
  /** The occupied part of the timeline, in samples (or frames, see {@link resolveAudioFrames}). */
  readonly range: AudioRange;
  readonly mix: TrackMix;
  /** Last frame occupied on the video timeline — the input of `Duration::Auto`. */
  readonly timelineEndFrame: number;
}

/** `ResolvedAudioMap` — the resolved `AudioMap` in samples. */
export class ResolvedAudioMap {
  /** The resolved tracks, in declaration order. */
  readonly tracks: readonly ResolvedAudioTrack[];

  constructor(tracks: readonly ResolvedAudioTrack[]) {
    this.tracks = tracks;
  }

  /** `ResolvedAudioMap::calc_stream_duration` — the last occupied sample, or 0. */
  calcStreamDuration(): number {
    let max = 0;
    for (const track of this.tracks) {
      if (track.range.end > max) max = track.range.end;
    }
    return max;
  }

  /**
   * `ResolvedAudioMap::round_max_duration` — clamps every range to `maxDuration` and drops the
   * tracks that start at or after it (they are not played at all).
   */
  roundMaxDuration(maxDuration: number): ResolvedAudioMap {
    const kept: ResolvedAudioTrack[] = [];
    for (const track of this.tracks) {
      if (track.range.start >= maxDuration) continue;
      const end = Math.min(track.range.end, maxDuration);
      kept.push({ ...track, range: { start: track.range.start, end } });
    }
    return new ResolvedAudioMap(kept);
  }
}

/** The time base the map is resolved against — `crate::TimeBase`. */
export interface AudioTimeBase {
  readonly fps: number;
  readonly sampleRate: number;
}

/** A scene's audio map, placed at the scene's start frame. */
export interface SceneAudio {
  readonly startFrame: number;
  readonly map: AudioMap;
}

export interface ResolveAudioOptions {
  /** `crate::TimeBase`; `sampleRate` defaults to 44100. */
  readonly fps: number;
  readonly sampleRate?: number;
  /** Duration of a file in seconds. Needed when a range ends at `Eof`. */
  readonly resolveAudioDuration?: (file: string) => number | null | undefined;
  /** Extra scene audio, resolved relative to each scene's start frame. */
  readonly sceneAudio?: readonly SceneAudio[];
}

interface ResolvedInSamples {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly mix: TrackMix;
}

/** `AudioTimelineSamples::from_seconds` — `round(max(0, seconds) * sample_rate)`. */
export function samplesFromSeconds(seconds: number, sampleRate: number): number {
  return Math.round(Math.max(0, seconds) * sampleRate);
}

/** `AudioTimelineSamples::to_seconds` */
export function secondsFromSamples(samples: number, sampleRate: number): number {
  return samples / sampleRate;
}

/** `AudioTimelineSamples::to_frames` — `samples * fps / sample_rate`, integer division. */
export function samplesToFrames(samples: number, timeBase: AudioTimeBase): number {
  return Math.trunc((samples * timeBase.fps) / timeBase.sampleRate);
}

/** `AudioTimelineFrames::from_seconds` — `seconds_to_frames_floor`. */
export function framesFromSeconds(seconds: number, fps: number): number {
  return secondsToFramesFloor(seconds, fps);
}

function requireDuration(
  file: string,
  resolve: ((file: string) => number | null | undefined) | undefined,
): number {
  const duration = resolve?.(file);
  if (duration === null || duration === undefined || !Number.isFinite(duration)) {
    throw new Error(`AudioMap: can not resolve the duration of "${file}"`);
  }
  return duration;
}

/**
 * The seconds a track's range end means.
 *
 * `eof_base` is the start of the range minus the offset, so `Second(10)..Eof` with
 * `offset(1)` plays the file from second 11 to its end (`audio_map.rs:142-169`).
 */
function endSeconds(
  track: AudioTrack,
  eofBase: number,
  resolve: ((file: string) => number | null | undefined) | undefined,
): number {
  if (track.range.end === undefined) {
    return requireDuration(track.file, resolve) + eofBase;
  }
  return Math.max(0, track.range.end);
}

function trackSeconds(
  track: AudioTrack,
  resolve: ((file: string) => number | null | undefined) | undefined,
): ResolvedInSamples | null {
  const start = Math.max(0, track.range.start ?? 0);
  const eofBase = start - track.mix.offset;
  const end = endSeconds(track, eofBase, resolve);
  if (end <= start) {
    return null;
  }
  return { file: track.file, start, end, mix: track.mix };
}

/**
 * `AudioMap::resolve` — the sample ranges of every track on the output timeline.
 *
 * Sample accuracy is the point: `offset(4.25)` at 44100 Hz starts at sample `187425`, not at a
 * frame boundary and not at a whole second.
 *
 * ```ts
 * const resolved = resolve(AudioMap.of([audioTrack('a.wav', { start: 4.25 })]), {
 *   fps: 30,
 *   sampleRate: 44100,
 *   resolveAudioDuration: (file) => 10,
 * });
 * resolved[0].range.start; // 187425
 * ```
 */
export function resolve(map: AudioMap, options: ResolveAudioOptions): ResolvedAudioTrack[] {
  const sampleRate = options.sampleRate ?? 44100;
  const timeBase: AudioTimeBase = { fps: options.fps, sampleRate };
  const resolveDuration = options.resolveAudioDuration;

  const inSamples: ResolvedInSamples[] = [];
  for (const track of map.tracks ?? []) {
    const seconds = trackSeconds(track, resolveDuration);
    if (seconds !== null) {
      inSamples.push(seconds);
    }
  }

  for (const scene of options.sceneAudio ?? []) {
    const offsetSeconds = scene.startFrame / options.fps;
    for (const track of scene.map.tracks ?? []) {
      const seconds = trackSeconds(track, resolveDuration);
      if (seconds === null) continue;
      inSamples.push({
        file: seconds.file,
        start: seconds.start + offsetSeconds,
        end: seconds.end + offsetSeconds,
        mix: seconds.mix,
      });
    }
  }

  return inSamples.map((entry) => {
    const startSample = samplesFromSeconds(entry.start, sampleRate);
    const endSample = samplesFromSeconds(Math.max(entry.end, entry.start), sampleRate);
    return {
      file: entry.file,
      range: { start: startSample, end: endSample },
      mix: entry.mix,
      timelineEndFrame: samplesToFrames(endSample, timeBase),
    };
  });
}

/** {@link resolve} wrapped in a {@link ResolvedAudioMap}. */
export function resolveAudioMap(map: AudioMap, options: ResolveAudioOptions): ResolvedAudioMap {
  return new ResolvedAudioMap(resolve(map, options));
}

/**
 * `AudioMap::resolve` with `AudioTimelineFrames` — the same map in whole frames, for the
 * `timeline` report and for scene placement.
 */
export function resolveAudioFrames(map: AudioMap, options: ResolveAudioOptions): ResolvedAudioTrack[] {
  const sampleRate = options.sampleRate ?? 44100;
  const inSamples = resolve(map, { ...options, sampleRate });
  return inSamples.map((track) => {
    const startFrame = secondsToFramesFloor(
      secondsFromSamples(track.range.start, sampleRate),
      options.fps,
    );
    const endFrame = secondsToFramesFloor(
      secondsFromSamples(track.range.end, sampleRate),
      options.fps,
    );
    return {
      file: track.file,
      range: { start: startFrame, end: Math.max(startFrame, endFrame) },
      mix: track.mix,
      timelineEndFrame: Math.max(startFrame, endFrame),
    };
  });
}
