/**
 * SVG path utilities for art-style animations.
 * Ported from huashu-art-motion's KIT (kit.js) and brush helpers.
 * Generates SVG path data strings and geometric shapes.
 */

import { lerp, rng, clamp, TAU } from './math.ts';

export type Point = [number, number];

/** Catmull-Rom densification of a point list (open) */
export function densify(pts: Point[], per = 6): Point[] {
  const out: Point[] = [];
  const n = pts.length;
  const P_ = (i: number) => pts[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P_(i - 1), p1 = P_(i), p2 = P_(i + 1), p3 = P_(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

/** Resample a point list at equal arc-length intervals */
export function resample(pts: Point[], step = 4): Point[] {
  const out: Point[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = step - acc;
    while (d <= L) {
      const q = d / L;
      out.push([a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q]);
      d += step;
    }
    acc = L - (d - step);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Convert point list to SVG path data string */
export function pointsToPath(pts: Point[], closed = false): string {
  if (pts.length === 0) return '';
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `L${pts[i][0].toFixed(2)},${pts[i][1].toFixed(2)}`;
  }
  if (closed) d += 'Z';
  return d;
}

/** Convert point list to smooth SVG path using quadratic bezier midpoints */
export function pointsToSmoothPath(pts: Point[], closed = false): string {
  if (pts.length < 3) return pointsToPath(pts, closed);
  const n = pts.length;
  let d = `M${((pts[0][0] + pts[1][0]) / 2).toFixed(2)},${((pts[0][1] + pts[1][1]) / 2).toFixed(2)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${pts[i][0].toFixed(2)},${pts[i][1].toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`;
  }
  if (closed) {
    const mx = (pts[n - 1][0] + pts[0][0]) / 2;
    const my = (pts[n - 1][1] + pts[0][1]) / 2;
    d += `Q${pts[n - 1][0].toFixed(2)},${pts[n - 1][1].toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`;
    d += 'Z';
  } else {
    d += `L${pts[n - 1][0].toFixed(2)},${pts[n - 1][1].toFixed(2)}`;
  }
  return d;
}

/** Variable-width ribbon path: offset both sides by w(q)/2 */
export function ribbonPath(pts: Point[], w: number | ((q: number, i: number) => number)): string {
  const n = pts.length;
  const L: Point[] = [], R: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    const hw = (typeof w === 'function' ? w(i / (n - 1), i) : w) / 2;
    L.push([pts[i][0] - dy * hw, pts[i][1] + dx * hw]);
    R.push([pts[i][0] + dy * hw, pts[i][1] - dx * hw]);
  }
  let path = `M${L[0][0].toFixed(2)},${L[0][1].toFixed(2)}`;
  for (let i = 1; i < n; i++) path += `L${L[i][0].toFixed(2)},${L[i][1].toFixed(2)}`;
  for (let i = n - 1; i >= 0; i--) path += `L${R[i][0].toFixed(2)},${R[i][1].toFixed(2)}`;
  return path + 'Z';
}

/** Rough/hand-drawn path: resample + jitter */
export function roughPathData(pts: Point[], { amp = 2, seed = 1, closed = false, step = 6 }: {
  amp?: number; seed?: number; closed?: boolean; step?: number;
} = {}): string {
  const r = rng(seed);
  const out: Point[] = [];
  const N = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 0; k < n; k++) {
      const q = k / n;
      out.push([
        lerp(a[0], b[0], q) + (r() - 0.5) * amp,
        lerp(a[1], b[1], q) + (r() - 0.5) * amp,
      ]);
    }
  }
  if (!closed) {
    out.push([
      pts[pts.length - 1][0] + (r() - 0.5) * amp,
      pts[pts.length - 1][1] + (r() - 0.5) * amp,
    ]);
  }
  return pointsToPath(out, closed);
}

/** Cubic bezier sampling to point list */
export function bez(p0: Point, p1: Point, p2: Point, p3: Point, n = 24): Point[] {
  const o: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    o.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return o;
}

/** N-pointed star path */
export function starPath(cx: number, cy: number, r0: number, r1: number, n: number, rot = 0): string {
  const pts: Point[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i / (n * 2)) * TAU - Math.PI / 2;
    const r = i % 2 ? r1 : r0;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pointsToPath(pts, true);
}

/** Hand-drawn irregular circle (blob) — for Kusama dots etc. */
export function blobPath(cx: number, cy: number, r: number, seed: number, wob = 0.08, n = 14): string {
  const rr = rng(seed);
  const off: number[] = [];
  for (let i = 0; i < n; i++) off.push(1 + (rr() - 0.5) * 2 * wob);
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    pts.push([cx + Math.cos(a) * r * off[i], cy + Math.sin(a) * r * off[i]]);
  }
  // Use quadratic bezier through midpoints for smooth blob
  let d = `M${((pts[0][0] + pts[n - 1][0]) / 2).toFixed(2)},${((pts[0][1] + pts[n - 1][1]) / 2).toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    d += `Q${p[0].toFixed(2)},${p[1].toFixed(2)} ${((p[0] + q[0]) / 2).toFixed(2)},${((p[1] + q[1]) / 2).toFixed(2)}`;
  }
  return d + 'Z';
}

/** Scissor-cut path: resample + jitter for paper-cut edges (Matisse) */
export function cutPath(pts: Point[], seed: number, step = 18, amp = 2.5): string {
  const r = rng(seed);
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 0; k < n; k++) {
      const q = k / n;
      out.push([
        lerp(a[0], b[0], q) + (r() - 0.5) * amp * 2,
        lerp(a[1], b[1], q) + (r() - 0.5) * amp * 2,
      ]);
    }
  }
  return pointsToPath(out, true);
}

/** Rectangle as point list */
export function rectPts(x: number, y: number, w: number, h: number): Point[] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** Ellipse as point list */
export function ellipsePts(cx: number, cy: number, rx: number, ry: number, n = 18): Point[] {
  return Array.from({ length: n }, (_, i) => [
    cx + Math.cos((i / n) * TAU) * rx,
    cy + Math.sin((i / n) * TAU) * ry,
  ]);
}

/** Midpoint displacement deformation for watercolor edges */
export function deform(pts: Point[], depth: number, amp: number, r: () => number): Point[] {
  let out = pts;
  for (let d = 0; d < depth; d++) {
    const n: Point[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const g = (r() + r() + r() - 1.5) * amp * Math.min(1, len / 80);
      const nx = -(b[1] - a[1]) / (len || 1), ny = (b[0] - a[0]) / (len || 1);
      n.push(a, [(a[0] + b[0]) / 2 + nx * g, (a[1] + b[1]) / 2 + ny * g]);
    }
    out = n;
    amp *= 0.6;
  }
  return out;
}

/** Spiral path points */
export function spiralPts(cx: number, cy: number, r0: number, r1: number, turns: number, n = 60, rot = 0): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const q = i / n;
    const a = rot + q * turns * TAU;
    const r = lerp(r0, r1, q);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/** Wavy line points */
export function wavyPts(x0: number, y0: number, x1: number, y1: number, amp: number, freq: number, n = 30): Point[] {
  const pts: Point[] = [];
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  for (let i = 0; i <= n; i++) {
    const q = i / n;
    const w = Math.sin(q * freq * TAU) * amp;
    pts.push([lerp(x0, x1, q) + nx * w, lerp(y0, y1, q) + ny * w]);
  }
  return pts;
}
