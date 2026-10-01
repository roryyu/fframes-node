/**
 * Video duration.
 *
 * Port of `.source/fframes/fframes/src/duration.rs`. A duration is a small tree: literals,
 * `auto`, and the sums / differences produced by {@link addDuration} and {@link subDuration}.
 * `toFrames` resolves the tree against the fps of the video.
 *
 * `Duration::FromVideo` is intentionally missing: video input is out of scope for this port (see
 * PORTING.md).
 */

/**
 * Minimal shape `toFrames` needs from the audio map in order to resolve `auto`.
 *
 * The audio slice owns the real `AudioMap`; it only has to expose a `tracks` array whose entries
 * may carry the frame the track ends on (see DELIVERY.md).
 */
export interface DurationAudioTrackHint {
  /** Last frame occupied by the track on the video timeline. */
  readonly timelineEndFrame?: number;
}

export interface DurationAudioMapHint {
  readonly tracks: readonly DurationAudioTrackHint[];
}

/** `Duration` — the discriminated union replaces the Rust enum. */
export type Duration =
  | { readonly kind: 'seconds'; readonly value: number }
  | { readonly kind: 'frames'; readonly value: number }
  | { readonly kind: 'fromAudio'; readonly file: string }
  | { readonly kind: 'auto' }
  | { readonly kind: 'add'; readonly left: Duration; readonly right: Duration }
  | { readonly kind: 'sub'; readonly left: Duration; readonly right: Duration };

/** `Duration::Seconds` */
export function seconds(value: number): Duration {
  return { kind: 'seconds', value };
}

/** `Duration::Frames` */
export function frames(value: number): Duration {
  return { kind: 'frames', value };
}

/** `Duration::FromAudio` — resolved from the duration of a media file. */
export function fromAudio(file: string): Duration {
  return { kind: 'fromAudio', file };
}

/**
 * `Duration::Auto` — inferred from the scenes, or from the audio map.
 *
 * A Rust unit variant is a value, not a constructor call, so `auto` is a constant: the contract
 * spells the public API `duration(): Duration { return auto }`. Every variant of the union is
 * immutable, so sharing this literal is indistinguishable from building `{ kind: 'auto' }` again.
 */
export const auto: Duration = { kind: 'auto' };

/** `impl Add for Duration` */
export function addDuration(left: Duration, right: Duration): Duration {
  return { kind: 'add', left, right };
}

/** `impl Sub for Duration` */
export function subDuration(left: Duration, right: Duration): Duration {
  return { kind: 'sub', left, right };
}

/** Resolves the duration of a media file, in seconds. */
export type ResolveAudioDuration = (file: string) => number | null | undefined;

export interface ToFramesOptions {
  /** Needed to resolve `auto` and `fromAudio`. */
  readonly resolveAudioDuration?: ResolveAudioDuration;
  /** Needed to resolve `auto` when there are no scenes. */
  readonly audioMap?: DurationAudioMapHint;
  /** Scene durations in frames, used by `auto`. Normally `Scenes.resolveTimeline`. */
  readonly scenesDurationInFrames?: number;
}

/**
 * `seconds_to_frames_floor` — tolerant to floating point error, so `0.99999` frames of a whole
 * second still count as a whole frame.
 */
export function secondsToFramesFloor(value: number, fps: number): number {
  return Math.floor(Math.max(0, value) * fps + 1e-6);
}

function requireResolveAudioDuration(options: ToFramesOptions): ResolveAudioDuration {
  const resolve = options.resolveAudioDuration;
  if (resolve === undefined) {
    throw new Error(
      'Duration: resolveAudioDuration is required to resolve this duration from an audio file',
    );
  }
  return resolve;
}

/**
 * Audio files this duration is resolved from, mirroring `Duration::used_audio_files`.
 */
export function usedAudioFiles(duration: Duration): string[] {
  switch (duration.kind) {
    case 'fromAudio':
      return [duration.file];
    case 'add':
    case 'sub': {
      const left = usedAudioFiles(duration.left);
      const right = usedAudioFiles(duration.right);
      return [...left, ...right];
    }
    default:
      return [];
  }
}

/**
 * `Duration::to_frames_async` — the duration in frames.
 *
 * - `seconds` truncates `(seconds * fps)`,
 * - `frames` is returned as is,
 * - `fromAudio` floors the probed file duration,
 * - `auto` takes the scene duration, or the last frame of the audio map,
 * - `add` sums and `sub` saturates at zero.
 *
 * Throws when `auto` cannot be resolved from anything.
 */
export function toFrames(duration: Duration, fps: number, options: ToFramesOptions = {}): number {
  switch (duration.kind) {
    case 'seconds':
      return Math.trunc(duration.value * fps);
    case 'frames':
      return duration.value;
    case 'fromAudio': {
      const resolve = requireResolveAudioDuration(options);
      const resolved = resolve(duration.file);
      if (resolved === null || resolved === undefined) {
        throw new Error(`Duration: can not resolve the duration of "${duration.file}"`);
      }
      return secondsToFramesFloor(resolved, fps);
    }
    case 'auto': {
      const scenes = options.scenesDurationInFrames;
      if (scenes !== undefined && scenes > 0) {
        return scenes;
      }

      const audioMap = options.audioMap;
      if (audioMap !== undefined) {
        const tracks = audioMap.tracks;
        if (tracks.length > 0) {
          let maxEnd = 0;
          for (const track of tracks) {
            const end = track.timelineEndFrame;
            if (end !== undefined && end > maxEnd) {
              maxEnd = end;
            }
          }
          if (maxEnd > 0) {
            return maxEnd;
          }
        }
      }

      throw new Error('Duration: auto requires either scenes or an audio map to infer the length');
    }
    case 'add':
      return toFrames(duration.left, fps, options) + toFrames(duration.right, fps, options);
    case 'sub': {
      const left = toFrames(duration.left, fps, options);
      const right = toFrames(duration.right, fps, options);
      return Math.max(0, left - right);
    }
  }
}
