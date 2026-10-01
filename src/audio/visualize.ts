/**
 * Per-frame audio spectrum, for `Frame.visualizeAudioFrame`.
 *
 * Port of `.source/fframes/fframes/src/audio_window_functions.rs` (the window functions) and of
 * `get_visualization` / `apply_fft_to_frame` from `audio_data.rs:76-159`, plus the temporal
 * smoothing of `frame.rs:212-228`, which lives in `core/frame.ts`.
 *
 * Importing this module installs {@link getVisualization} as the spectrum provider of
 * `Frame.visualizeAudioFrame`, so there is exactly one FFT in the project.
 *
 * The Rust port calls `microfft::real::rfft_N` for the ten power-of-two sizes from 2 to 1024; the
 * contract narrows the public surface to 256 and 512, and {@link fftRadix2} is a plain complex
 * transform, so the real-input shortcut is replaced by `n/2 + 1` bins taken from the front of the
 * spectrum. Bins, not full complex values, are what the visualisation consumes.
 */

import { setVisualizationResolver } from '../core/frame.ts';
import type { SampleSize, VisualizeFrameInput, WindowFunction } from '../core/types.ts';

export type { SampleSize, VisualizeFrameInput, WindowFunction };

/** The `n` coefficients of a window shape. */
function windowOfLength(n: number, shape: (index: number, length: number) => number): Float32Array {
  const window = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    window[i] = shape(i, n);
  }
  return window;
}

/**
 * `hann_window` / `hamming_window` / `blackman`.
 *
 * Two call shapes, because both readings of `hannWindow(n)` are useful:
 * - `hannWindow(256)` returns the 256 coefficients of the window,
 * - `hannWindow(samples)` multiplies `samples` by the window of their length and returns a new
 *   buffer.
 *
 * The Hann window is the periodic one, `0.5 * (1 - cos(2*PI*i/n))`, so its first sample is
 * exactly 0 and the last is not — that is the definition `audio_window_functions.rs` uses, and
 * changing it would shift the spectrum slightly.
 */
export function hannWindow(sizeOrSamples: number | ArrayLike<number>): Float32Array {
  const shape = (i: number, n: number): number => 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  if (typeof sizeOrSamples === 'number') {
    return windowOfLength(sizeOrSamples, shape);
  }
  return applyToSamples(sizeOrSamples, shape);
}

/**
 * `hamming_window` — `0.54 - 0.46 * cos(2*PI*i/(n-1))`.
 *
 * Note that the Rust source has `cosf(samples_len - 1.0)` where the formula needs
 * `cos(2*PI*i/(n-1))`; the port keeps the *definition* of a Hamming window, not that typo. See
 * DELIVERY.md.
 */
export function hammingWindow(sizeOrSamples: number | ArrayLike<number>): Float32Array {
  const shape = (i: number, n: number): number =>
    n > 1 ? 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)) : 0.08;
  if (typeof sizeOrSamples === 'number') {
    return windowOfLength(sizeOrSamples, shape);
  }
  return applyToSamples(sizeOrSamples, shape);
}

/** A Blackman window, the third `WindowFunction` variant; `0.42 - 0.5 cos + 0.08 cos(2x)`. */
export function blackmanWindow(sizeOrSamples: number | ArrayLike<number>): Float32Array {
  const shape = (i: number, n: number): number =>
    n > 1
      ? 0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (n - 1))
      : 0;
  if (typeof sizeOrSamples === 'number') {
    return windowOfLength(sizeOrSamples, shape);
  }
  return applyToSamples(sizeOrSamples, shape);
}

function applyToSamples(
  samples: ArrayLike<number>,
  shape: (index: number, length: number) => number,
): Float32Array {
  const n = samples.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = shape(i, n) * (samples[i] ?? 0);
  }
  return out;
}

/** `apply_window_function` — `'none'` passes the samples through. */
export function applyWindowFunction(
  window: WindowFunction,
  samples: ArrayLike<number>,
): Float32Array {
  switch (window) {
    case 'hann':
      return hannWindow(samples);
    case 'hamming':
      return hammingWindow(samples);
    case 'blackman':
      return blackmanWindow(samples);
    case 'none':
      return samples instanceof Float32Array ? samples.slice() : Float32Array.from(samples);
  }
}

/** Every `WindowFunction` variant. */
export const WINDOW_FUNCTIONS: readonly WindowFunction[] = [
  'hann',
  'hamming',
  'blackman',
  'none',
];

