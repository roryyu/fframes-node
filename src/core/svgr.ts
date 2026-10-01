/**
 * SVG tree fragment and the `svgr` tagged template.
 *
 * Port of `.source/fframes/fframes/src/svgr.rs`. The Rust build can turn the macro output into a
 * compile-time SVG tree and hash static subtrees; this port keeps the runtime string form only
 * (see PORTING.md), so `Svgr` is a thin wrapper around the serialized markup.
 */

import { Color } from './color.ts';
import { Transform } from './transform.ts';

/** Anything that can be interpolated into an `svgr` template. */
export type SvgrValue = number | string | boolean | null | undefined | Svgr | readonly unknown[] | Color | Transform;

export class Svgr {
  /** The serialized SVG markup. */
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  /** `Svgr::empty()` — "nothing this frame". */
  static empty(): Svgr {
    return new Svgr('');
  }

  /** `impl From<&str> for Svgr` / `impl From<String> for Svgr`. */
  static from(value: string): Svgr {
    return new Svgr(value);
  }

  /** `impl fmt::Display for Svgr` */
  toString(): string {
    return this.value;
  }
}

/**
 * Serializes an interpolated value, following the rules of the Rust `svgr!` macro:
 *
 * - `number` and `boolean` become `String(value)`,
 * - `string` is inserted verbatim — **not** escaped, exactly like the original macro,
 * - `Svgr` contributes its `value`,
 * - arrays are concatenated item by item,
 * - `Color` uses {@link Color.toSvg} and `Transform` uses {@link Transform.toSvgAttribute},
 * - `null` / `undefined` contribute nothing,
 * - anything else is stringified with `String(value)`.
 */
export function stringifySvgrValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Svgr) {
    return value.value;
  }
  if (value instanceof Color) {
    return value.toSvg();
  }
  if (value instanceof Transform) {
    return value.toSvgAttribute();
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifySvgrValue(item)).join('');
  }
  return String(value);
}

/**
 * The `svgr` tagged template:
 *
 * ```ts
 * svgr`<rect x="${10}" fill="${Color.fromHex('#ff8800')}"/>`
 * ```
 */
export function svgr(strings: TemplateStringsArray, ...values: unknown[]): Svgr {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) {
      out += stringifySvgrValue(values[i]);
    }
  }
  return new Svgr(out);
}

/** `impl FromIterator<Svgr> for Svgr` — plain string concatenation. */
export function concatSvgr(items: Iterable<Svgr>): Svgr {
  let out = '';
  for (const item of items) {
    out += item.value;
  }
  return new Svgr(out);
}
