/**
 * Keyframe timeline.
 *
 * Port of `KeyFramesAnimation` / `KeyFrame` / `AnimationRuntime` of
 * `.source/fframes/fframes/src/animation/animation.rs`. The construction in
 * {@link KeyFramesAnimation.constructor} mirrors `KeyFramesAnimation::new` line by line: keyframes
 * are sorted by start time, every gap between two tweens is filled with a static tween, a tween
 * before the first keyframe holds its `from` value, and the total duration comes from the last
 * keyframe (`end ?? start`) minus the first `start`.
 */

import type { CssEasing, CubicBezierEasing, EasingLike, SpringEasing } from './easing.ts';
import { CubicBezierRuntime } from './cubic-bezier.ts';
import { SpringRuntime } from './spring.ts';
import { Color } from '../color.ts';
import { Transform } from '../transform.ts';

/** Values that a keyframe timeline can interpolate. */
export type Animatable = number | Color | Transform;

/**
 * `from.apply_progress(&to, progress)` for the supported value types.
 */
export function applyProgress<T extends Animatable>(from: T, to: T, progress: number): T {
  if (typeof from === 'number' && typeof to === 'number') {
    const start = from as number;
    const end = to as number;
    return (start + (end - start) * progress) as unknown as T;
  }
  if (from instanceof Color && to instanceof Color) {
    return from.interpolate(to, progress) as unknown as T;
  }
  if (from instanceof Transform && to instanceof Transform) {
    return from.interpolate(to, progress) as unknown as T;
  }
  throw new TypeError('timeline: from and to must be of the same animatable type');
}

/**
 * `AnimationRuntime` — an easing bound to a concrete tween duration.
 *
 * - `static` always solves to `0`, which holds the tween's `from` value (used to fill the gaps
 *   between keyframes),
 * - `linear` divides by the duration,
 * - `spring` solves the spring directly with the absolute elapsed time,
 * - `cubicBezier` divides by the duration first, since the bezier curve is parameterized by the
 *   normalized progress.
 */
export type AnimationRuntime =
  | { readonly kind: 'static'; readonly duration: number }
  | { readonly kind: 'linear'; readonly duration: number }
  | { readonly kind: 'spring'; readonly spring: SpringRuntime; readonly duration: number }
  | {
      readonly kind: 'cubicBezier';
      readonly cubicBezier: CubicBezierRuntime;
      readonly duration: number;
    };

/** `AnimationRuntime::new(tween_duration, easing)` */
export function animationRuntimeFor(tweenDuration: number, easing: EasingLike): AnimationRuntime {
  if (easing.kind === 'spring') {
    const spring = (easing as SpringEasing).runtime;
    return { kind: 'spring', spring, duration: Math.min(spring.getDuration(), tweenDuration) };
  }
  if (easing.kind === 'linear') {
    return { kind: 'linear', duration: tweenDuration };
  }
  const runtime = (easing as CssEasing | CubicBezierEasing).runtime;
  return { kind: 'cubicBezier', cubicBezier: runtime, duration: tweenDuration };
}

/** `AnimationRuntime::get_duration` */
export function animationRuntimeDuration(runtime: AnimationRuntime): number {
  return runtime.duration;
}

/** `AnimationRuntime::solve` */
export function solveAnimationRuntime(runtime: AnimationRuntime, t: number): number {
  switch (runtime.kind) {
    case 'static':
      return 0;
    case 'linear':
      return t / runtime.duration;
    case 'spring':
      return runtime.spring.solve(t);
    case 'cubicBezier':
      return runtime.cubicBezier.solve(t / runtime.duration);
  }
}

/** One tween of the resolved timeline. */
export interface Tween<T extends Animatable> {
  /** Start of the tween, in seconds. */
  readonly start: number;
  /** End of the tween, in seconds. */
  readonly end: number;
  readonly from: T;
  readonly to: T;
  readonly runtime: AnimationRuntime;
}

/** `KeyFrame` — the user facing description of a single tween. */
export interface KeyFrame<T extends Animatable> {
  /** Start time of the keyframe, in seconds. */
  readonly start: number;
  /**
   * End time of the keyframe, in seconds. When present it is the easing duration; the time
   * before the next keyframe then holds the value as a static one.
   */
  readonly end?: number;
  readonly from: T;
  readonly to: T;
  readonly easing: EasingLike;
}

const DEFAULT_FALLBACK: Animatable = 0;

