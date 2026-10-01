/**
 * The audio mixer: places every track of the resolved audio map on the output timeline with sample
 * accuracy and mixes them to stereo.
 *
 * Port of `.source/fframes/fframes/src/audio_mix.rs` (all 946 lines, module tests included).
 *
 * - tracks start and end at their exact sample, also in the middle of an encoder frame,
 * - each track has gain, pan, fades, a file offset and range-driven ducking (`TrackMix`),
 * - a Kaiser-windowed sinc resamples sources at other sample rates (`./resample.ts`),
 * - the mixer sums overlapping tracks linearly and runs the sum through a lookahead peak
 *   limiter, so loud overlaps neither intermodulate nor clip,
 * - 5 ms de-click fades where a track or the rendered range cuts into a sound.
 *
 * ```ts
 * const mixer = new AudioMixer({ tracks: resolve(audioMap, { fps, sampleRate }), audio });
 * const { left, right } = mixer.renderAll();
 * ```
 */

import type { ResolvedAudioTrack, ResolvedDucking, TrackMix } from './audio-map.ts';
import { fadeCurveGain } from './audio-map.ts';
import type { SincResampler } from './resample.ts';
import { getResampler } from './resample.ts';
import type { WavHeader } from './wav.ts';
import { writeWavSync } from './wav.ts';

/** `DECLICK_SECONDS` — 5 ms of fade wherever a sound is cut. */
export const DECLICK_SECONDS = 0.005;

/** The output sample rate when the caller does not pick one. */
export const DEFAULT_MIX_SAMPLE_RATE = 44100;

/** `db_to_gain` */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** `LimiterOptions` — the master bus peak limiter. */
export interface LimiterOptions {
  /** Maximum sample level in dBFS. */
  readonly ceilingDb: number;
  /** The limiter starts reducing the level this long before a peak. */
  readonly lookaheadMs: number;
  /** Time constant of the level coming back after a peak. */
  readonly releaseMs: number;
}

/** `LimiterOptions::default()` */
export const DEFAULT_LIMITER_OPTIONS: LimiterOptions = {
  ceilingDb: -1,
  lookaheadMs: 5,
  releaseMs: 80,
};

/** `AudioMixOptions` — master bus settings. */
export interface MixerOptions {
  /** Master level in dB applied after the tracks are summed. */
  readonly masterGainDb?: number;
  /** `null` sums without any protection against clipping. */
  readonly limiter?: LimiterOptions | null;
  /** 5 ms fades where a track or the rendered range cuts into a sound. */
  readonly declick?: boolean;
}

/** `AudioMixOptions::default()` */
export const DEFAULT_MIXER_OPTIONS: Required<MixerOptions> = {
  masterGainDb: 0,
  limiter: DEFAULT_LIMITER_OPTIONS,
  declick: true,
};

/** A half-open sample range on the output timeline. */
export interface SampleRange {
  readonly start: number;
  readonly end: number;
}

/**
 * A decoded file the mixer reads from. `DecodedAudio` from `media/audio-decode.ts` satisfies it
 * structurally, so no adapter is needed.
 */
export interface TrackAudio {
  /** The only channel of a mono file, or the left channel of a stereo file. */
  readonly samples: Float32Array;
  /** The right channel of a stereo file; `null` for mono. */
  readonly right: Float32Array | null;
  /** Sample rate the samples were decoded at. */
  readonly sampleRate: number;
}

export interface AudioMixerInput {
  /** The resolved map, in samples at `mapSampleRate`. */
  readonly tracks: readonly ResolvedAudioTrack[];
  /** The decoded files, by media directory name. */
  readonly audio: ReadonlyMap<string, TrackAudio> | Record<string, TrackAudio>;
  /** Output sample rate, 44100 by default. */
  readonly sampleRate?: number;
  /** Rate the map was resolved at; `sampleRate` by default. */
  readonly mapSampleRate?: number;
  /** The part of the timeline being rendered, `0..<last track end>` by default. */
  readonly outputRange?: SampleRange;
  /** Length of the whole video; the output range end by default. */
  readonly totalSamples?: number;
  readonly options?: MixerOptions;
}

function lookupAudio(
  audio: ReadonlyMap<string, TrackAudio> | Record<string, TrackAudio>,
  file: string,
): TrackAudio | null {
  if (audio instanceof Map) {
    return audio.get(file) ?? null;
  }
  const record = audio as Record<string, TrackAudio>;
  return Object.prototype.hasOwnProperty.call(record, file) ? (record[file] ?? null) : null;
}

