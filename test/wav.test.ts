/**
 * The WAV writer and reader: RIFF headers, 16-bit PCM with dither, 32-bit float with a `fact`
 * chunk, and the sample round trip.
 *
 * The header expectations are the Rust tests `audio_analysis.rs:483-497`; the files land in the
 * OS temp directory, never in the repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TpdfDither,
  WAVE_FORMAT_IEEE_FLOAT,
  WAVE_FORMAT_PCM,
  encodeWav,
  encodeWavInterleaved,
  fromInt16,
  parseWavHeader,
  readWav,
  readWavHeader,
  toInt16,
  writeWav,
  writeWavSync,
} from '../src/audio/wav.ts';

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'fframes-wav-')), name);
}

test('the format tags are the WAV ones', () => {
  assert.equal(WAVE_FORMAT_PCM, 1);
  assert.equal(WAVE_FORMAT_IEEE_FLOAT, 3);
});

test('a zero sample mix is a valid WAVE, not a missing chunk', () => {
  // `writeWavSync` parses its own output, and `parseWavHeader` used to reject `dataSize === 0` —
  // which is a legal WAVE (`fmt ` plus an empty `data` chunk). A zero sample render (`seconds(0)`)
  // therefore failed on write-back with "has no data chunk".
  const file = tempFile('empty.wav');
  const header = writeWavSync(file, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    data: new Float32Array(0),
  });
  assert.equal(header.frames, 0);
  assert.equal(header.dataSize, 0);
  assert.equal(header.channels, 2);

  const readBack = readWavHeader(file);
  assert.equal(readBack.frames, 0);
  assert.equal(readBack.dataSize, 0);
  assert.equal(readBack.sampleRate, 48000);
  assert.equal(readBack.formatTag, WAVE_FORMAT_PCM);
  assert.deepEqual([...readWav(file).samples], []);
});

test('a WAVE with no data chunk at all is still rejected', () => {
  // The fix above changed the *criterion* (chunk absent, not chunk empty); a file that genuinely has
  // no `data` chunk must keep failing. The 16-bit layout is fixed — `fmt ` occupies 12..35, so the
  // `data` chunk starts at 36 — which is why the chunks are cut out by offset rather than by
  // searching for a magic string that could also occur in sample bytes.
  const twoFrames = encodeWavInterleaved({
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    data: new Float32Array([0.5, -0.5]),
  });
  assert.equal(twoFrames.toString('latin1', 36, 40), 'data', 'the data chunk is where this says');

  // The RIFF/WAVE preamble and the `fmt ` chunk, with nothing after it.
  const withoutData = cut(twoFrames, [0, 36]);
  assert.throws(() => parseWavHeader(withoutData), /has no data chunk/);

  // The preamble and the `data` chunk, with the format chunk missing.
  const withoutFmt = cut(twoFrames, [0, 12], [36, twoFrames.length]);
  assert.throws(() => parseWavHeader(withoutFmt), /has no fmt chunk/);
});

/** `parts` of `source` concatenated, with the RIFF size fixed up so the header still reads. */
function cut(source: Buffer, ...keep: [number, number][]): Buffer {
  const out = Buffer.concat(keep.map(([from, to]) => source.subarray(from, to)));
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

test('a 16-bit stereo file has a 44 byte header and a correct RIFF size', () => {
  // audio_analysis.rs:484-491 — 2 frames of stereo 16-bit.
  const bytes = encodeWav({ left: [0.5, -0.5], right: [0, 1], sampleRate: 44100, float: false });

  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF');
  assert.equal(bytes.toString('latin1', 8, 12), 'WAVE');
  assert.equal(bytes.toString('latin1', 12, 16), 'fmt ');
  assert.equal(bytes.toString('latin1', 36, 40), 'data');
  assert.equal(bytes.length, 44 + 8);

  const header = parseWavHeader(bytes);
  assert.equal(header.riffSize, bytes.length - 8);
  assert.equal(header.fmtSize, 16);
  assert.equal(header.formatTag, WAVE_FORMAT_PCM);
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 44100);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.blockAlign, 4, '2 channels of 2 bytes');
  assert.equal(header.byteRate, 44100 * 4);
  assert.equal(header.dataOffset, 44);
  assert.equal(header.dataSize, 8);
  assert.equal(header.frames, 2);
  assert.equal(header.float, false);
});

