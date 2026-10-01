/**
 * Writing and reading WAV files.
 *
 * Port of `encode_wav` from `.source/fframes/fframes/src/audio_analysis.rs:357-412`, with the
 * signature the contract asks for: interleaved samples in, a file on disk out.
 *
 * Two encodings, both of which ffmpeg and every audio editor read:
 * - 16-bit PCM (format tag 1) with TPDF dither, so the mix does not quantize to a grid,
 * - 32-bit IEEE float (format tag 3), which keeps levels above full scale.
 *
 * The float variant uses the 18-byte `fmt ` chunk plus a `fact` chunk (58 bytes of header)
 * rather than the common 16-byte one, because a 2-channel float file with a 16-byte `fmt ` and
 * no `fact` is not read by every decoder.
 */

import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

/** `WAVE_FORMAT_PCM` */
export const WAVE_FORMAT_PCM = 1;

/** `WAVE_FORMAT_IEEE_FLOAT` */
export const WAVE_FORMAT_IEEE_FLOAT = 3;

/** Bit depths {@link writeWav} accepts. */
export type WavBitDepth = 16 | 32;

/** The parsed RIFF/WAVE header. */
export interface WavHeader {
  /** Bytes after the `RIFF` + size field, i.e. `fileSize - 8`. */
  readonly riffSize: number;
  /** Size of the `fmt ` chunk body, `16` or `18`. */
  readonly fmtSize: number;
  /** `1` = PCM, `3` = IEEE float. */
  readonly formatTag: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
  /** Number of frames (samples per channel). */
  readonly frames: number;
  /** Offset of the first data byte in the file. */
  readonly dataOffset: number;
  readonly dataSize: number;
  /** `true` for 32-bit float, the only case with a `fact` chunk. */
  readonly float: boolean;
}

/**
 * `f64::round` — halfway cases go **away from zero**.
 *
 * `Math.round` rounds halves towards `+Infinity`, so `Math.round(-0.5)` is `-0` where Rust's
 * `(-0.5f64).round()` is `-1.0`. The two differ on exactly the negative ties, which is where the
 * Rust 16-bit writer is (`audio_analysis.rs:406`), so the tie rule has to match.
 */
function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

/**
 * Converts one sample to a clamped `int16` LSB value.
 *
 * `audio_analysis.rs:406` — `(sample * 32767 + dither).round().clamp(-32768, 32767)`.
 */
export function toInt16(sample: number): number {
  return Math.min(32767, Math.max(-32768, roundHalfAwayFromZero(sample * 32767)));
}