class FloatDelayRing {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly capacity: number;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.left = new Float32Array(capacity);
    this.right = new Float32Array(capacity);
  }

  push(left: number, right: number): void {
    const index = (this.head + this.count) % this.capacity;
    this.left[index] = left;
    this.right[index] = right;
    this.count += 1;
  }

  pop(): [number, number] {
    if (this.count === 0) {
      return [0, 0];
    }
    const left = this.left[this.head] ?? 0;
    const right = this.right[this.head] ?? 0;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
    return [left, right];
  }

  reset(latency: number): void {
    this.left.fill(0);
    this.right.fill(0);
    this.head = 0;
    this.count = latency;
  }
}

/**
 * A ring of `(sample index, required gain)` pairs holding the sliding minimum of the gain each
 * sample needs. Bounded by `lookahead` because entries expire once they are that far behind.
 */
class MinWindow {
  private readonly indexes: Float64Array;
  private readonly gains: Float64Array;
  private readonly capacity: number;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.indexes = new Float64Array(capacity);
    this.gains = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  pushBack(index: number, gain: number): void {
    const slot = (this.head + this.count) % this.capacity;
    this.indexes[slot] = index;
    this.gains[slot] = gain;
    this.count += 1;
  }

  popBack(): void {
    if (this.count === 0) return;
    this.count -= 1;
  }

  popFront(): void {
    if (this.count === 0) return;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
  }

  backGain(): number {
    if (this.count === 0) return 0;
    return this.gains[(this.head + this.count - 1) % this.capacity] ?? 0;
  }

  frontGain(): number {
    if (this.count === 0) return 1;
    return this.gains[this.head] ?? 1;
  }

  frontIndex(): number {
    if (this.count === 0) return 0;
    return this.indexes[this.head] ?? 0;
  }
}

/**
 * `Limiter` — a lookahead brickwall limiter (linked stereo).
 *
 * The gain is the sliding minimum of the gain each sample needs, released exponentially and
 * smoothed by a moving average as long as the lookahead, so it reaches the required gain exactly
 * at the (delayed) peak.
 */
export class Limiter {
  /** The ceiling as a linear level, `10^(ceilingDb/20)`. */
  readonly ceiling: number;
  /** Delay line length in samples; the output lags the input by `lookahead - 1`. */
  readonly lookahead: number;
  /** Release coefficient, `1 - exp(-1 / (release * sampleRate))`. */
  readonly beta: number;

  private readonly delay: FloatDelayRing;
  private readonly minWindow: MinWindow;
  private readonly boxcar: Float64Array;
  private boxcarSum: number;
  private released = 1;
  private n = 0;

  constructor(options: LimiterOptions, sampleRate: number) {
    this.lookahead = Math.max(1, Math.round((options.lookaheadMs / 1000) * sampleRate));
    const release = Math.max(options.releaseMs / 1000, 1e-4);
    this.ceiling = 10 ** (options.ceilingDb / 20);
    this.beta = 1 - Math.exp(-1 / (release * sampleRate));
    this.delay = new FloatDelayRing(this.lookahead);
    this.minWindow = new MinWindow(this.lookahead + 1);
    this.boxcar = new Float64Array(this.lookahead).fill(1);
    this.boxcarSum = this.lookahead;
    this.reset();
  }

  /** `Limiter::latency` — output samples lag the input by this many. */
  latency(): number {
    return this.lookahead - 1;
  }

  /** `Limiter::reset` */
  reset(): void {
    this.delay.reset(this.latency());
    this.minWindow.clear();
    this.released = 1;
    this.boxcar.fill(1);
    this.boxcarSum = this.lookahead;
    this.n = 0;
  }

  /** `Limiter::process` — one stereo frame in, one out. */
  process(left: number, right: number): [number, number] {
    const peak = Math.max(Math.abs(left), Math.abs(right));
    const required = peak > this.ceiling ? this.ceiling / peak : 1;

    while (this.minWindow.size > 0 && this.minWindow.backGain() >= required) {
      this.minWindow.popBack();
    }
    this.minWindow.pushBack(this.n, required);
    while (this.minWindow.size > 0 && this.minWindow.frontIndex() + this.lookahead <= this.n) {
      this.minWindow.popFront();
    }
    const hold = this.minWindow.frontGain();

    this.released =
      hold < this.released ? hold : this.released + (hold - this.released) * this.beta;

    const slot = this.n % this.lookahead;
    this.boxcarSum += this.released - (this.boxcar[slot] ?? 0);
    this.boxcar[slot] = this.released;
    if (this.n % 1_000_000 === 0) {
      // Kill floating point drift of the running sum.
      let sum = 0;
      for (let i = 0; i < this.boxcar.length; i += 1) sum += this.boxcar[i] ?? 0;
      this.boxcarSum = sum;
    }
    const gain = this.boxcarSum / this.lookahead;
    this.n += 1;

    this.delay.push(left, right);
    const [delayedLeft, delayedRight] = this.delay.pop();
    return [
      Math.min(this.ceiling, Math.max(-this.ceiling, delayedLeft * gain)),
      Math.min(this.ceiling, Math.max(-this.ceiling, delayedRight * gain)),
    ];
  }
}

