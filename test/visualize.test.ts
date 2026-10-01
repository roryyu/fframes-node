/**
 * The per-frame spectrum: the radix-2 FFT, the window functions and `getVisualization`.
 *
 * Importing `../src/audio/visualize.ts` also installs the provider `Frame.visualizeAudioFrame`
 * uses, which the last test checks end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SAMPLE_SIZES,
  WINDOW_FUNCTIONS,
  applyWindowFunction,
  blackmanWindow,
  centerSpectrumLowFrequencies,
  fftRadix2,
  getVisualization,
  hammingWindow,
  hannWindow,
} from '../src/audio/visualize.ts';
import type { SampleSize, WindowFunction } from '../src/audio/visualize.ts';
import { DecodedAudio } from '../src/media/audio-decode.ts';
import { Frame } from '../src/core/frame.ts';

const RATE = 44100;

/** A cosine that sits exactly on FFT bin `bin` of a window of `size` samples. */
function binTone(bin: number, size: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    out[i] = amplitude * Math.cos((2 * Math.PI * bin * i) / size);
  }
  return out;
}

function spectrumOf(samples: Float32Array, window: WindowFunction | undefined): Float32Array {
  const padded = new Float32Array(samples.length);
  padded.set(samples);
  return getVisualization(0, 30, {
    audio: new DecodedAudio(padded, RATE),
    sampleSize: samples.length as SampleSize,
    smoothLevel: 0,
    window,
  });
}

function argmax(values: Float32Array): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] ?? 0) > (values[best] ?? 0)) best = i;
  }
  return best;
}

test('the supported window sizes are the ones the contract names', () => {
  assert.deepEqual([...SAMPLE_SIZES], [256, 512]);
  assert.deepEqual([...WINDOW_FUNCTIONS], ['hann', 'hamming', 'blackman', 'none']);
});

test('the Hann window is the periodic one, so it starts at exactly zero', () => {
  const hann = hannWindow(256);
  assert.equal(hann.length, 256);
  assert.equal(hann[0], 0, 'the first coefficient is exactly 0');
  assert.ok((hann[1] ?? 0) > 0);
  assert.ok((hann[128] ?? 0) > (hann[100] ?? 0), 'it rises to the middle');
  assert.ok(Math.abs((hann[128] ?? 0) - 1) < 1e-6, 'and peaks at 1');
  // Periodic: w[n] = w[N - n] and the last sample is not zero.
  assert.ok(Math.abs((hann[255] ?? 0) - 0.5 * (1 - Math.cos((2 * Math.PI * 255) / 256))) < 1e-6);
});

test('the window functions multiply the samples they are given', () => {
  const samples = new Float32Array(8).fill(2);
  const applied = hannWindow(samples);
  assert.equal(applied.length, 8);
  assert.equal(applied[0], 0);
  assert.equal(applied[1], (hannWindow(8)[1] ?? 0) * 2);
  assert.notEqual(applied, samples, 'a new buffer');
  assert.equal(samples[1], 2, 'the input is untouched');
});

test('hamming and blackman have the endpoints their definitions promise', () => {
  const hamming = hammingWindow(64);
  assert.ok(Math.abs((hamming[0] ?? 0) - 0.08) < 1e-6);
  assert.ok((hamming[32] ?? 0) > 0.99, 'close to 1 in the middle');
  assert.ok(Math.abs((hamming[63] ?? 0) - 0.08) < 1e-6, 'symmetric');

  const blackman = blackmanWindow(64);
  assert.ok(Math.abs((blackman[0] ?? 0) - 0) < 1e-6);
  assert.ok((blackman[32] ?? 0) > 0.99);

  assert.equal(hammingWindow(1).length, 1, 'a one sample window does not divide by zero');
  assert.equal(blackmanWindow(1).length, 1);
  // The coefficients live in a Float32Array, so they can not be bit-equal to the f64 literal.
  assert.ok(Math.abs((hammingWindow(1)[0] ?? 0) - 0.08) < 1e-6, '0.54 - 0.46 = 0.08');
  assert.ok(Math.abs((blackmanWindow(1)[0] ?? 0) - 0) < 1e-6, '0.42 - 0.5 + 0.08 = 0');
});

