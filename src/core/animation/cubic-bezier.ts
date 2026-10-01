/**
 * Cubic bezier easing runtime.
 *
 * A port of <https://github.com/gre/bezier-easing> by Gaëtan Renaudeau (2014 - 2015, MIT
 * License), matching `.source/fframes/fframes/src/animation/cubic_bezier.rs`:
 *
 * - the pre-computed sample table has `K_SPLINE_TABLE_SIZE` entries spaced by
 *   `K_SAMPLE_STEP_SIZE`,
 * - `getTForX` seeds a Newton-Raphson iteration from the table and falls back to a binary
 *   subdivision when the slope is too shallow,
 * - `x1` / `x2` are clamped to `[0, 1]` (CSS requires the control points of the *time* axis to
 *   be inside the unit interval), `y1` / `y2` are not.
 */

// These values are established by empiricism with tests (tradeoff: performance VS precision).
const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 0.0000001;
const SUBDIVISION_MAX_ITERATIONS = 10;

const K_SPLINE_TABLE_SIZE = 11;
const K_SAMPLE_STEP_SIZE = 1 / (K_SPLINE_TABLE_SIZE - 1);

function a(a1: number, a2: number): number {
  return 1 - 3 * a2 + 3 * a1;
}

function b(a1: number, a2: number): number {
  return 3 * a2 - 6 * a1;
}

function c(a1: number): number {
  return 3 * a1;
}

function getSlope(t: number, a1: number, a2: number): number {
  return 3 * a(a1, a2) * t * t + 2 * b(a1, a2) * t + c(a1);
}

function calcBezier(t: number, a1: number, a2: number): number {
  return ((a(a1, a2) * t + b(a1, a2)) * t + c(a1)) * t;
}

function binarySubdivide(x: number, aLow: number, aHigh: number, x1: number, x2: number): number {
  let currentT = 0;
  let currentX = 0;
  let i = 0;
  let low = aLow;
  let high = aHigh;

  for (;;) {
    currentT = low + (high - low) / 2;
    currentX = calcBezier(currentT, x1, x2) - x;

    if (currentX > 0) {
      high = currentT;
    } else {
      low = currentT;
    }

    if (!(Math.abs(currentX) > SUBDIVISION_PRECISION && i < SUBDIVISION_MAX_ITERATIONS)) {
      break;
    }
    i += 1;
  }

  return currentT;
}

function newtonRaphsonIterate(x: number, guessT: number, x1: number, x2: number): number {
  let guess = guessT;

  for (let i = 0; i < NEWTON_ITERATIONS; i += 1) {
    const currentSlope = getSlope(guess, x1, x2);
    if (currentSlope === 0) {
      return guess;
    }
    const currentX = calcBezier(guess, x1, x2) - x;
    guess -= currentX / currentSlope;
  }

  return guess;
}

export class CubicBezierRuntime {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** `calcBezier` sampled at `0, 0.1, 0.2 … 1` of the *x* curve. */
  readonly sampleValues: readonly number[];

  static easeIn(): CubicBezierRuntime {
    return new CubicBezierRuntime(0.42, 0, 1, 1);
  }

  static easeOut(): CubicBezierRuntime {
    return new CubicBezierRuntime(0, 0, 0.58, 1);
  }

  static easeInOut(): CubicBezierRuntime {
    return new CubicBezierRuntime(0.42, 0, 0.58, 1);
  }

  constructor(x1: number, y1: number, x2: number, y2: number) {
    const x1Clamped = Math.min(Math.max(x1, 0), 1);
    const x2Clamped = Math.min(Math.max(x2, 0), 1);

    const sampleValues: number[] = [];
    for (let i = 0; i < K_SPLINE_TABLE_SIZE; i += 1) {
      sampleValues.push(calcBezier(i * K_SAMPLE_STEP_SIZE, x1Clamped, x2Clamped));
    }

    this.x1 = x1Clamped;
    this.y1 = y1;
    this.x2 = x2Clamped;
    this.y2 = y2;
    this.sampleValues = sampleValues;
  }

  /** Eased progress for a linear progress `x` in `0..1`; the result may leave the unit interval. */
  solve(x: number): number {
    const xClamped = Math.min(Math.max(x, 0), 1);

    // An identity curve (control points on the diagonal) short-circuits the search.
    if (this.x1 === this.y1 && this.x2 === this.y2) {
      return x;
    }

    if (x === 0 || x === 1) {
      return x;
    }

    return calcBezier(this.getTForX(xClamped), this.y1, this.y2);
  }

  private getTForX(x: number): number {
    let intervalStart = 0;
    let currentSample = 1;
    const lastSample = K_SPLINE_TABLE_SIZE - 1;

    while (currentSample !== lastSample && this.sampleValues[currentSample] <= x) {
      intervalStart += K_SAMPLE_STEP_SIZE;
      currentSample += 1;
    }
    currentSample -= 1;

    // Interpolate to provide an initial guess for t.
    const dist =
      (x - this.sampleValues[currentSample]) /
      (this.sampleValues[currentSample + 1] - this.sampleValues[currentSample]);
    const guessForT = intervalStart + dist * K_SAMPLE_STEP_SIZE;

    const initialSlope = getSlope(guessForT, this.x1, this.x2);
    if (initialSlope >= NEWTON_MIN_SLOPE) {
      return newtonRaphsonIterate(x, guessForT, this.x1, this.x2);
    }
    if (initialSlope === 0) {
      return guessForT;
    }
    return binarySubdivide(x, intervalStart, intervalStart + K_SAMPLE_STEP_SIZE, this.x1, this.x2);
  }
}
