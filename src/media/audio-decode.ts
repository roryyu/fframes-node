/**
 * Decoding audio files to samples.
 *
 * Port of `.source/fframes/fframes-media/src/audio.rs` (`PreloadedAudioData` + `AudioData`) and
 * of the decoder itself. The Rust port links libavformat and calls
 * `PreloadedAudioData::decode_raw_file_stereo`; this port shells out to the `ffmpeg` CLI, which
 * is the same demuxer/resampler in a subprocess, and probes durations with `ffprobe`.
 *
 * The decoded shape is deliberately the Rust one — `samples` is the only channel of a mono file
 * or the left channel of a stereo file, `right` is the second channel of a stereo file — so
 * `audio/mixer.ts` can mirror `audio_mix.rs` without an adapter. `decodeAudioFile` downmixes to
 * mono (`-ac 1`), matching the contract; `decodeAudioFileStereo` keeps both channels.
 */

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

/** The default sample rate of the whole audio chain. */
export const DEFAULT_SAMPLE_RATE = 44100;

/**
 * `PreloadedAudioData` — a decoded audio file held in memory.
 *
 * Use {@link decodeAudioFile} to build one from a file, or the constructor with a synthetic
 * buffer (which is what the tests do, so no media file and no ffmpeg are needed).
 */
export class DecodedAudio {
  /** The only channel of a mono file, or the left channel of a stereo file. */
  readonly samples: Float32Array;
  /** The right channel of a stereo file; `null` for mono. */
  readonly right: Float32Array | null;
  /** Sample rate the samples were decoded at. */
  readonly sampleRate: number;

  constructor(samples: Float32Array, sampleRate: number, right: Float32Array | null = null) {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.right = right;
  }

  /** `AudioData::channels` — 1 or 2. */
  get channels(): number {
    return this.right === null ? 1 : 2;
  }

  /** `PreloadedAudioData::is_stereo` */
  isStereo(): boolean {
    return this.right !== null;
  }

  /**
   * `PreloadedAudioData::channels` — `(left, right)`; for mono files both are the same buffer.
   */
  channelPair(): { left: Float32Array; right: Float32Array } {
    return { left: this.samples, right: this.right ?? this.samples };
  }

  /** `AudioData::duration_in_samples` */
  get sampleCount(): number {
    return this.samples.length;
  }

  /** `PreloadedAudioData::duration_in_seconds` */
  durationInSeconds(): number {
    return this.samples.length / this.sampleRate;
  }

  /** `PreloadedAudioData::duration_in_frames` — integer division, like the Rust `usize` math. */
  durationInFrames(fps: number): number {
    return Math.trunc((this.samples.length * fps) / this.sampleRate);
  }

  /** `PreloadedAudioData::get_range` — a sub-range, or `null` when it does not fit. */
  getRange(start: number, end: number): Float32Array | null {
    if (start < 0 || end > this.samples.length || start > end) {
      return null;
    }
    return this.samples.subarray(start, end);
  }

  /**
   * `PreloadedAudioData::get_frame_data` — the `length` samples starting at frame `frame`,
   * or `null` when the audio ends first.
   */
  getFrameData(length: number, frame: number, fps: number): Float32Array | null {
    const startIndex = Math.trunc((frame * this.sampleRate) / fps);
    return this.getRange(startIndex, startIndex + length);
  }

  /** `PreloadedAudioData::get_frame_data_mono` — averages both channels of a stereo file. */
  getFrameDataMono(length: number, frame: number, fps: number): Float32Array | null {
    const startIndex = Math.trunc((frame * this.sampleRate) / fps);
    const left = this.getRange(startIndex, startIndex + length);
    if (left === null) {
      return null;
    }
    if (this.right === null) {
      return left;
    }
    const right = this.right.subarray(startIndex, startIndex + length);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
    }
    return out;
  }

  /** Left/right as one interleaved buffer, the layout the WAV writer and the analyser take. */
  interleaved(): Float32Array {
    if (this.right === null) {
      return this.samples.slice();
    }
    const frames = Math.min(this.samples.length, this.right.length);
    const out = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      out[i * 2] = this.samples[i] ?? 0;
      out[i * 2 + 1] = this.right[i] ?? 0;
    }
    return out;
  }
}