interface PreparedTrack {
  readonly file: string;
  readonly left: Float32Array;
  readonly right: Float32Array | null;
  /** Output samples. */
  readonly range: SampleRange;
  /** Position in the file (source samples) at `range.start`. */
  readonly sourceStart: number;
  /** Source samples per output sample. */
  readonly ratio: number;
  readonly resampler: SincResampler | null;
  readonly gain: number;
  /** Mono: equal-power pan gains; stereo: balance attenuation per side. */
  readonly pan: readonly [number, number];
  readonly mix: TrackMix;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly declickIn: boolean;
  readonly declickOut: boolean;
  /** Voice ranges (output samples) this track is ducked under, merged. */
  readonly duckUnder: SampleRange[];
}

const RAISED_COSINE = (t: number): number => (1 - Math.cos(Math.min(1, Math.max(0, t)) * Math.PI)) * 0.5;

/**
 * `merge_ranges` — merges ranges whose gap is at most `gap`, so the music does not pump between
 * two short phrases.
 */
export function mergeRanges(ranges: readonly SampleRange[], gap: number): SampleRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end + gap) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/**
 * `duck_db` — the attenuation of a ducked track at output sample `n`, in dB.
 *
 * The level ramps down over `attack` before a voice starts, holds for `hold` after it ends and
 * comes back over `release`, all on a raised cosine. Overlapping voices take the deepest of the
 * amounts, not their sum.
 */
export function duckDb(
  voices: readonly SampleRange[],
  ducking: ResolvedDucking,
  n: number,
  sampleRate: number,
): number {
  const attack = ducking.attack * sampleRate;
  const hold = ducking.hold * sampleRate;
  const release = ducking.release * sampleRate;

  let depth = 0;
  for (const voice of voices) {
    const downFrom = voice.start - attack;
    const upFrom = voice.end + hold;
    if (n < downFrom || n >= upFrom + release) {
      continue;
    }
    const amount =
      n < voice.start
        ? attack > 0
          ? RAISED_COSINE((n - downFrom) / attack)
          : 1
        : n < upFrom
          ? 1
          : 1 - RAISED_COSINE((n - upFrom) / Math.max(release, 1));
    depth = Math.max(depth, amount);
  }
  return ducking.depthDb * depth;
}

function sourceSample(
  channel: Float32Array,
  position: number,
  resampler: SincResampler | null,
): number {
  if (resampler !== null) {
    return resampler.sample(channel, position);
  }
  const index = Math.round(position);
  return index >= 0 && index < channel.length ? (channel[index] ?? 0) : 0;
}

/**
 * `PreparedTrack::envelope` — the gain of one track at one output sample.
 *
 * Fades win over de-click, and ducking is applied last, in the dB domain.
 */
function trackEnvelope(
  track: PreparedTrack,
  n: number,
  sampleRate: number,
  declickSamples: number,
): number {
  const fromStart = n - track.range.start;
  const toEnd = track.range.end - n;
  let gain = track.gain;

  if (track.fadeIn > 0 && fromStart < track.fadeIn) {
    gain *= fadeCurveGain(track.mix.fadeCurve, fromStart / track.fadeIn);
  } else if (track.declickIn && fromStart < declickSamples) {
    gain *= fromStart / declickSamples;
  }

  if (track.fadeOut > 0 && toEnd <= track.fadeOut) {
    gain *= fadeCurveGain(track.mix.fadeCurve, (toEnd - 1) / track.fadeOut);
  } else if (track.declickOut && toEnd <= declickSamples) {
    gain *= Math.max(0, (toEnd - 1) / declickSamples);
  }

  if (track.mix.duck !== null) {
    gain *= dbToGain(duckDb(track.duckUnder, track.mix.duck, n, sampleRate));
  }

  return gain;
}