test('a 32-bit float file has the 18 byte fmt chunk and a fact chunk', () => {
  // audio_analysis.rs:492-497 — 1 frame of stereo float.
  const bytes = encodeWav({ left: [0.5], right: [0.25], sampleRate: 48000, float: true });

  assert.equal(bytes.length, 58 + 8);
  const header = parseWavHeader(bytes);
  assert.equal(header.formatTag, WAVE_FORMAT_IEEE_FLOAT);
  assert.equal(header.fmtSize, 18);
  assert.equal(header.bitsPerSample, 32);
  assert.equal(header.blockAlign, 8);
  assert.equal(header.byteRate, 48000 * 8);
  assert.equal(header.frames, 1);
  assert.equal(header.dataOffset, 58);
  assert.equal(header.dataSize, 8);
  assert.equal(header.float, true);
  assert.equal(bytes.readFloatLE(58), 0.5, 'the first sample is the left one');
  assert.equal(bytes.readFloatLE(62), 0.25);
});

test('a fact chunk declares the frame count', () => {
  const bytes = encodeWav({ left: new Array<number>(7).fill(0), right: new Array<number>(7).fill(0), sampleRate: 8000, float: true });
  assert.equal(bytes.toString('latin1', 38, 42), 'fact');
  assert.equal(bytes.readUInt32LE(42), 4, 'the fact chunk body is 4 bytes');
  assert.equal(bytes.readUInt32LE(46), 7);
  assert.equal(parseWavHeader(bytes).frames, 7);
});

test('the dither is deterministic, so a render is reproducible', () => {
  const first = encodeWav({ left: [0.25], right: [0.25], sampleRate: 44100, float: false });
  const second = encodeWav({ left: [0.25], right: [0.25], sampleRate: 44100, float: false });
  assert.deepEqual(first, second, 'the same input gives the same bytes');

  const dither = new TpdfDither(1234);
  const values = [dither.uniform(), dither.uniform(), dither.uniform()];
  assert.ok(values.every((v) => v >= 0 && v <= 1));
  const other = new TpdfDither(1234);
  assert.equal(other.uniform(), values[0], 'the same seed gives the same stream');
  assert.notEqual(new TpdfDither(4321).uniform(), values[0]);
  for (let i = 0; i < 64; i += 1) {
    const value = new TpdfDither(1).next();
    assert.ok(value > -1 && value < 1, 'TPDF dither is one LSB peak to peak');
  }
});

test('16-bit samples round trip to within one LSB', () => {
  // Values that are exact multiples of 1/32767, so the only error is the dither.
  const exact = [
    1000 / 32767,
    -2000 / 32767,
    32767 / 32767,
    -32767 / 32767,
    0,
  ];
  const interleaved = new Float32Array(exact.length * 2);
  for (let i = 0; i < exact.length; i += 1) {
    interleaved[i * 2] = exact[i] ?? 0;
    interleaved[i * 2 + 1] = exact[i] ?? 0;
  }

  const path = tempFile('exact.wav');
  const header = writeWavSync(path, {
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    data: interleaved,
    dither: false,
  });
  assert.equal(header.formatTag, WAVE_FORMAT_PCM);

  const back = readWav(path);
  assert.equal(back.header.sampleRate, 44100);
  assert.equal(back.header.channels, 2);
  for (let i = 0; i < exact.length; i += 1) {
    const expected = exact[i] ?? 0;
    const got = back.samples[i * 2] ?? 0;
    assert.ok(
      Math.abs(got * 32767 - expected * 32767) <= 1,
      `sample ${i}: ${got} vs ${expected} (${Math.abs(got * 32767 - expected * 32767)} LSB)`,
    );
  }
});

test('the 16-bit dither stays inside one and a half LSB', () => {
  const values = new Float32Array(512);
  for (let i = 0; i < values.length; i += 1) values[i] = Math.sin(i / 7) * 0.9;

  const path = tempFile('dithered.wav');
  writeWavSync(path, { sampleRate: 44100, channels: 1, bitDepth: 16, data: values });
  const back = readWav(path);

  let worst = 0;
  for (let i = 0; i < values.length; i += 1) {
    worst = Math.max(worst, Math.abs((back.samples[i] ?? 0) - (values[i] ?? 0)) * 32767);
  }
  assert.ok(worst <= 1.5, `worst error ${worst} LSB`);
});