interface RunResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number | null;
}

/** Runs a command and collects its output; never uses a shell. */
function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error: Error) => {
      reject(new Error(`${command} could not be started: ${error.message}`));
    });
    child.on('close', (code: number | null) => {
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
      });
    });
  });
}

/** Little endian `f32le` bytes to samples, read byte by byte so alignment never matters. */
export function parseF32le(bytes: Buffer): Float32Array {
  const count = Math.floor(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/** Splits interleaved samples into one `Float32Array` per channel. */
export function deinterleave(data: Float32Array, channels: number): Float32Array[] {
  if (channels < 1) {
    throw new RangeError(`deinterleave: channels must be >= 1, got ${channels}`);
  }
  const frames = Math.floor(data.length / channels);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) {
    const channel = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      channel[i] = data[i * channels + c] ?? 0;
    }
    out.push(channel);
  }
  return out;
}

/**
 * `PreloadedAudioData::decode_raw_file` — decodes a file to mono `f32` samples.
 *
 * ```sh
 * ffmpeg -v error -i <path> -f f32le -ac 1 -ar <sampleRate> pipe:1
 * ```
 *
 * Returns a {@link DecodedAudio} with `channels === 1`. Use {@link decodeAudioSamples} when only
 * the buffer is wanted, as the contract spells it.
 */
export async function decodeAudioFile(
  filePath: string,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): Promise<DecodedAudio> {
  if (sampleRate < 1) {
    throw new RangeError(`decodeAudioFile: sampleRate must be >= 1, got ${sampleRate}`);
  }
  const result = await run('ffmpeg', [
    '-v',
    'error',
    '-i',
    filePath,
    '-f',
    'f32le',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    'pipe:1',
  ]);
  if (result.code !== 0) {
    throw new Error(
      `decodeAudioFile: ffmpeg failed for "${filePath}" (exit ${String(result.code)}): ${result.stderr.trim()}`,
    );
  }
  return new DecodedAudio(parseF32le(result.stdout), sampleRate, null);
}

/** `decodeAudioFile` reduced to the raw mono buffer. */
export async function decodeAudioSamples(
  filePath: string,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): Promise<Float32Array> {
  return (await decodeAudioFile(filePath, sampleRate)).samples;
}

/**
 * `PreloadedAudioData::decode_raw_file_stereo` — keeps stereo, downmixing more than two channels.
 *
 * ```sh
 * ffmpeg -v error -i <path> -f f32le -ac 2 -ar <sampleRate> pipe:1
 * ```
 */
export async function decodeAudioFileStereo(
  filePath: string,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): Promise<DecodedAudio> {
  const result = await run('ffmpeg', [
    '-v',
    'error',
    '-i',
    filePath,
    '-f',
    'f32le',
    '-ac',
    '2',
    '-ar',
    String(sampleRate),
    'pipe:1',
  ]);
  if (result.code !== 0) {
    throw new Error(
      `decodeAudioFileStereo: ffmpeg failed for "${filePath}" (exit ${String(result.code)}): ${result.stderr.trim()}`,
    );
  }
  const [left, right] = deinterleave(parseF32le(result.stdout), 2);
  return new DecodedAudio(left ?? new Float32Array(0), sampleRate, right ?? null);
}

/**
 * The duration of a media file in seconds, or `null` when it can not be probed.
 *
 * ```sh
 * ffprobe -v error -print_format json -show_format <path>
 * ```
 *
 * The Rust port reads `AVFormatContext::duration` through libavformat; the JSON `format.duration`
 * is the same number as a string.
 */
export async function probeDurationSeconds(filePath: string): Promise<number | null> {
  let result: RunResult;
  try {
    result = await run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      filePath,
    ]);
  } catch {
    return null;
  }
  if (result.code !== 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const format = (parsed as { format?: { duration?: unknown } }).format;
    const duration = format?.duration;
    if (typeof duration !== 'string' && typeof duration !== 'number') {
      return null;
    }
    const seconds = Number(duration);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * Wraps a mono buffer as a {@link DecodedAudio}. The adapter for callers that only have samples.
 */
export function toDecodedAudio(
  samples: Float32Array,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
  right: Float32Array | null = null,
): DecodedAudio {
  return new DecodedAudio(samples, sampleRate, right);
}