export class KeyFramesAnimation<T extends Animatable> {
  /** The resolved, gap-filled tweens, sorted by start time. */
  readonly tweens: readonly Tween<T>[];
  /** `KeyFramesAnimation::total_duration` */
  readonly totalDuration: number;
  /** `KeyFramesAnimation::final_value` */
  readonly finalValue: T;

  constructor(keyframes: readonly KeyFrame<T>[]) {
    if (keyframes.length === 0) {
      // Undefined behaviour in the Rust version as well (it logs a warning and uses
      // `T::default()`); there is no type information here, so the numeric zero is used.
      this.tweens = [];
      this.totalDuration = 0;
      this.finalValue = DEFAULT_FALLBACK as unknown as T;
      return;
    }

    const sorted = [...keyframes].sort((a, b) => a.start - b.start);
    const tweens: Tween<T>[] = [];

    for (let i = 0; i < sorted.length; i += 1) {
      const keyframe = sorted[i] as KeyFrame<T>;
      const next = sorted[i + 1];

      let tweenDuration: number;
      if (keyframe.end !== undefined) {
        tweenDuration = keyframe.end - keyframe.start;
      } else if (next !== undefined) {
        tweenDuration = next.start - keyframe.start;
      } else if (keyframe.easing.kind === 'spring') {
        // A spring infers its own duration from its physics.
        tweenDuration = Number.MAX_VALUE;
      } else {
        // A last keyframe with neither an end nor a spring easing is skipped.
        continue;
      }

      const runtime = animationRuntimeFor(tweenDuration, keyframe.easing);
      const tweenEnd = keyframe.start + runtime.duration;
      const tween: Tween<T> = {
        start: keyframe.start,
        end: tweenEnd,
        from: keyframe.from,
        to: keyframe.to,
        runtime,
      };

      if (next === undefined || next.start <= tweenEnd) {
        tweens.push(tween);
        continue;
      }

      // Fill the gap between the end of this tween and the next keyframe with a static tween.
      tweens.push(tween);
      tweens.push({
        start: tweenEnd,
        end: next.start,
        from: keyframe.to,
        to: keyframe.to,
        runtime: { kind: 'static', duration: next.start - tweenEnd },
      });
    }

    if ((sorted[0] as KeyFrame<T>).start > 0) {
      // Hold the first `from` value until the first keyframe starts.
      const firstStart = (sorted[0] as KeyFrame<T>).start;
      tweens.unshift({
        start: 0,
        end: firstStart,
        from: (sorted[0] as KeyFrame<T>).from,
        to: (sorted[0] as KeyFrame<T>).from,
        runtime: { kind: 'static', duration: firstStart },
      });
    }

    this.tweens = tweens;
    const last = sorted[sorted.length - 1] as KeyFrame<T>;
    this.totalDuration = (last.end ?? last.start) - (sorted[0] as KeyFrame<T>).start;
    this.finalValue = last.to;
  }

  /**
   * `Frame::animate_impl` — the value at `t` seconds.
   *
   * Before the first keyframe the `from` value is returned, between keyframes the easing drives
   * the interpolation, the gaps hold the previous value and past the end of the timeline the
   * final value is returned.
   */
  get(t: number): T {
    const tween = this.tweens.find((candidate) => t >= candidate.start && t < candidate.end);

    if (tween === undefined) {
      return this.finalValue;
    }

    const progress = solveAnimationRuntime(tween.runtime, t - tween.start);
    return applyProgress(tween.from, tween.to, progress);
  }

  /**
   * `Frame::animate_loop` — the value at `t` seconds, wrapped around the total duration.
   */
  getLoop(t: number): T {
    if (this.totalDuration <= 0) {
      return this.finalValue;
    }
    return this.get(t % this.totalDuration);
  }
}

/**
 * `timeline!` — builds a keyframe animation.
 *
 * ```ts
 * const slide = timeline<Transform>(
 *   { start: 0, from: Transform.translate(0, 80), to: Transform.translate(0, 0), easing: Easing.spring({ mass: 1, stiffness: 300, damping: 26 }) },
 *   { start: 2.2, end: 2.8, from: Transform.translate(0, 0), to: Transform.translate(0, -80), easing: Easing.easeIn },
 * );
 * frame.animate(slide);
 * ```
 */
export function timeline<T extends Animatable>(...keyframes: readonly KeyFrame<T>[]): KeyFramesAnimation<T> {
  return new KeyFramesAnimation<T>(keyframes);
}
