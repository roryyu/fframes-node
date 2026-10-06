/**
 * Mathematical utilities for art-style animations.
 * Ported from huashu-art-motion's U (util.js) and MO (motion.js).
 * All functions are deterministic — seeded random, no clock reads.
 */

export const TAU = Math.PI * 2;

export const clamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

/** smoothstep: x smoothly goes 0→1 within [a,b] */
export const ss = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Extract the [a,b] segment of p as 0..1 */
export const seg = (p: number, a: number, b: number): number =>
  Math.max(0, Math.min(1, (p - a) / (b - a)));

/** Quantize continuous time into fps steps — "stepped" motion for rubber-hose, pixel, shadow-puppet styles */
export const stepTime = (t: number, fps: number): number => Math.floor(t * fps) / fps;

// --- Seeded random (mulberry32) ---
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D hash → [0,1) */
export function hash(i: number, j = 0): number {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// --- Easing functions ---
export const ease = {
  linear: (p: number) => p,
  inOut: (p: number) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2,
  out: (p: number) => 1 - Math.pow(1 - p, 3),
  in: (p: number) => p * p * p,
  outBack: (p: number) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  },
};

// --- Manim-style easing (3b1b/manim rate_functions) ---
/** smooth = 6t⁵−15t⁴+10t³: velocity and acceleration are both 0 at endpoints */
export const smooth = (t: number): number => {
  t = clamp(t);
  return t * t * t * (10 - 15 * t + 6 * t * t);
};

const sig = (x: number) => 1 / (1 + Math.exp(-x));

/** ManimCE smooth */
export const smoothCE = (t: number, inflection = 10): number => {
  const e = sig(-inflection / 2);
  return clamp((sig(inflection * (t - 0.5)) - e) / (1 - 2 * e));
};

/** thereAndBack: goes and comes back (Indicate) */
export const thereAndBack = (t: number): number => smooth(t < 0.5 ? 2 * t : 2 * (1 - t));

/** rushInto: slow start, rush to end */
export const rushInto = (t: number): number => 2 * smooth(t / 2);

/** rushFrom: rush out, slow settle */
export const rushFrom = (t: number): number => 2 * smooth(t / 2 + 0.5) - 1;

export const doubleSmooth = (t: number): number =>
  t < 0.5 ? 0.5 * smooth(2 * t) : 0.5 * (1 + smooth(2 * t - 1));

export const wiggle = (t: number, wiggles = 2): number =>
  thereAndBack(t) * Math.sin(wiggles * Math.PI * t);

/** manim LaggedStart: n sub-animations, i-th starts at p*i*r */
export const lagged = (i: number, n: number, p: number, r = 0.05): number =>
  clamp(p * (1 + (n - 1) * r) - i * r);

// --- CSS / AE named easings ---
export const sineInOut = (p: number) => -(Math.cos(Math.PI * p) - 1) / 2;
export const cubicIn = (p: number) => p * p * p;
export const cubicOut = (p: number) => 1 - Math.pow(1 - p, 3);
export const cubicInOut = (p: number) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
export const quartOut = (p: number) => 1 - Math.pow(1 - p, 4);
export const quintOut = (p: number) => 1 - Math.pow(1 - p, 5);
export const quintInOut = (p: number) => p < 0.5 ? 16 * p ** 5 : 1 - Math.pow(-2 * p + 2, 5) / 2;
export const expoIn = (p: number) => p <= 0 ? 0 : Math.pow(2, 10 * p - 10);
export const expoOut = (p: number) => p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
export const expoInOut = (p: number) =>
  p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2;

/** backOut overshoot: s=1.70158 ≈ 10%; 2.2 ≈ 13%; 2.6 ≈ 17%; 3.5 ≈ 23% */
export const backOut = (p: number, s = 1.70158): number => {
  const q = p - 1;
  return 1 + (s + 1) * q * q * q + s * q * q;
};

/** Elastic settle: overshoot once then return (sticker "snap" landing) */
export const elasticOut = (p: number): number =>
  p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * (2 * Math.PI / 3)) + 1;

/** CSS cubic-bezier(x1,y1,x2,y2) via Newton's method */
export function bezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s: number) => ((ax * s + bx) * s + cx) * s;
  const Y = (s: number) => ((ay * s + by) * s + cy) * s;
  const dX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let s = p;
    for (let k = 0; k < 8; k++) {
      const e = X(s) - p, d = dX(s);
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    s = clamp(s);
    return Y(s);
  };
}