/** One `int16` LSB back to a sample in `-1..1`. */
export function fromInt16(value: number): number {
  return value / 32767;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * A deterministic TPDF dither source: two uniform values from a xorshift generator.
 *
 * Deterministic on purpose — the same mix always produces the same bytes, so a render is
 * reproducible and a test can assert an exact value.
 */
export class TpdfDither {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  /** One uniform value in `[0, 1]`. */
  uniform(): number {
    this.state = (this.state ^ (this.state << 13)) >>> 0;
    this.state = (this.state ^ (this.state >>> 17)) >>> 0;
    this.state = (this.state ^ (this.state << 5)) >>> 0;
    return this.state / 0xffffffff;
  }

  /** One TPDF dither value in `(-1, 1)`. */
  next(): number {
    return this.uniform() - this.uniform();
  }
}

export interface EncodeWavOptions {
  readonly left: ArrayLike<number>;
  readonly right?: ArrayLike<number> | null;
  /**
   * `1` writes a mono file from `left` alone, `2` (the default, the shape of the Rust
   * `encode_wav(left, right, ..)`) interleaves `left` and `right`.
   */
  readonly channels?: number;
  readonly sampleRate: number;
  /** `false` writes 16-bit PCM, `true` writes 32-bit IEEE float. */
  readonly float?: boolean;
  /** TPDF dither for the 16-bit path, on by default. */
  readonly dither?: boolean;
  readonly ditherSeed?: number;
}

interface RiffOptions {
  readonly channels: number;
  readonly frames: number;
  readonly sampleRate: number;
  readonly float: boolean;
  readonly dither: boolean;
  readonly ditherSeed: number | undefined;
  /** The sample of `frame` on `channel`, in `-1..1` (or above, for float). */
  readonly sampleAt: (frame: number, channel: number) => number;
}

/**
 * The RIFF/WAVE bytes of one file, byte for byte `audio_analysis.rs:359-412`.
 *
 * One encoder serves both entry points so the header layout can not drift between them:
 * 16-bit PCM is a 16-byte `fmt ` (tag 1, `blockAlign = channels * 2`) and 32-bit float is the
 * 18-byte `fmt ` (tag 3, `cbSize = 0`) plus a 12-byte `fact` chunk carrying the frame count, so
 * the float data starts at byte 58 rather than 44.
 */
function encodeRiff(options: RiffOptions): Buffer {
  const channels = options.channels;
  const frames = options.frames;
  const float = options.float;
  const bytesPerSample = float ? 4 : 2;
  const dataLength = frames * channels * bytesPerSample;

  const fmtLength = float ? 18 : 16;
  const factLength = float ? 12 : 0;
  const riffLength = 4 + (8 + fmtLength) + factLength + 8 + dataLength;
  // 20 bytes of RIFF/WAVE/fmt preamble, the fmt body, the optional fact chunk, the data header.
  const headerLength = 20 + fmtLength + factLength + 8;

  const buffer = Buffer.allocUnsafe(headerLength + dataLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, riffLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, fmtLength, true);
  view.setUint16(20, float ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, options.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);

  let offset = 36;
  if (float) {
    // cbSize, the 18-byte fmt chunk says "no extension".
    view.setUint16(36, 0, true);
    offset = 38;
    writeAscii(view, offset, 'fact');
    view.setUint32(offset + 4, 4, true);
    // The fact body is the 4-byte frame count, right after its own size field.
    view.setUint32(offset + 8, frames, true);
    offset += 12;
  }

  writeAscii(view, offset, 'data');
  view.setUint32(offset + 4, dataLength, true);
  offset += 8;

  const dither = options.dither ? new TpdfDither(options.ditherSeed) : null;
  for (let i = 0; i < frames; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = options.sampleAt(i, channel);
      if (float) {
        view.setFloat32(offset, sample, true);
        offset += 4;
      } else {
        const noise = dither === null ? 0 : dither.next();
        // `(sample * 32767 + dither).round().clamp(-32768, 32767)`, audio_analysis.rs:406. The
        // rounding is the same tie rule as `toInt16` (away from zero, like Rust's `f64::round`).
        const value = Math.min(32767, Math.max(-32768, roundHalfAwayFromZero(sample * 32767 + noise)));
        view.setInt16(offset, value, true);
        offset += 2;
      }
    }
  }

  return buffer;
}

/**
 * `encode_wav` — channel samples as the bytes of a WAV file.
 *
 * The buffer is the whole file, so it can be piped straight into ffmpeg. `channels` defaults to
 * `2`, the shape the Rust `encode_wav` always writes; pass `1` for a mono file.
 */
export function encodeWav(options: EncodeWavOptions): Buffer {
  const channels = options.channels ?? 2;
  if (channels < 1) {
    throw new RangeError(`encodeWav: channels must be >= 1, got ${channels}`);
  }
  const left = options.left;
  const right = options.right ?? left;
  const frames = Math.min(left.length, right.length);
  return encodeRiff({
    channels,
    frames,
    sampleRate: options.sampleRate,
    float: options.float === true,
    dither: options.dither !== false,
    ditherSeed: options.ditherSeed,
    sampleAt: (frame, channel) => (channel === 0 ? (left[frame] ?? 0) : (right[frame] ?? 0)),
  });
}

export interface WriteWavOptions {
  readonly sampleRate: number;
  /** 1 for mono, 2 for stereo; more channels are written as they come. */
  readonly channels: number;
  readonly bitDepth: WavBitDepth;
  /** Interleaved samples, `frames * channels` values. */
  readonly data: Float32Array;
  readonly dither?: boolean;
  readonly ditherSeed?: number;
}

/** {@link encodeWav} from interleaved samples of any channel count. */
export function encodeWavInterleaved(options: WriteWavOptions): Buffer {
  const channels = options.channels;
  if (channels < 1) {
    throw new RangeError(`encodeWavInterleaved: channels must be >= 1, got ${channels}`);
  }
  const data = options.data;
  const frames = Math.floor(data.length / channels);
  return encodeRiff({
    channels,
    frames,
    sampleRate: options.sampleRate,
    float: options.bitDepth === 32,
    dither: options.dither !== false,
    ditherSeed: options.ditherSeed,
    sampleAt: (frame, channel) => data[frame * channels + channel] ?? 0,
  });
}

/**
 * `writeWav` — writes interleaved samples to `filePath`.
 *
 * ```ts
 * await writeWav('out.wav', { sampleRate: 44100, channels: 2, bitDepth: 16, data: interleaved });
 * ```
 */