test('32-bit float keeps the samples exactly, including above full scale', () => {
  const values = new Float32Array([0.5, -0.5, 1.25, -1.25, 1e-7, 0]);
  const path = tempFile('float.wav');
  writeWavSync(path, { sampleRate: 96000, channels: 1, bitDepth: 32, data: values });

  const back = readWav(path);
  assert.equal(back.header.formatTag, WAVE_FORMAT_IEEE_FLOAT);
  for (let i = 0; i < values.length; i += 1) {
    assert.equal(back.samples[i], values[i], `sample ${i}`);
  }
});

test('a mono file has blockAlign 2 and one channel', () => {
  const path = tempFile('mono.wav');
  const header = writeWavSync(path, {
    sampleRate: 22050,
    channels: 1,
    bitDepth: 16,
    data: new Float32Array(100),
    dither: false,
  });
  assert.equal(header.channels, 1);
  assert.equal(header.blockAlign, 2);
  assert.equal(header.byteRate, 22050 * 2);
  assert.equal(header.dataSize, 200);
  assert.equal(header.frames, 100);
});

test('readWavHeader reads a file written by hand', () => {
  // A 16-bit mono file with one frame of 16384, the largest positive int16.
  const path = tempFile('hand.wav');
  const bytes = encodeWavInterleaved({
    sampleRate: 8000,
    channels: 1,
    bitDepth: 16,
    data: new Float32Array([16384 / 32767]),
    dither: false,
  });
  writeFileSync(path, bytes);

  const header = readWavHeader(path);
  assert.equal(header.sampleRate, 8000);
  assert.equal(header.channels, 1);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.riffSize, statSync(path).size - 8);
  assert.equal(toInt16(16384 / 32767), 16384);
  assert.equal(fromInt16(16384), 16384 / 32767);
});

test('writeWav is the promise flavour and reports the header it wrote', async () => {
  const path = tempFile('async.wav');
  const header = await writeWav(path, {
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    data: new Float32Array(8),
    dither: false,
  });
  assert.equal(header.formatTag, WAVE_FORMAT_PCM);
  assert.equal(readFileSync(path).length, 44 + 16);
  assert.equal(readWav(path).samples.length, 8);
});

test('int16 conversion clamps instead of wrapping', () => {
  assert.equal(toInt16(0), 0);
  assert.equal(toInt16(1), 32767);
  assert.equal(toInt16(-1), -32767);
  assert.equal(toInt16(2), 32767, 'clamped high');
  // audio_analysis.rs:406 — `(sample * 32767 + dither).round().clamp(-32768., 32767.)`. The two
  // bounds are asymmetric, so -1.0 saturates to -32768, not to -32767.
  assert.equal(toInt16(-2), -32768, 'clamped low');
  assert.equal(toInt16(0.5 / 32767), 1, 'rounded to the nearest LSB');
  assert.equal(toInt16(-0.5 / 32767), -1, 'and away from zero on the negative side');
  // The write path clamps the same way, so a sample above full scale never wraps either.
  assert.equal(fromInt16(toInt16(-2)), -32768 / 32767, 'below -1, as the asymmetric scale implies');
});

test('encoding rejects an impossible channel count', () => {
  assert.throws(
    () =>
      encodeWavInterleaved({
        sampleRate: 44100,
        channels: 0,
        bitDepth: 16,
        data: new Float32Array(4),
      }),
    /channels must be >= 1/,
  );
});

test('reading something that is not a WAV throws instead of returning garbage', () => {
  const path = tempFile('not-a-wav.bin');
  writeFileSync(path, Buffer.from('this is not a RIFF file at all, not even close', 'latin1'));
  assert.throws(() => readWavHeader(path), /not a RIFF file/);

  const wave = tempFile('riff-but-not-wave.bin');
  const bytes = Buffer.alloc(64);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(56, 4);
  bytes.write('AVI ', 8, 'latin1');
  writeFileSync(wave, bytes);
  assert.throws(() => readWavHeader(wave), /not a WAVE/);

  const noFmt = tempFile('no-fmt.wav');
  const plain = Buffer.alloc(48);
  plain.write('RIFF', 0, 'latin1');
  plain.writeUInt32LE(40, 4);
  plain.write('WAVE', 8, 'latin1');
  plain.write('data', 36, 'latin1');
  plain.writeUInt32LE(4, 40);
  writeFileSync(noFmt, plain);
  assert.throws(() => readWavHeader(noFmt), /no fmt chunk/);
});