test('applyWindowFunction passes the samples through for none', () => {
  const samples = new Float32Array([1, -1, 0.5, -0.5, 0.25, 0, 0, 1]);
  const copy = applyWindowFunction('none', samples);
  assert.deepEqual([...copy], [...samples]);
  assert.notEqual(copy, samples);
  assert.deepEqual(
    [...applyWindowFunction('hann', samples)],
    [...hannWindow(samples)],
    'hann goes through the Hann window',
  );
});

test('a tone on an exact bin peaks in that bin with a rectangular window', () => {
  // With no window the DFT of a bin-centred cosine is exactly amplitude * size / 2 in that bin
  // and 0 everywhere else, so the peak bin is unambiguous.
  const spectrum = spectrumOf(binTone(3, 256), 'none');
  assert.equal(spectrum.length, 129, 'size / 2 + 1 bins');
  assert.equal(argmax(spectrum), 3);
  assert.ok(Math.abs((spectrum[3] ?? 0) - 64) < 0.01, `got ${String(spectrum[3])}`);
  for (let k = 0; k < spectrum.length; k += 1) {
    if (k === 3) continue;
    assert.ok((spectrum[k] ?? 0) < 0.01, `bin ${k} should be empty, got ${String(spectrum[k])}`);
  }

  // Omitting `window` means no windowing, so the same holds.
  assert.deepEqual([...spectrumOf(binTone(3, 256), undefined)], [...spectrum]);
});

test('a 440 Hz tone lands in the bin it belongs to, with a Hann window', () => {
  // 440 Hz at 44 100 Hz with a 256 sample window is bin 2.554, so the peak is bin 3.
  const size = 256;
  const samples = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    samples[i] = Math.cos((2 * Math.PI * 440 * i) / RATE);
  }
  const spectrum = spectrumOf(samples, 'hann');

  const peak = argmax(spectrum);
  const nearest = Math.round((440 * size) / RATE);
  assert.equal(nearest, 3);
  assert.ok(Math.abs(peak - nearest) <= 1, `peak bin ${peak}, nearest ${nearest}`);

  const mean = [...spectrum].reduce((sum, v) => sum + v, 0) / spectrum.length;
  assert.ok((spectrum[peak] ?? 0) > 4 * mean, 'the peak stands out from the rest');
});

test('the same happens for a 512 sample window', () => {
  const size = 512;
  const samples = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    samples[i] = 0.8 * Math.cos((2 * Math.PI * 1000 * i) / RATE);
  }
  const spectrum = spectrumOf(samples, 'none');
  assert.equal(spectrum.length, 257, 'size / 2 + 1 bins');

  const exact = spectrumOf(binTone(11, size), 'none');
  assert.equal(argmax(exact), 11);
  assert.ok(Math.abs((exact[11] ?? 0) - 0.5 * (size / 2)) < 0.01);

  const peak = argmax(spectrum);
  assert.ok(Math.abs(peak - Math.round((1000 * size) / RATE)) <= 1, `peak bin ${peak}`);
});

test('fftRadix2 puts a bin-centred tone in that bin and nothing else', () => {
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i += 1) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);

  fftRadix2(re, im);
  for (let k = 0; k < n; k += 1) {
    const magnitude = Math.hypot(re[k] ?? 0, im[k] ?? 0);
    if (k === 5 || k === n - 5) {
      assert.ok(Math.abs(magnitude - n / 2) < 1e-9, `bin ${k}: ${magnitude}`);
    } else {
      assert.ok(magnitude < 1e-9, `bin ${k} should be empty, got ${magnitude}`);
    }
  }
  // The transform of a real signal is conjugate symmetric.
  for (let k = 0; k < n; k += 1) {
    assert.ok(Math.abs((im[k] ?? 0) + (im[n - k] ?? 0)) < 1e-9, `bin ${k} is conjugate symmetric`);
  }
});

test('fftRadix2 of a constant signal is a spike at DC', () => {
  const n = 32;
  const re = new Float64Array(n).fill(1);
  const im = new Float64Array(n);
  fftRadix2(re, im);

  assert.ok(Math.abs((re[0] ?? 0) - n) < 1e-9);
  assert.equal(im[0], 0);
  for (let k = 1; k < n; k += 1) {
    assert.ok(Math.hypot(re[k] ?? 0, im[k] ?? 0) < 1e-9, `bin ${k}`);
  }
});

