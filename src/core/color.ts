/**
 * 8-bit rgba color.
 *
 * Port of `.source/fframes/fframes/src/color.rs`. `r`, `g` and `b` are `0..255` and `a` is
 * `0..1` here, where the Rust `Color` keeps the alpha as a `u8` in `0..255` as well. Only the
 * alpha representation differs, which keeps the alpha usable in arithmetic without a division.
 *
 * Colors can be animated directly in a timeline: {@link Color.interpolate} blends the four
 * components linearly.
 */

/** A `u8` in `0..255`, the type of the Rust color channels and of its alpha. */
function clampByte(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(Math.max(Math.round(value), 0), 255);
}

function clampChannel(value: number): number {
  return clampByte(value);
}

function clampAlpha(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

function hexDigit(character: string): number {
  const code = character.charCodeAt(0);
  let digit: number;
  if (code >= 48 && code <= 57) {
    // 0-9
    digit = code - 48;
  } else if (code >= 97 && code <= 102) {
    // a-f
    digit = code - 97 + 10;
  } else if (code >= 65 && code <= 70) {
    // A-F
    digit = code - 65 + 10;
  } else {
    throw new RangeError(
      `Failed to parse "${character}" as a hex color string. Char should be valid for radix 16 (0-9, a-f)`,
    );
  }
  return digit;
}

function hexPair(value: string, index: number): number {
  return hexDigit(value[index] as string) * 16 + hexDigit(value[index + 1] as string);
}

function pad2(value: number): string {
  const text = Math.round(value).toString(16);
  return text.length >= 2 ? text : `0${text}`;
}

export class Color {
  /** Red channel, `0..255`. */
  readonly r: number;
  /** Green channel, `0..255`. */
  readonly g: number;
  /** Blue channel, `0..255`. */
  readonly b: number;
  /** Alpha channel, `0..1`. */
  readonly a: number;

  constructor(r: number, g: number, b: number, a: number = 1) {
    this.r = clampChannel(r);
    this.g = clampChannel(g);
    this.b = clampChannel(b);
    this.a = clampAlpha(a);
  }

  /** `Color::BLACK` */
  static get black(): Color {
    return new Color(0, 0, 0, 1);
  }

  /** `Color::WHITE` */
  static get white(): Color {
    return new Color(255, 255, 255, 1);
  }

  /** `Color::TRANSPARENT` */
  static get transparent(): Color {
    return new Color(0, 0, 0, 0);
  }

  /** `Color::CHROMA_KEY` — the standard green key color used in video production. */
  static get chromaKey(): Color {
    return new Color(0, 177, 64, 0);
  }

  /** `Color::rgb` — opaque color. */
  static rgb(r: number, g: number, b: number): Color {
    return new Color(r, g, b, 1);
  }

  /**
   * `Color::rgba` — `a` in `0..1`.
   *
   * The Rust constructor takes the alpha as a `u8`; `fromAlphaByte` is provided for parity when
   * migrating code that keeps the 8-bit representation.
   */
  static rgba(r: number, g: number, b: number, a: number): Color {
    return new Color(r, g, b, a);
  }

  /** Same color with an explicit 8-bit alpha (`0..255`), like the Rust `Color::rgba`. */
  static fromAlphaByte(r: number, g: number, b: number, alphaByte: number): Color {
    return new Color(r, g, b, clampAlpha(alphaByte / 255));
  }

  /** The alpha channel as a `u8` in `0..255`, the representation the Rust `Color` uses. */
  get alphaByte(): number {
    return Math.round(this.a * 255);
  }

  /**
   * `Color::hex` — parses `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`.
   *
   * Invalid input falls back to black, like the Rust version, instead of throwing.
   */
  static fromHex(hex: string): Color {
    const value = hex.trim();
    if (!value.startsWith('#')) {
      return Color.black;
    }

    try {
      switch (value.length) {
        case 4:
          // #rgb
          return new Color(
            hexDigit(value[1] as string) * 17,
            hexDigit(value[2] as string) * 17,
            hexDigit(value[3] as string) * 17,
            1,
          );
        case 5:
          // #rgba
          return new Color(
            hexDigit(value[1] as string) * 17,
            hexDigit(value[2] as string) * 17,
            hexDigit(value[3] as string) * 17,
            hexDigit(value[4] as string) * 17 / 255,
          );
        case 7:
          // #rrggbb
          return new Color(hexPair(value, 1), hexPair(value, 3), hexPair(value, 5), 1);
        case 9:
          // #rrggbbaa
          return new Color(
            hexPair(value, 1),
            hexPair(value, 3),
            hexPair(value, 5),
            hexPair(value, 7) / 255,
          );
        default:
          return Color.black;
      }
    } catch {
      return Color.black;
    }
  }

  /** Alias of {@link Color.fromHex}, matching the Rust `Color::hex` name. */
  static hex(hex: string): Color {
    return Color.fromHex(hex);
  }

  /**
   * `Color::with_alpha` — same rgb, new alpha, exactly like the Rust `with_alpha(a: u8)`.
   *
   * The argument is an **8-bit alpha in `0..255`** (rounded and clamped like a `u8`), because the
   * Rust constructor takes one; the `a` field itself stays a float in `0..1` (see the module
   * header). For a float alpha use the constructor, e.g. `new Color(255, 0, 0, 0.5)`.
   */
  withAlpha(alphaByte: number): Color {
    return new Color(this.r, this.g, this.b, clampByte(alphaByte) / 255);
  }

  /** `Color::is_transparent` */
  get isTransparent(): boolean {
    return this.a === 0;
  }

  /** `Color::is_opaque` */
  get isOpaque(): boolean {
    return this.a === 1;
  }

  /**
   * The color as an SVG paint string: `rgba(r, g, b, a)` when translucent, `#rrggbb` when opaque.
   */
  toSvg(): string {
    if (this.a < 1) {
      return `rgba(${this.r}, ${this.g}, ${this.b}, ${round3(this.a)})`;
    }
    return `#${pad2(this.r)}${pad2(this.g)}${pad2(this.b)}`;
  }

  /** `impl fmt::Display for Color` — `rgb(r, g, b)` or `rgba(r, g, b, a.aaa)`. */
  toString(): string {
    if (this.a >= 1) {
      return `rgb(${this.r}, ${this.g}, ${this.b})`;
    }
    return `rgba(${this.r}, ${this.g}, ${this.b}, ${round3(this.a)})`;
  }

  /**
   * `impl Animatable for Color` — linear blend of all four channels.
   *
   * The rgb channels are truncated to integers exactly like the Rust `as u8` cast; the alpha
   * stays a float.
   */
  interpolate(to: Color, progress: number): Color {
    return new Color(
      Math.trunc(this.r + (to.r - this.r) * progress),
      Math.trunc(this.g + (to.g - this.g) * progress),
      Math.trunc(this.b + (to.b - this.b) * progress),
      this.a + (to.a - this.a) * progress,
    );
  }

  /**
   * Euclidean distance in channel space, used to tell how far two animated colors are apart.
   */
  distance(other: Color): number {
    const dr = this.r - other.r;
    const dg = this.g - other.g;
    const db = this.b - other.b;
    const da = (this.a - other.a) * 255;
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
  }

  equals(other: Color): boolean {
    return this.r === other.r && this.g === other.g && this.b === other.b && this.a === other.a;
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