// Named bezier presets
export const appleOut = bezier(0.25, 0.1, 0.25, 1);
export const emphasized = bezier(0.2, 0, 0, 1);
export const k75 = bezier(0.75, 0, 0.25, 1);
export const easyEase = bezier(0.333, 0, 0.667, 1);
export const longTail = bezier(0.33, 0, 0.2, 1);

// --- Springs ---
/** SwiftUI-parameterized spring: stiffness=(2π/duration)², damping=4π(1-bounce)/duration */
export function spring(t: number, { duration = 0.5, bounce = 0, v0 = 0 }: { duration?: number; bounce?: number; v0?: number } = {}): number {
  if (t <= 0) return 0;
  const w = 2 * Math.PI / duration, z = 1 - bounce;
  let x: number;
  if (Math.abs(z - 1) < 1e-4) x = Math.exp(-w * t) * (1 + (w - v0) * t);
  else if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    x = Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w - v0) / wd) * Math.sin(wd * t));
  } else {
    const r = Math.sqrt(z * z - 1), a = -w * (z - r), b = -w * (z + r);
    const A = (-v0 - b) / (a - b);
    x = A * Math.exp(a * t) + (1 - A) * Math.exp(b * t);
  }
  return 1 - x;
}

export const smoothSpring = (t: number) => spring(t, { duration: 0.5, bounce: 0 });
export const snappy = (t: number) => spring(t, { duration: 0.5, bounce: 0.15 });
export const bouncy = (t: number) => spring(t, { duration: 0.5, bounce: 0.3 });

/** Frequency/decay parameterized underdamped spring step response */
export const springHz = (t: number, freq = 2.5, decay = 9): number =>
  t <= 0 ? 0 : 1 - Math.exp(-decay * t) * Math.cos(2 * Math.PI * freq * t);

/** Post-arrival residual oscillation (Dan Ebberts inertia bounce) */
export const settle = (t: number, amp: number, freq = 3, decay = 5): number =>
  t <= 0 ? 0 : amp * Math.sin(2 * Math.PI * freq * t) / Math.exp(decay * t);

// --- Continuous micro-motion ---
/** Floating: two-frequency sine overlay. Period avoids ~5s (HIG: ~0.2Hz sustained sway is uncomfortable) */
export const float_ = (t: number, amp = 6, period = 4, ph = 0): number =>
  amp * (0.75 * Math.sin(2 * Math.PI * t / period + ph) + 0.25 * Math.sin(2 * Math.PI * t / (period * 0.53) + ph * 1.7));

// --- Inverse & beat ---
/** Inverse of an easing function (bisection): "at what time does the value reach y" */
export function invert(easeFn: (p: number) => number, y: number, iters = 30): number {
  let a = 0, b = 1;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    if (easeFn(m) < y) a = m; else b = m;
  }
  return (a + b) / 2;
}

/** Beat → seconds */
export const beat = (n: number, bpm = 120): number => n * 60 / bpm;

/** Reveal frame lands on beat: segment start = bar line − reveal point × transition duration */
export const onBeat = (barTime: number, revealP: number, trDur: number): number =>
  barTime - revealP * trDur;

// --- Perlin noise (2D) ---
const perm = new Uint8Array(512);
{
  const r = rng(1337);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (h: number, x: number, y: number) => {
  const u = (h & 1) ? x : -x, v = (h & 2) ? y : -y;
  return (h & 4) ? u + v * 0.5 : u * 0.5 + v;
};

/** Perlin 2D noise, approximately [-1,1] */
export function noise(x: number, y: number): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  x -= Math.floor(x); y -= Math.floor(y);
  const u = fade(x), v = fade(y);
  const a = perm[X] + Y, b = perm[X + 1] + Y;
  return lerp(
    lerp(grad(perm[a], x, y), grad(perm[b], x - 1, y), u),
    lerp(grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1), u),
    v
  );
}

/** Fractal Brownian Motion */
export function fbm(x: number, y: number, octaves = 4): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    s += a * noise(x * f, y * f);
    a *= 0.5;
    f *= 2;
  }
  return s;
}
