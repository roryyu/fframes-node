/**
 * SVG transform attribute value that can be interpolated by a timeline.
 *
 * Port of `.source/fframes/fframes/src/transform.rs`.
 *
 * Like the Rust original, a `Transform` holds a single matrix: it does not keep a list of
 * operations, and the serialization order is fixed — `translate -> rotate -> scale -> skewX ->
 * skewY`. Use the string based `transform="..."` attribute when several operations are needed.
 */

/** Rotation in degrees, with an optional origin (the SVG `rotate(a cx cy)` form). */
export class Rotate {
  readonly angle: number;
  readonly origin: readonly [number, number] | null;

  constructor(angle: number, origin: readonly [number, number] | null = null) {
    this.angle = angle;
    this.origin = origin;
  }

  interpolate(to: Rotate, progress: number): Rotate {
    return new Rotate(
      this.angle + (to.angle - this.angle) * progress,
      this.origin ?? to.origin,
    );
  }
}

/** Non-uniform scale, `x` and `y` default to `1`. */
export class Scale {
  readonly x: number;
  readonly y: number;

  constructor(x: number = 1, y: number = x) {
    this.x = x;
    this.y = y;
  }

  interpolate(to: Scale, progress: number): Scale {
    return new Scale(
      this.x + (to.x - this.x) * progress,
      this.y + (to.y - this.y) * progress,
    );
  }
}

/** How many decimals a serialized number keeps. */
const NUMBER_PRECISION = 6;

function number(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const text = value.toFixed(NUMBER_PRECISION).replace(/\.?0+$/, '');
  return text === '' || text === '-' ? '0' : text;
}

export class Transform {
  readonly translateX: number;
  readonly translateY: number;
  readonly rotate: Rotate;
  readonly scale: Scale;
  readonly skewX: number;
  readonly skewY: number;

  constructor(
    translateX: number = 0,
    translateY: number = 0,
    rotate: Rotate = new Rotate(0),
    scale: Scale = new Scale(),
    skewX: number = 0,
    skewY: number = 0,
  ) {
    this.translateX = translateX;
    this.translateY = translateY;
    this.rotate = rotate;
    this.scale = scale;
    this.skewX = skewX;
    this.skewY = skewY;
  }

  /** `Transform::default()` — the identity transform. */
  static identity(): Transform {
    return new Transform();
  }

  /** `Transform::translate(x, y)` */
  static translate(x: number, y: number): Transform {
    return new Transform(x, y);
  }

  /** `Transform::scale(factor)` or `Transform::scale(sx, sy)`. */
  static scale(sx: number, sy?: number): Transform {
    return new Transform(0, 0, new Rotate(0), new Scale(sx, sy ?? sx));
  }

  /** `Transform::rotate(angle)` in degrees, optionally around `origin`. */
  static rotate(angle: number, origin?: readonly [number, number]): Transform {
    return new Transform(0, 0, new Rotate(angle, origin ?? null));
  }

  /** `Transform::skew(x, y)` in degrees. */
  static skew(x: number, y: number): Transform {
    return new Transform(0, 0, new Rotate(0), new Scale(), x, y);
  }

  /**
   * Combines two transforms into a new one, offsetting translations, adding rotations and
   * multiplying scales. The origin of the left transform wins.
   */
  then(other: Transform): Transform {
    return new Transform(
      this.translateX + other.translateX,
      this.translateY + other.translateY,
      new Rotate(this.rotate.angle + other.rotate.angle, this.rotate.origin ?? other.rotate.origin),
      new Scale(this.scale.x * other.scale.x, this.scale.y * other.scale.y),
      this.skewX + other.skewX,
      this.skewY + other.skewY,
    );
  }

  /**
   * The value for the SVG `transform` attribute, e.g. `translate(10 20) rotate(45) scale(2)`.
   *
   * Operations are serialized in the same order the Rust implementation composes them —
   * `translate -> rotate -> scale -> skewX -> skewY` — and the ones at their default are omitted.
   * A uniform scale is serialized with a single argument.
   */
  toSvgAttribute(): string {
    const parts: string[] = [];

    if (this.translateX !== 0 || this.translateY !== 0) {
      parts.push(`translate(${number(this.translateX)} ${number(this.translateY)})`);
    }

    if (this.rotate.angle !== 0) {
      const origin = this.rotate.origin;
      parts.push(
        origin
          ? `rotate(${number(this.rotate.angle)} ${number(origin[0])} ${number(origin[1])})`
          : `rotate(${number(this.rotate.angle)})`,
      );
    }

    if (this.scale.x !== 1 || this.scale.y !== 1) {
      parts.push(
        this.scale.x === this.scale.y
          ? `scale(${number(this.scale.x)})`
          : `scale(${number(this.scale.x)} ${number(this.scale.y)})`,
      );
    }

    if (this.skewX !== 0) {
      parts.push(`skewX(${number(this.skewX)})`);
    }

    if (this.skewY !== 0) {
      parts.push(`skewY(${number(this.skewY)})`);
    }

    return parts.join(' ');
  }

  /** `impl Animatable for Transform` — every component blended linearly. */
  interpolate(to: Transform, progress: number): Transform {
    return new Transform(
      this.translateX + (to.translateX - this.translateX) * progress,
      this.translateY + (to.translateY - this.translateY) * progress,
      this.rotate.interpolate(to.rotate, progress),
      this.scale.interpolate(to.scale, progress),
      this.skewX + (to.skewX - this.skewX) * progress,
      this.skewY + (to.skewY - this.skewY) * progress,
    );
  }

  /** Euclidean distance between the two transforms, over every component. */
  distance(other: Transform): number {
    const parts = [
      this.translateX - other.translateX,
      this.translateY - other.translateY,
      this.rotate.angle - other.rotate.angle,
      this.scale.x - other.scale.x,
      this.scale.y - other.scale.y,
      this.skewX - other.skewX,
      this.skewY - other.skewY,
    ];
    return Math.sqrt(parts.reduce((sum, part) => sum + part * part, 0));
  }

  /** Same as {@link Transform.toSvgAttribute}, so `String(transform)` works in a template. */
  toString(): string {
    return this.toSvgAttribute();
  }

  equals(other: Transform): boolean {
    return (
      this.translateX === other.translateX &&
      this.translateY === other.translateY &&
      this.rotate.angle === other.rotate.angle &&
      this.scale.x === other.scale.x &&
      this.scale.y === other.scale.y &&
      this.skewX === other.skewX &&
      this.skewY === other.skewY
    );
  }
}