/**
 * `fftRadix2` — an in-place iterative Cooley-Tukey FFT.
 *
 * `re` and `im` must have the same power-of-two length; on return they hold the transform of the
 * input, with bin `k` at index `k` (so DC first, Nyquist at `n/2`).
 *
 * ```ts
 * const re = Float64Array.from(windowed);
 * const im = new Float64Array(re.length);
 * fftRadix2(re, im);
 * const magnitude = (k: number) => Math.hypot(re[k]!, im[k]!);
 * ```
 */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  if (re.length !== im.length) {
    throw new TypeError(
      `fftRadix2: real and imaginary parts must have the same length, got ${re.length} and ${im.length}`,
    );
  }
  const n = re.length;
  if (n === 0) {
    return;
  }
  if ((n & (n - 1)) !== 0) {
    throw new RangeError(`fftRadix2: length must be a power of two, got ${n}`);
  }

  // Bit reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k += 1) {
        const a = i + k;
        const b = a + half;
        const uRe = re[a] ?? 0;
        const uIm = im[a] ?? 0;
        const vSourceRe = re[b] ?? 0;
        const vSourceIm = im[b] ?? 0;
        const vRe = vSourceRe * wRe - vSourceIm * wIm;
        const vIm = vSourceRe * wIm + vSourceIm * wRe;
        re[a] = uRe + vRe;
        im[a] = uIm + vIm;
        re[b] = uRe - vRe;
        im[b] = uIm - vIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
}

/** The FFT window sizes {@link getVisualization} supports. */
export const SAMPLE_SIZES: readonly SampleSize[] = [256, 512];

/**
 * The `size` samples of `audio` that belong to `frame`, zero padded when the audio ends first.
 *
 * `PreloadedAudioData::get_frame_data` returns `None` in that case and the Rust port then FFTs an
 * all-zero buffer; the padding keeps the returned length the same either way.
 */
function frameSamples(audio: VisualizeFrameInput['audio'], size: number, frame: number, fps: number): Float32Array {
  const data = audio.getFrameData(size, frame, fps);
  if (data !== null && data.length === size) {
    return data;
  }
  const padded = new Float32Array(size);
  if (data !== null) {
    padded.set(data.subarray(0, Math.min(size, data.length)));
  }
  return padded;
}

/**
 * `get_visualization` — the magnitude spectrum of the audio around `frameIndex`.
 *
 * ```ts
 * import './src/audio/visualize.ts'; // installs the provider
 * const bars = new Frame(index, index, fps).visualizeAudioFrame({
 *   audio, sampleSize: 256, smoothLevel: 4, window: 'hann',
 * });
 * ```
 *
 * Returns `size / 2 + 1` magnitudes, the non-negative frequencies from DC to Nyquist. The real
 * coefficient the Rust port packs into the imaginary part of the DC bin is cleared first, so bin 0
 * is the true DC level.
 */
export function getVisualization(
  frameIndex: number,
  fps: number,
  input: VisualizeFrameInput,
): Float32Array {
  const size = input.sampleSize;
  const samples = frameSamples(input.audio, size, frameIndex, fps);
  const windowed =
    input.window === undefined ? samples : applyWindowFunction(input.window, samples);

  const re = Float64Array.from(windowed);
  const im = new Float64Array(size);
  fftRadix2(re, im);

  // The real-valued coefficient at the Nyquist frequency is packed into the imaginary part of the
  // DC bin by a real-input transform; clear it before computing the amplitudes.
  im[0] = 0;

  const bins = size / 2 + 1;
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k += 1) {
    out[k] = Math.hypot(re[k] ?? 0, im[k] ?? 0);
  }
  return out;
}

/**
 * `center_spectrum_low_frequencies` — moves the low frequencies to the middle so the bars can be
 * drawn left to right without an ear-splitting mirror in the middle.
 *
 * ```ts
 * const [1, 2, 3, 4, 5, 6, 7, 8] → [7, 5, 3, 1, 2, 4, 6, 8]
 * ```
 */
export function centerSpectrumLowFrequencies(spectrum: ArrayLike<number>): Float32Array {
  const pretty = new Float32Array(spectrum.length);
  const mid = Math.floor(spectrum.length / 2) - 1;
  for (let i = 0; i < spectrum.length; i += 1) {
    if (i < mid) {
      pretty[i] = spectrum[(mid - i) * 2] ?? 0;
    } else if (i === mid) {
      pretty[i] = spectrum[0] ?? 0;
    } else {
      pretty[i] = spectrum[(i - mid) * 2 - 1] ?? 0;
    }
  }
  return pretty;
}

// `Frame.visualizeAudioFrame` asks for the spectrum through the provider installed in
// `core/frame.ts`, so importing this module is all a video has to do.
setVisualizationResolver(getVisualization);