/** A track playing at some moment, `AudioMixer::active_tracks_at`. */
export interface ActiveTrack {
  readonly file: string;
  /** Position inside the file, in seconds. */
  readonly fileSeconds: number;
  /** Effective level (gain, fades and ducking) in dB. */
  readonly gainDb: number;
  readonly voice: boolean;
  /** Current ducking attenuation, `0` when not ducked. */
  readonly duckedDb: number;
}

/**
 * `AudioMixer` — sums every track for a range of the output timeline.
 *
 * The limiter is stateful, so blocks must be rendered in order; jumping elsewhere resets it.
 */
export class AudioMixer {
  private readonly tracks: PreparedTrack[];
  private readonly sampleRate: number;
  private readonly masterGain: number;
  private limiter: Limiter | null;
  /** The next raw sample the limiter expects. */
  private nextRaw: number | null = null;
  private readonly outputRange: SampleRange;
  private readonly totalSamples: number;
  private readonly declick: boolean;
  private readonly missing: string[];

  constructor(input: AudioMixerInput) {
    const sampleRate = input.sampleRate ?? DEFAULT_MIX_SAMPLE_RATE;
    if (!Number.isInteger(sampleRate) || sampleRate < 1) {
      throw new RangeError(`AudioMixer: sampleRate must be a positive integer, got ${sampleRate}`);
    }
    const mapSampleRate = Math.max(1, input.mapSampleRate ?? sampleRate);
    const limiterOption = input.options?.limiter;
    const options: Required<MixerOptions> = {
      masterGainDb: input.options?.masterGainDb ?? DEFAULT_MIXER_OPTIONS.masterGainDb,
      limiter: limiterOption === undefined ? DEFAULT_MIXER_OPTIONS.limiter : limiterOption,
      declick: input.options?.declick ?? DEFAULT_MIXER_OPTIONS.declick,
    };

    const rate = sampleRate;
    const rescale = rate / mapSampleRate;
    const toOutput = (sample: number): number => Math.round(sample * rescale);

    const missing: string[] = [];

    // The voice ranges drive the ducking envelope of every ducked track, timeline driven.
    const voices: SampleRange[] = [];
    for (const track of input.tracks) {
      if (!track.mix.voice) continue;
      voices.push({
        start: toOutput(track.range.start),
        end: toOutput(track.range.end),
      });
    }

    const tracks: PreparedTrack[] = [];
    let maxEnd = 0;
    for (const track of input.tracks) {
      const audio = lookupAudio(input.audio, track.file);
      if (audio === null) {
        // The Rust port reports the missing media through diagnostics and skips the track.
        missing.push(track.file);
        continue;
      }

      const range: SampleRange = {
        start: toOutput(track.range.start),
        end: toOutput(track.range.end),
      };
      if (range.end <= range.start || audio.sampleRate < 1) {
        continue;
      }
      if (range.end > maxEnd) maxEnd = range.end;

      const sourceRate = audio.sampleRate;
      const ratio = sourceRate / rate;
      const sourceStart = track.mix.offset * sourceRate;
      const naturalEnd = range.start + (audio.samples.length - sourceStart) / ratio;
      const resampler = audio.sampleRate === sampleRate ? null : getResampler(sourceRate, rate);

      const pan = panGains(track.mix.pan, audio.right !== null);

      const ducking = track.mix.duck;
      const duckUnder =
        ducking === null
          ? []
          : mergeRanges(
              // A voice track does not duck itself.
              voices.filter(
                (voice) =>
                  !(track.mix.voice && voice.start === range.start && voice.end === range.end),
              ),
              ducking.mergeGap * rate,
            );

      tracks.push({
        file: track.file,
        left: audio.samples,
        right: audio.right,
        range,
        sourceStart,
        ratio,
        resampler,
        gain: dbToGain(track.mix.gainDb),
        pan,
        mix: track.mix,
        fadeIn: track.mix.fadeIn * rate,
        fadeOut: track.mix.fadeOut * rate,
        declickIn: options.declick && track.mix.offset > 0,
        declickOut: options.declick && range.end < naturalEnd - 1,
        duckUnder,
      });
    }

    const outputRange = input.outputRange ?? { start: 0, end: Math.max(maxEnd, 0) };
    const totalSamples = input.totalSamples ?? outputRange.end;

    this.tracks = tracks;
    this.sampleRate = sampleRate;
    this.masterGain = dbToGain(options.masterGainDb);
    this.limiter = options.limiter === null ? null : new Limiter(options.limiter, sampleRate);
    this.outputRange = outputRange;
    this.totalSamples = totalSamples;
    this.declick = options.declick;
    this.missing = missing;
  }

