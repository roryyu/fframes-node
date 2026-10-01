/**
 * Kaiser-windowed sinc resampling.
 *
 * Port of `SincResampler` from `.source/fframes/fframes/src/audio_mix.rs:78-156`, the only
 * resampler the mixer uses when a file's sample rate differs from the output rate.
 *
 * The filter is built once as a polyphase table: `RESAMPLE_PHASES + 1` rows of `2 * half` taps,
 * each row normalized to unity DC gain. Sampling then picks the two neighbouring rows and
 * interpolates between them, so a resample costs one multiply-add per tap and no trigonometry.
 *
 * When downsampling, the cutoff drops to 95% of the output Nyquist so nothing above it aliases.
 */

/** `SincResampler::ZERO_CROSSINGS` — sinc lobes on each side of the centre tap. */
export const ZERO_CROSSINGS = 8;

/** `SincResampler::PHASES` — fractional positions per output sample in the polyphase table. */
export const RESAMPLE_PHASES = 256;

/** `SincResampler::KAISER_BETA` — Kaiser window shape, ~ -70 dB sidelobes. */
export const KAISER_BETA = 8.6;

/**
 * `bessel_i0` — modified Bessel function of the first kind, order 0 (for the Kaiser window).
 *
 * The series `sum_{k} (x/2)^{2k} / k!` stops when a term falls below `sum * 1e-12`, exactly like
 * the Rust implementation, so the window is bit-for-bit the same.
 */
export function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 50; k += 1) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-12) {
      break;
    }
  }
  return sum;
}

/**
 * `SincResampler` — a polyphase table of a Kaiser-windowed sinc low-pass.
 *
 * The cutoff drops to the output Nyquist when downsampling, so nothing above it aliases.
 */
export class SincResampler {
  /** Half the filter length in source samples. */
  readonly half: number;
  /** Number of fractional phases in the table. */
  readonly phases: number;
  /** Cutoff as a fraction of the source Nyquist, `0.95` of the output rate when downsampling. */
  readonly cutoff: number;

  private readonly taps: number;
  private readonly table: Float32Array;

  constructor(sourceRate: number, outputRate: number) {
    if (!(sourceRate > 0) || !(outputRate > 0)) {
      throw new RangeError(
        `SincResampler: rates must be positive, got sourceRate=${sourceRate}, outputRate=${outputRate}`,
      );
    }
    this.cutoff = Math.min(outputRate / sourceRate, 1) * 0.95;
    this.half = Math.ceil(ZERO_CROSSINGS / this.cutoff);
    this.phases = RESAMPLE_PHASES;
    this.taps = 2 * this.half;

    const norm = besselI0(KAISER_BETA);
    this.table = new Float32Array((this.phases + 1) * this.taps);

    for (let p = 0; p <= this.phases; p += 1) {
      const frac = p / this.phases;
      const rowStart = p * this.taps;
      for (let j = 0; j < this.taps; j += 1) {
        // Distance between the interpolated position and source sample `floor + k`.
        const k = j - this.half + 1;
        const d = k - frac;
        const v = d / this.half;
        const window = Math.abs(v) < 1 ? besselI0(KAISER_BETA * Math.sqrt(1 - v * v)) / norm : 0;
        const x = this.cutoff * d;
        const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        this.table[rowStart + j] = this.cutoff * sinc * window;
      }
      // Unity DC gain for every phase.
      let sum = 0;
      for (let j = 0; j < this.taps; j += 1) {
        sum += this.table[rowStart + j] ?? 0;
      }
      if (Math.abs(sum) > 1e-9) {
        for (let j = 0; j < this.taps; j += 1) {
          this.table[rowStart + j] = (this.table[rowStart + j] ?? 0) / sum;
        }
      }
    }
  }

  /**
   * `SincResampler::sample` — the value of `samples` at the fractional position `t`.
   *
   * Positions outside the buffer contribute nothing, so the filter edge is a fade rather than a
   * discontinuity.
   */
  sample(samples: Float32Array, t: number): number {
    const base = Math.floor(t);
    const frac = t - base;
    const p = frac * this.phases;
    const p0 = Math.min(Math.floor(p), this.phases - 1);
    const w = p - p0;
    const row0 = p0 * this.taps;
    const row1 = (p0 + 1) * this.taps;

    let acc = 0;
    for (let j = 0; j < this.taps; j += 1) {
      const index = base + j - this.half + 1;
      if (index >= 0 && index < samples.length) {
        const c0 = this.table[row0 + j] ?? 0;
        const c1 = this.table[row1 + j] ?? 0;
        acc += (samples[index] ?? 0) * (c0 + (c1 - c0) * w);
      }
    }
    return acc;
  }
}

/** A resampler built once per rate pair, since the polyphase table is expensive. */
const resamplerCache = new Map<string, SincResampler>();

/** The shared {@link SincResampler} for a rate pair. */
export function getResampler(fromRate: number, toRate: number): SincResampler {
  const key = `${fromRate}->${toRate}`;
  const cached = resamplerCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const resampler = new SincResampler(fromRate, toRate);
  resamplerCache.set(key, resampler);
  return resampler;
}

/** The output length {@link resample} produces for a given input length. */
export function resampledLength(inputLength: number, fromRate: number, toRate: number): number {
  return Math.round((inputLength * toRate) / fromRate);
}

/**
 * `SincResampler` applied to a whole buffer.
 *
 * ```ts
 * // 1 kHz tone at 48 kHz, for a 44.1 kHz output
 * const at44100 = resample(tone, 48000, 44100);
 * ```
 *
 * Output sample `i` reads the input at `i * fromRate / toRate` (the same `ratio` the mixer uses),
 * and the length is `round(input.length * toRate / fromRate)`.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) {
    return input.slice();
  }
  const output = new Float32Array(resampledLength(input.length, fromRate, toRate));
  if (output.length === 0) {
    return output;
  }
  const resampler = getResampler(fromRate, toRate);
  const ratio = fromRate / toRate;
  for (let i = 0; i < output.length; i += 1) {
    output[i] = resampler.sample(input, i * ratio);
  }
  return output;
}
