/**
 * Easing functions.
 *
 * Port of the `Easing` variants of `.source/fframes/fframes/src/animation/animation.rs`. The Rust
 * type is a tagged union of scalars and tuple/struct payloads; TypeScript gets the same shape
 * through small classes carrying a literal `kind` tag plus a `solve(progress)` method, so
 * `Easing.easeInOut.solve(0.5)` and `solveEasing(Easing.easeInOut, 0.5)` are both available.
 */

import { CubicBezierRuntime } from './cubic-bezier.ts';
import { SpringRuntime, type SpringOptions } from './spring.ts';

export type EasingKind =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'cubicBezier'
  | 'spring';

export type SpringEasingOptions = SpringOptions;

/** Common shape of every easing: a literal `kind` tag and the `solve(progress)` method. */
export interface EasingLike {
  readonly kind: EasingKind;
  /** Eased progress for a linear progress. The result stays in `0..1` except for springs. */
  solve(progress: number): number;
}

/** `Easing::Linear` — same speed from start to end. */
export class LinearEasing implements EasingLike {
  readonly kind = 'linear' as const;

  solve(progress: number): number {
    return progress;
  }
}

/** `Easing::EaseIn` / `EaseOut` / `EaseInOut` — the three CSS preset bezier curves. */
export class CssEasing implements EasingLike {
  readonly kind: 'easeIn' | 'easeOut' | 'easeInOut';
  readonly runtime: CubicBezierRuntime;

  constructor(kind: 'easeIn' | 'easeOut' | 'easeInOut', runtime: CubicBezierRuntime) {
    this.kind = kind;
    this.runtime = runtime;
  }

  solve(progress: number): number {
    return this.runtime.solve(progress);
  }
}

/** `Easing::CubicBezier(x1, y1, x2, y2)`. */
export class CubicBezierEasing implements EasingLike {
  readonly kind = 'cubicBezier' as const;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly runtime: CubicBezierRuntime;

  constructor(x1: number, y1: number, x2: number, y2: number) {
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
    this.runtime = new CubicBezierRuntime(x1, y1, x2, y2);
  }

  solve(progress: number): number {
    return this.runtime.solve(progress);
  }
}

/**
 * `Easing::Spring { mass, stiffness, damping }`.
 *
 * A spring computes its own settle time, so a keyframe that does not declare an explicit `end`
 * runs until the spring comes to rest.
 */
export class SpringEasing implements EasingLike {
  readonly kind = 'spring' as const;
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
  readonly runtime: SpringRuntime;

  constructor(options: SpringEasingOptions) {
    this.mass = options.mass;
    this.stiffness = options.stiffness;
    this.damping = options.damping;
    this.runtime = new SpringRuntime(options.mass, options.stiffness, options.damping);
  }

  solve(progress: number): number {
    return this.runtime.solve(progress);
  }
}

export type Easing = LinearEasing | CssEasing | CubicBezierEasing | SpringEasing;

/**
 * Easing constructors and the CSS presets.
 *
 * The presets are shared singletons: they are immutable, so a single instance can be reused by
 * every keyframe of a timeline.
 */
export const Easing = {
  /** `f(current_time) = current_time / duration` */
  linear: new LinearEasing(),
  /** CSS-like ease-in (0.42, 0, 1, 1). */
  easeIn: new CssEasing('easeIn', CubicBezierRuntime.easeIn()),
  /** CSS-like ease-out (0, 0, 0.58, 1). */
  easeOut: new CssEasing('easeOut', CubicBezierRuntime.easeOut()),
  /** CSS-like ease-in-out (0.42, 0, 0.58, 1). */
  easeInOut: new CssEasing('easeInOut', CubicBezierRuntime.easeInOut()),
  /** Arbitrary cubic bezier; `x1` / `x2` are clamped to `[0, 1]` by the runtime. */
  cubicBezier(x1: number, y1: number, x2: number, y2: number): CubicBezierEasing {
    return new CubicBezierEasing(x1, y1, x2, y2);
  },
  /** Spring physics easing. */
  spring(options: SpringEasingOptions): SpringEasing {
    return new SpringEasing(options);
  },
} as const;

/** Eased progress of any easing, `t` in `0..1` (springs may return values outside of it). */
export function solveEasing(easing: EasingLike, t: number): number {
  return easing.solve(t);
}