test('fftRadix2 validates its input', () => {
  const re = new Float64Array(4);
  const im = new Float64Array(4);
  fftRadix2(re, im);
  assert.deepEqual([...re], [0, 0, 0, 0], 'a no-op on zeros of length 4');
  assert.deepEqual([...im], [0, 0, 0, 0]);

  assert.throws(
    () => fftRadix2(new Float64Array(4), new Float64Array(8)),
    /same length/,
  );
  assert.throws(() => fftRadix2(new Float64Array(6), new Float64Array(6)), /power of two/);
  assert.doesNotThrow(() => fftRadix2(new Float64Array(0), new Float64Array(0)));
});

test('the DC bin is a real level, not a packed Nyquist coefficient', () => {
  // A signal with a real DC offset: the DC bin must read the offset, not zero.
  const samples = new Float32Array(256).fill(0.25);
  const spectrum = spectrumOf(samples, 'none');
  assert.ok(Math.abs((spectrum[0] ?? 0) - 64) < 0.01, `DC: ${String(spectrum[0])}`);
});

test('getVisualization reads the samples of the frame it is given', () => {
  // Silence for the first second, then a tone that sits exactly on bin 6 of a 256 sample window,
  // at 30 fps. 6 / 256 of 44 100 Hz is 1033.59375 Hz.
  const binSix = (6 * RATE) / 256;
  const samples = new Float32Array(RATE * 2);
  for (let i = RATE; i < samples.length; i += 1) {
    samples[i] = 0.5 * Math.cos((2 * Math.PI * binSix * i) / RATE);
  }
  const audio = new DecodedAudio(samples, RATE);
  const input = { audio, sampleSize: 256 as SampleSize, smoothLevel: 0, window: 'none' as const };

  const early = getVisualization(0, 30, input);
  assert.equal(early.length, 129);
  assert.ok(early.every((v) => v < 1e-6), 'silence gives an empty spectrum');

  // 30 fps, so frame 30 starts at sample 44 100 — exactly where the tone begins.
  const late = getVisualization(30, 30, input);
  assert.equal(argmax(late), 6);
  assert.ok(Math.abs((late[6] ?? 0) - 64) < 0.01, `got ${String(late[6])}`);

  const oneFrameLater = getVisualization(31, 30, input);
  assert.equal(argmax(oneFrameLater), 6, 'the tone keeps going');
});

test('getVisualization zero pads past the end of the audio', () => {
  const audio = new DecodedAudio(binTone(4, 256, 0.5), RATE);
  const input = { audio, sampleSize: 256 as SampleSize, smoothLevel: 0, window: 'none' as const };

  assert.equal(argmax(getVisualization(0, 30, input)), 4);
  const past = getVisualization(30, 30, input);
  assert.equal(past.length, 129, 'the bin count does not change');
  assert.ok(past.every((v) => v === 0), 'and everything is zero past the end');
});

test('Frame.visualizeAudioFrame uses the provider this module installs', () => {
  // 30 fps, 256 sample windows: frame 0 is silence and frame 30 starts the bin-six tone.
  const binSix = (6 * RATE) / 256;
  const samples = new Float32Array(RATE * 2);
  for (let i = RATE; i < samples.length; i += 1) {
    samples[i] = 0.5 * Math.cos((2 * Math.PI * binSix * i) / RATE);
  }
  const input = {
    audio: new DecodedAudio(samples, RATE),
    sampleSize: 256 as SampleSize,
    smoothLevel: 2,
    window: 'none' as const,
  };

  const quiet = new Frame(0, 0, 30).visualizeAudioFrame(input);
  assert.equal(quiet.length, 129);
  assert.ok(quiet.every((v) => v < 1e-6), 'the first frames are silence');

  // smooth_level 2 averages frames 28..31; 28 and 29 are silent, 30 and 31 are the tone.
  const loud = new Frame(30, 30, 30).visualizeAudioFrame(input);
  assert.ok((loud[6] ?? 0) > 1, `the tone is there: ${String(loud[6])}`);

  const single = getVisualization(30, 30, input);
  assert.notDeepEqual([...loud], [...single], 'the smoothing really smooths');
  assert.ok((single[6] ?? 0) > (loud[6] ?? 0), 'and it lowers the peak');
});

test('centerSpectrumLowFrequencies mirrors the low frequencies', () => {
  // The Rust test `test_prettify_spectrum`.
  assert.deepEqual(
    [...centerSpectrumLowFrequencies(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]))],
    [7, 5, 3, 1, 2, 4, 6, 8],
  );
  assert.deepEqual([...centerSpectrumLowFrequencies(new Float32Array([9, 9]))], [9, 9]);
});
