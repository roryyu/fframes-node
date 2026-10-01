/**
 * Spring easing runtime.
 *
 * Port of `.source/fframes/fframes/src/animation/spring.rs`, which is itself inspired by
 * https://webkit.org/demos/spring/spring.js (Copyright (C) 2016 Apple Inc. All rights reserved.)
 *
 * The solve function returns progress in the `0..1` range (it may overshoot while an
 * under-damped spring is still ringing), unlike the cubic-bezier easings which stay inside the
 * unit interval.
 */

/**
 * Frame duration used by {@link SpringRuntime.getDuration}: `0.166667` s, i.e. 60 fps.
 * Copied verbatim from the Rust source.
 */
export const SPRING_FRAME_DURATION = 0.166667;

/** How many consecutive settled frames are required before the spring is considered done. */
export const SPRING_SETTLED_FRAMES = 128;

/**
 * Defensive bound for {@link SpringRuntime.getDuration}.
 *
 * The Rust loop `loop { elapsed += frame_duration; if solve(elapsed) == 1.0 { ... } }` terminates
 * only once the exponential term underflows to exactly `0.0`. That happens in `f32` (the Rust
 * build) but in `f64` an undamped spring (`damping = 0`, `solve` never equal to `1.0`) would spin
 * forever. The bound keeps the port total; it is never reached by a spring that settles.
 */
export const SPRING_MAX_SETTLE_STEPS = 1_000_000;

/** Parameters of a spring easing, mirroring `Easing::Spring { mass, stiffness, damping }`. */
export interface SpringOptions {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
}

export class SpringRuntime {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
  /** Damping ratio. */
  readonly zeta: number;
  /** Undamped natural frequency. */
  readonly w0: number;
  /** Damped natural frequency, `0` for critically damped springs. */
  readonly wd: number;
  readonly a: number;
  readonly b: number;

  constructor(mass: number, stiffness: number, damping: number) {
    this.mass = mass;
    this.stiffness = stiffness;
    this.damping = damping;

    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    const w0 = Math.sqrt(stiffness / mass);

    this.zeta = zeta;
    this.w0 = w0;

    if (zeta < 1) {
      // Under-damped
      this.wd = w0 * Math.sqrt(1 - zeta * zeta);
      this.a = 1;
      this.b = (zeta * w0) / this.wd;
    } else {
      // Critically damped (the over-damped case is ignored, like in the Rust source).
      this.wd = 0;
      this.a = 1;
      this.b = w0;
    }
  }

  /** Progress in `0..1` (`1 - progress` of the physical displacement) for the elapsed time `t`. */
  solve(t: number): number {
    const progress =
      this.zeta < 1
        ? // Under-damped
          Math.exp(-t * this.zeta * this.w0) *
          (this.a * Math.cos(this.wd * t) + this.b * Math.sin(this.wd * t))
        : // Critically damped
          ((this.a + this.b * t) * Math.exp(-t * this.w0));

    // Map range from [1..0] to [0..1].
    return 1 - progress;
  }

  /**
   * Settle time of the spring, in the unit of `t` used by {@link SpringRuntime.solve}.
   *
   * "The dumbest way to calculate spring duration" — taken from animejs
   * (https://github.com/juliangarnier/anime/blob/master/src/index.js#L100). There is no closed
   * form for the settle time, so the original walks 60 fps frames until the spring reports
   * exactly `1.0` for {@link SPRING_SETTLED_FRAMES} consecutive frames.
   *
   * Note: the Rust source returns `elapsed * frame_duration` even though `elapsed` is already
   * accumulated in seconds. That looks like an upstream typo, but it is ported verbatim here so
   * the animation timings match the original implementation (see PORTING.md).
   */
  getDuration(): number {
    let elapsed = 0;
    let notAnimatingFrames = 0;
    let steps = 0;

    for (;;) {
      if (steps >= SPRING_MAX_SETTLE_STEPS) {
        break;
      }
      steps += 1;

      elapsed += SPRING_FRAME_DURATION;

      if (this.solve(elapsed) === 1) {
        notAnimatingFrames += 1;
        if (notAnimatingFrames >= SPRING_SETTLED_FRAMES) {
          break;
        }
      } else {
        notAnimatingFrames = 0;
      }
    }

    return elapsed * SPRING_FRAME_DURATION;
  }
}
