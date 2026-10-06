/**
 * Color utilities for art-style animations.
 * Ported from huashu-art-motion's PAINT color helpers.
 */

import { lerp, clamp } from './math.ts';

export type RGB = [number, number, number];

/** Parse hex color to RGB tuple */
export function hex(h: string): RGB {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** RGB tuple to CSS rgba string */
export function rgb(c: RGB, a = 1): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

/** RGB tuple to CSS hex string */
export function toHex(c: RGB): string {
  const r = Math.round(clamp(c[0], 0, 255)).toString(16).padStart(2, '0');
  const g = Math.round(clamp(c[1], 0, 255)).toString(16).padStart(2, '0');
  const b = Math.round(clamp(c[2], 0, 255)).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/** Linear interpolation between two RGB colors */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Add random jitter to a color */
export function jitter(c: RGB, r: () => number, amt: number): RGB {
  return [
    c[0] + (r() - 0.5) * amt,
    c[1] + (r() - 0.5) * amt,
    c[2] + (r() - 0.5) * amt,
  ];
}

/** Create a swatch function: picks from a palette of hex colors, optionally mixing with base color */
export function swatch(hexes: string[], mixBase = 0.35): (col: RGB, r: () => number) => RGB {
  const cs = hexes.map(hex);
  return (col: RGB, r: () => number) => {
    const k = cs[(r() * cs.length) | 0];
    return mix(k, col, mixBase);
  };
}

/** Luminance of an RGB color (0..1) */
export function luminance(c: RGB): number {
  return (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255;
}

/** Warm/cool shift for dabs/pointillism */
export function warmShift(c: RGB, shift: number, r: () => number): RGB {
  const warm = r() < 0.5
    ? [shift, shift * 0.5, -shift]
    : [-shift * 0.6, 0, shift];
  return [c[0] + warm[0], c[1] + warm[1], c[2] + warm[2]];
}

/** HSL to RGB conversion */
export function hsl(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360 / 360;
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2rgb(h + 1 / 3) * 255, hue2rgb(h) * 255, hue2rgb(h - 1 / 3) * 255];
}

/** RGB to HSL */
export function toHsl(c: RGB): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

/** Darken a color by a factor */
export function darken(c: RGB, factor: number): RGB {
  return [c[0] * (1 - factor), c[1] * (1 - factor), c[2] * (1 - factor)];
}

/** Lighten a color by a factor */
export function lighten(c: RGB, factor: number): RGB {
  return [
    c[0] + (255 - c[0]) * factor,
    c[1] + (255 - c[1]) * factor,
    c[2] + (255 - c[2]) * factor,
  ];
}

/** Alpha-blend foreground over background */
export function alphaBlend(fg: RGB, bg: RGB, alpha: number): RGB {
  return mix(bg, fg, clamp(alpha, 0, 1));
}