  /**
   * `AudioMixer::sample_rate` — the output rate.
   *
   * Named `outputSampleRate`, not `sampleRate`, on purpose: the private field already owns the
   * name `sampleRate`, and a method of the same name would be shadowed by the field at runtime
   * (`mixer.sampleRate` is the number, so `mixer.sampleRate()` is a `TypeError`).
   */
  get outputSampleRate(): number {
    return this.sampleRate;
  }

  /** `AudioMixer::missing_files` — the map's files the media provider does not have. */
  missingFiles(): string[] {
    return [...this.missing];
  }

  /** The tracks that were prepared, for `inspect` and the tests. */
  preparedTracks(): readonly { file: string; range: SampleRange }[] {
    return this.tracks.map((track) => ({ file: track.file, range: track.range }));
  }

  /** The range {@link AudioMixer.renderAll} produces. */
  get range(): SampleRange {
    return this.outputRange;
  }

  /**
   * `AudioMixer::mix_raw` — sums all tracks for `start..start + left.length`, without the master
   * limiter.
   */
  private mixRaw(start: number, left: Float32Array, right: Float32Array): void {
    left.fill(0);
    right.fill(0);
    const end = start + left.length;
    const rate = this.sampleRate;
    const declickSamples = DECLICK_SECONDS * rate;

    for (const track of this.tracks) {
      const from = Math.max(track.range.start, start);
      const to = Math.min(track.range.end, end);
      if (from >= to) {
        continue;
      }

      for (let n = from; n < to; n += 1) {
        const position = track.sourceStart + (n - track.range.start) * track.ratio;
        const gain = trackEnvelope(track, n, rate, declickSamples);
        if (gain === 0) {
          continue;
        }
        const i = n - start;
        const l = sourceSample(track.left, position, track.resampler);
        const panLeft = track.pan[0];
        const panRight = track.pan[1];
        if (track.right !== null) {
          const r = sourceSample(track.right, position, track.resampler);
          left[i] = (left[i] ?? 0) + l * gain * panLeft;
          right[i] = (right[i] ?? 0) + r * gain * panRight;
        } else {
          left[i] = (left[i] ?? 0) + l * gain * panLeft;
          right[i] = (right[i] ?? 0) + l * gain * panRight;
        }
      }
    }

    if (this.masterGain !== 1) {
      for (let i = 0; i < left.length; i += 1) left[i] = (left[i] ?? 0) * this.masterGain;
      for (let i = 0; i < right.length; i += 1) right[i] = (right[i] ?? 0) * this.masterGain;
    }
  }

  /**
   * `AudioMixer::render` — fills `left`/`right` with the final mix of the timeline samples
   * starting at `start`.
   */
  render(start: number, left: Float32Array, right: Float32Array): void {
    const len = Math.min(left.length, right.length);
    if (len <= 0) {
      return;
    }

    if (this.limiter !== null) {
      const limiter = this.limiter;
      const latency = limiter.latency();
      const rawLeft = new Float32Array(len);
      const rawRight = new Float32Array(len);

      // The limiter delays by `latency`, so it runs that far ahead of the output.
      if (this.nextRaw !== start + latency) {
        const primeLeft = new Float32Array(latency);
        const primeRight = new Float32Array(latency);
        this.mixRaw(start, primeLeft, primeRight);
        limiter.reset();
        for (let i = 0; i < latency; i += 1) {
          limiter.process(primeLeft[i] ?? 0, primeRight[i] ?? 0);
        }
      }

      this.mixRaw(start + latency, rawLeft, rawRight);
      for (let i = 0; i < len; i += 1) {
        const [l, r] = limiter.process(rawLeft[i] ?? 0, rawRight[i] ?? 0);
        left[i] = l;
        right[i] = r;
      }
      this.nextRaw = start + latency + len;
    } else {
      this.mixRaw(start, left, right);
    }

    if (this.declick) {
      const edge = Math.trunc(DECLICK_SECONDS * this.sampleRate);
      const rangeStart = this.outputRange.start;
      const rangeEnd = this.outputRange.end;
      const fadesIn = rangeStart > 0;
      const fadesOut = rangeEnd < this.totalSamples;
      if (fadesIn || fadesOut) {
        for (let i = 0; i < len; i += 1) {
          const n = start + i;
          let gain = 1;
          if (fadesIn && n < rangeStart + edge) {
            gain *= Math.max(0, n - rangeStart) / edge;
          }
          if (fadesOut && n + edge >= rangeEnd) {
            gain *= Math.max(0, rangeEnd - (n + 1)) / edge;
          }
          if (gain < 1) {
            left[i] = (left[i] ?? 0) * gain;
            right[i] = (right[i] ?? 0) * gain;
          }
        }
      }
    }
  }