export async function writeWav(filePath: string, options: WriteWavOptions): Promise<WavHeader> {
  const bytes = encodeWavInterleaved(options);
  await writeFile(filePath, bytes);
  return parseWavHeader(bytes);
}

/** {@link writeWav} without the promise, for the render loop. */
export function writeWavSync(filePath: string, options: WriteWavOptions): WavHeader {
  const bytes = encodeWavInterleaved(options);
  writeFileSync(filePath, bytes);
  return parseWavHeader(bytes);
}

function readU16(bytes: Buffer, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) & 0xffff;
}

function readU32(bytes: Buffer, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/** Parses the RIFF/WAVE header of a file's bytes. Throws when the file is not a WAV. */
export function parseWavHeader(bytes: Uint8Array): WavHeader {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'RIFF') {
    throw new Error('readWavHeader: not a RIFF file');
  }
  if (buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('readWavHeader: RIFF file is not a WAVE');
  }

  const riffSize = readU32(buffer, 4);
  let offset = 12;
  let fmtSize = 0;
  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let sawFmt = false;
  let sawData = false;
  let frames = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = readU32(buffer, offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmtSize = size;
      formatTag = readU16(buffer, body);
      channels = readU16(buffer, body + 2);
      sampleRate = readU32(buffer, body + 4);
      byteRate = readU32(buffer, body + 8);
      blockAlign = readU16(buffer, body + 12);
      bitsPerSample = readU16(buffer, body + 14);
      sawFmt = true;
    } else if (id === 'fact') {
      // The fact body is a single uint32 frame count at the start of the chunk, not at body + 4
      // (that offset reads the `data` magic instead); see `encodeWav`'s fact layout.
      frames = readU32(buffer, body);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
      sawData = true;
    }
    // Chunks are word aligned.
    offset = body + size + (size % 2);
  }

  if (!sawFmt) {
    throw new Error('readWavHeader: WAVE file has no fmt chunk');
  }
  // "no data chunk" means the chunk is absent, not that it is empty: a zero sample mix is a valid
  // WAVE (`fmt ` plus a `data` chunk of size 0) and `writeWavSync` parses its own output, so
  // rejecting `dataSize === 0` made a legitimate empty render fail on the way out.
  if (!sawData) {
    throw new Error('readWavHeader: WAVE file has no data chunk');
  }

  const float = formatTag === WAVE_FORMAT_IEEE_FLOAT;
  const computedFrames = blockAlign > 0 ? Math.floor(dataSize / blockAlign) : 0;
  return {
    riffSize,
    fmtSize,
    formatTag,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    frames: frames > 0 ? frames : computedFrames,
    dataOffset,
    dataSize,
    float,
  };
}

/**
 * `readWavHeader` — the header of a WAV file, so a test can check what {@link writeWav} produced.
 *
 * Only the first 1 KiB are read, which always covers the header of a WAV written by
 * {@link encodeWav}.
 */
export function readWavHeader(filePath: string): WavHeader {
  const fd = openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(1024);
    const read = readSync(fd, head, 0, head.length, 0);
    return parseWavHeader(head.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

/** A WAV file read back: its header and its samples as floats. */
export interface WavFile {
  readonly header: WavHeader;
  /** Interleaved samples, `header.frames * header.channels` values. */
  readonly samples: Float32Array;
}

/** Reads a whole WAV file, decoding 16-bit PCM and 32-bit float alike. */
export function readWav(filePath: string): WavFile {
  const bytes = readFileSync(filePath);
  const header = parseWavHeader(bytes);
  const frames = Math.floor(header.dataSize / header.blockAlign);
  const channels = Math.max(1, header.channels);
  const samples = new Float32Array(frames * channels);
  const view = new DataView(bytes.buffer, bytes.byteOffset + header.dataOffset, header.dataSize);

  for (let i = 0; i < samples.length; i += 1) {
    if (header.float) {
      samples[i] = view.getFloat32(i * 4, true);
    } else if (header.bitsPerSample === 16) {
      samples[i] = fromInt16(view.getInt16(i * 2, true));
    } else if (header.bitsPerSample === 32) {
      samples[i] = view.getInt32(i * 4, true) / 2147483648;
    } else if (header.bitsPerSample === 8) {
      samples[i] = ((bytes[header.dataOffset + i] ?? 128) - 128) / 128;
    } else {
      throw new Error(`readWav: unsupported bit depth ${header.bitsPerSample}`);
    }
  }

  return { header, samples };
}
