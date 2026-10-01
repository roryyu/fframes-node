/**
 * The frame being rendered.
 *
 * Port of `.source/fframes/fframes/src/frame.rs`. A `Frame` carries the temporal information of
 * the current frame; `index` is relative to the current scene while `globalIndex` always refers
 * to the whole video.
 */

import type { Animatable, KeyFramesAnimation } from './animation/timeline.ts';
import { applyProgress } from './animation/timeline.ts';
import type { EasingLike } from './animation/easing.ts';
import type { VisualizeFrameInput } from './types.ts';

/**
 * Computes the magnitude spectrum of `input.audio` for the frame at `frameIndex`.
 *
 * The FFT and the window functions are implemented in `audio/visualize.ts` (it owns them and the
 * `AudioFrameVisualizer` output format), so `core/frame.ts` receives them through
 * {@link setVisualizationResolver} instead of importing the module: that keeps this file free of a
 * hard dependency on the audio layer and leaves a single implementation of the transform.
 */
export type VisualizationResolver = (
  frameIndex: number,
  fps: number,
  input: VisualizeFrameInput,
) => Float32Array;

let visualizationResolver: VisualizationResolver | null = null;

/**
 * Installs the per-frame spectrum provider used by {@link Frame.visualizeAudioFrame}.
 * `audio/visualize.ts` calls this once at import time; pass `null` to uninstall it.
 */
export function setVisualizationResolver(resolver: VisualizationResolver | null): void {
  visualizationResolver = resolver;
}

/** The currently installed spectrum provider, or `null`. */
export function getVisualizationResolver(): VisualizationResolver | null {
  return visualizationResolver;
}

function requireVisualizationResolver(): VisualizationResolver {
  if (visualizationResolver === null) {
    throw new Error(
      'Frame.visualizeAudioFrame: no spectrum provider installed. Import audio/visualize.ts (it registers itself) before rendering audio visualisations.',
    );
  }
  return visualizationResolver;
}

export class Frame {
  /**
   * The frame index of the current scene. When rendering a scene it is relative to the scene
   * start, so `index < SceneInfo.durationInFrames`.
   */
  readonly index: number;
  /**
   * The frame index without the scene offset. When passed to a `Video` it always equals `index`.
   */
  readonly globalIndex: number;
  /** FPS of the video. */
  readonly fps: number;

  constructor(index: number, globalIndex: number, fps: number) {
    this.index = index;
    this.globalIndex = globalIndex;
    this.fps = fps;
  }

  /** `Frame::clone_with_scene_offset` — subtracts the scene start from the relative index. */
  static cloneWithSceneOffset(frame: Frame, offset: number): Frame {
    return new Frame(frame.index - offset, frame.globalIndex, frame.fps);
  }

  /** `Frame::into_global` — the global index in place of the relative one. */
  intoGlobal(): Frame {
    return new Frame(this.globalIndex, this.globalIndex, this.fps);
  }

  /** `Frame::seconds()` — the current frame timestamp in seconds. */
  seconds(): number {
    return this.frameToSecond(this.index);
  }

  /** `Frame::frame_to_second` */
  frameToSecond(frame: number): number {
    return frame / this.fps;
  }

  /** `Frame::second_to_frame` — truncates like the Rust `as usize` cast. */
  secondToFrame(second: number): number {
    return Math.trunc(second * this.fps);
  }

  /**
   * `Frame::animate` — the value of a timeline at the current frame.
   *
   * ```ts
   * const x = frame.animate(timeline(
   *   { start: 0, from: 0, to: 100, easing: Easing.easeOut },
   *   { start: 2, from: 100, to: 0, easing: Easing.linear },
   * ));
   * ```
   */
  animate<T extends Animatable>(animation: KeyFramesAnimation<T>): T {
    return animation.get(this.seconds());
  }

  /**
   * `Frame::animate_loop` — like {@link Frame.animate} but the time wraps around the total
   * duration of the animation.
   */
  animateLoop<T extends Animatable>(animation: KeyFramesAnimation<T>): T {
    return animation.getLoop(this.seconds());
  }

  /**
   * `Frame::animate_runtime` — a one-off tween built from the current frame, with the start,
   * `from`, `to` and duration decided at runtime.
   *
   * Before `onSecond` the `from` value is returned, after `onSecond + duration` the `to` value.
   *
   * The progress handed to the easing is normalized to `0..1`, so a spring (whose `solve` expects
   * the absolute elapsed time and infers its own duration) belongs in a {@link timeline} instead.
   */
  animateRuntime<T extends Animatable>(input: {
    readonly onSecond: number;
    readonly from: T;
    readonly to: T;
    readonly duration: number;
    readonly easing: EasingLike;
  }): T {
    const second = this.seconds();
    if (second < input.onSecond) {
      return input.from;
    }
    if (second > input.onSecond + input.duration) {
      return input.to;
    }
    const progress = input.easing.solve((second - input.onSecond) / input.duration);
    return applyProgress(input.from, input.to, progress);
  }

  /**
   * `Frame::visualize_audio_frame` — the magnitude spectrum of the audio around this frame,
   * smoothed over `smoothLevel` frames on each side.
   *
   * The FFT and the window functions live in `audio/visualize.ts`; this method only implements
   * the temporal smoothing of `frame.rs:212-270`.
   */
  visualizeAudioFrame(input: VisualizeFrameInput): Float32Array {
    const getVisualization = requireVisualizationResolver();

    if (this.index < input.smoothLevel * 2 + 1) {
      return getVisualization(this.index, this.fps, input);
    }

    const frames: Float32Array[] = [];
    for (let i = this.index - input.smoothLevel; i < this.index + input.smoothLevel; i += 1) {
      frames.push(getVisualization(i, this.fps, input));
    }

    const bins = frames[0]?.length ?? 0;
    const out = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin += 1) {
      let sum = 0;
      for (const frame of frames) {
        sum += frame[bin] ?? 0;
      }
      out[bin] = sum / frames.length;
    }
    return out;
  }
}