  /** `AudioMixer::render_all` — the whole output range into two channel buffers. */
  renderAll(): { left: Float32Array; right: Float32Array } {
    const len = Math.max(0, this.outputRange.end - this.outputRange.start);
    const left = new Float32Array(len);
    const right = new Float32Array(len);
    const block = 4096;
    let offset = 0;
    while (offset < len) {
      const n = Math.min(block, len - offset);
      this.render(this.outputRange.start + offset, left.subarray(offset, offset + n), right.subarray(offset, offset + n));
      offset += n;
    }
    return { left, right };
  }

  /**
   * {@link AudioMixer.renderAll} as one interleaved stereo buffer, the layout the WAV writer and
   * the analyser take.
   */
  renderInterleaved(): Float32Array {
    const { left, right } = this.renderAll();
    const out = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i += 1) {
      out[i * 2] = left[i] ?? 0;
      out[i * 2 + 1] = right[i] ?? 0;
    }
    return out;
  }

  /**
   * `AudioMixer::active_tracks_at` — the tracks audible at a timeline sample, with their position
   * in the file and their level. This is what `fframes audio at 4.2s` prints.
   */
  activeTracksAt(sample: number): ActiveTrack[] {
    const rate = this.sampleRate;
    const declickSamples = DECLICK_SECONDS * rate;
    const out: ActiveTrack[] = [];
    for (const track of this.tracks) {
      if (sample < track.range.start || sample >= track.range.end) {
        continue;
      }
      const position = track.sourceStart + (sample - track.range.start) * track.ratio;
      const sourceRate = track.ratio * rate;
      const gain = trackEnvelope(track, sample, rate, declickSamples);
      out.push({
        file: track.file,
        fileSeconds: position / sourceRate,
        gainDb: gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY,
        voice: track.mix.voice,
        duckedDb:
          track.mix.duck === null ? 0 : duckDb(track.duckUnder, track.mix.duck, sample, rate),
      });
    }
    return out;
  }
}

/**
 * The pan gains of a track.
 *
 * Mono files pan with equal power, compensated to unity at the centre; stereo files are balanced
 * by attenuating the opposite side, so the far channel never gets louder.
 */
export function panGains(pan: number, isStereo: boolean): readonly [number, number] {
  const clamped = Math.min(1, Math.max(-1, pan));
  if (Math.abs(clamped) < 1e-6) {
    return [1, 1];
  }
  if (isStereo) {
    const attenuation = Math.cos(Math.abs(clamped) * (Math.PI / 2));
    return clamped > 0 ? [attenuation, 1] : [1, attenuation];
  }
  const x = ((clamped + 1) / 2) * (Math.PI / 2);
  return [
    Math.min(1, Math.SQRT2 * Math.cos(x)),
    Math.min(1, Math.SQRT2 * Math.sin(x)),
  ];
}

export interface MixAudioToFileOptions {
  /** Write 32-bit float instead of 16-bit PCM. */
  readonly float?: boolean;
  /** Disable the TPDF dither of the 16-bit path. */
  readonly dither?: boolean;
}

/**
 * `mixAudioToFile` — mix and write in one step, the audio half of `fframes render`.
 *
 * ```ts
 * const header = mixAudioToFile({ tracks, audio, sampleRate: 44100 }, '/tmp/mix.wav');
 * ```
 *
 * The WAV lands on disk first and is muxed in as a second ffmpeg input, which is the only way to
 * avoid two pipes fighting over one stdin.
 */
export function mixAudioToFile(
  input: AudioMixerInput,
  wavPath: string,
  options: MixAudioToFileOptions = {},
): WavHeader {
  const mixer = new AudioMixer(input);
  return writeWavSync(wavPath, {
    // The constructor normalised `input.sampleRate` (or the default) into the field, so read it
    // back from there instead of re-deriving it: one normalisation, one answer.
    sampleRate: mixer.outputSampleRate,
    channels: 2,
    bitDepth: options.float === true ? 32 : 16,
    data: mixer.renderInterleaved(),
    dither: options.dither,
  });
}
