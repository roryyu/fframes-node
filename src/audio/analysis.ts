/**
 * Measuring a mix: loudness (ITU-R BS.1770 / EBU R128), true peak, clipping and silence.
 *
 * Port of `.source/fframes/fframes/src/audio_analysis.rs`. Use these numbers to check a render's
 * sound without listening to it.
 *
 * - K-weighting follows libebur128's analog-prototype formulas (exact at 48 kHz, valid at any
 *   rate), in the two biquad stages of {@link kWeighting};
 * - gating follows BS.1770: -70 LUFS absolute, -10 LU relative, 400 ms blocks with 75% overlap
 *   (hop 100 ms), and `-0.691` added so that the reference reads 0 LUFS;
 * - true peak uses the 4x polyphase interpolator of BS.1770 Annex 2, whose 4x12 coefficients are
 *   copied verbatim from the Rust source in {@link TRUE_PEAK_PHASES}.
 */

/** `Biquad` in transposed direct form II, f64 state. */
export class Biquad {
  /** Numerator, `b[0] + b[1] z^-1 + b[2] z^-2`. */
  readonly b: readonly [number, number, number];
  /** Denominator without the leading 1, `1 + a[0] z^-1 + a[1] z^-2`. */
  readonly a: readonly [number, number];
  private z0 = 0;
  private z1 = 0;

  constructor(b: readonly [number, number, number], a: readonly [number, number]) {
    this.b = b;
    this.a = a;
  }

  /** `Biquad::process` — one sample in, one out. */
  process(x: number): number {
    const y = this.b[0] * x + this.z0;
    this.z0 = this.b[1] * x - this.a[0] * y + this.z1;
    this.z1 = this.b[2] * x - this.a[1] * y;
    return y;
  }
}

/** The two K-weighting stages for a sample rate (`libebur128 ebur128_init_filter`). */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  const shelf = (() => {
    const f0 = 1681.974450955533;
    const g = 3.999843853973347;
    const q = 0.7071752369554196;
    const k = Math.tan((Math.PI * f0) / sampleRate);
    const vh = 10 ** (g / 20);
    const vb = vh ** 0.4996667741545416;
    const a0 = 1 + k / q + k * k;
    return new Biquad(
      [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
      [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
    );
  })();

  const highPass = (() => {
    const f0 = 38.13547087602444;
    const q = 0.5003270373238773;
    const k = Math.tan((Math.PI * f0) / sampleRate);
    const a0 = 1 + k / q + k * k;
    return new Biquad([1, -2, 1], [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]);
  })();

  return [shelf, highPass];
}

/**
 * BS.1770 Annex 2: the 4x oversampling interpolator, 4 phases of 12 taps.
 *
 * Copied verbatim from `audio_analysis.rs:62-119` — all 48 coefficients, digit for digit.
 * Phase 3 is phase 1 reversed, so a delay line alone would not be exact; keep the table literal.
 */
export const TRUE_PEAK_PHASES: readonly (readonly number[])[] = [
  [
    0.001708984375,
    0.010986328125,
    -0.0196533203125,
    0.033203125,
    -0.0594482421875,
    0.1373291015625,
    0.97216796875,
    -0.102294921875,
    0.047607421875,
    -0.026611328125,
    0.014892578125,
    -0.00830078125,
  ],
  [
    -0.0291748046875,
    0.029296875,
    -0.0517578125,
    0.089111328125,
    -0.16650390625,
    0.465087890625,
    0.77978515625,
    -0.2003173828125,
    0.1015625,
    -0.0582275390625,
    0.0330810546875,
    -0.0189208984375,
  ],
  [
    -0.0189208984375,
    0.0330810546875,
    -0.0582275390625,
    0.1015625,
    -0.2003173828125,
    0.77978515625,
    0.465087890625,
    -0.16650390625,
    0.089111328125,
    -0.0517578125,
    0.029296875,
    -0.0291748046875,
  ],
  [
    -0.00830078125,
    0.014892578125,
    -0.026611328125,
    0.047607421875,
    -0.102294921875,
    0.97216796875,
    0.1373291015625,
    -0.0594482421875,
    0.033203125,
    -0.0196533203125,
    0.010986328125,
    0.001708984375,
  ],
];

/** Number of coefficients in {@link TRUE_PEAK_PHASES}, used by the self check. */
export const TRUE_PEAK_COEFFICIENT_COUNT = TRUE_PEAK_PHASES.reduce(
  (total, phase) => total + phase.length,
  0,
);

/** `true_peak` — the highest level the 4x interpolator finds in one channel. */
export function truePeak(channel: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < channel.length; i += 1) {
    peak = Math.max(peak, Math.abs(channel[i] ?? 0));
  }
  for (let n = 0; n < channel.length; n += 1) {
    for (const phase of TRUE_PEAK_PHASES) {
      let acc = 0;
      for (let k = 0; k < phase.length; k += 1) {
        if (n >= k) {
          acc += (phase[k] ?? 0) * (channel[n - k] ?? 0);
        }
      }
      peak = Math.max(peak, Math.abs(acc));
    }
  }
  return peak;
}

/** `to_db` — a linear level in dBFS, `-Infinity` for digital silence. */
export function toDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY;
}

/** A linear level to a gain factor, the same curve as `audio_mix.rs::db_to_gain`. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** `energy_to_lufs` — the `-0.691` offset makes the BS.1770 reference read 0 LUFS. */
export function energyToLufs(meanSquare: number): number {
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : Number.NEGATIVE_INFINITY;
}

/**
 * `finite` — loudness values are `-Infinity` for digital silence; JSON gets `null` instead.
 * Values are rounded to two decimals, like the Rust `audio analyze` report.
 */
export function finiteLufs(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** The absolute gate of the integrated loudness, applied to the mean square domain. */
export const ABSOLUTE_GATE_MEAN_SQUARE = 10 ** ((-70 + 0.691) / 10);

/** The relative gate is the gated mean square times this factor (-10 dB). */
export const RELATIVE_GATE_FACTOR = 0.1;

/** Number of 100 ms hops in the 400 ms momentary window. */
export const MOMENTARY_HOPS = 4;

/** Number of 100 ms hops in the 3 s short-term window. */
export const SHORT_TERM_HOPS = 30;

/**
 * `LoudnessAnalysis` — per 100 ms energies of a K-weighted stereo signal, the base of every
 * loudness value.
 *
 * The filter state is per channel and per instance, so the same instance must not be shared
 * between two different signals.
 */
export class LoudnessAnalysis {
  private readonly sampleRate: number;
  private readonly hop: number;
  /** Sum over channels of the squared K-weighted samples in each 100 ms hop. */
  private readonly hops: number[];

  constructor(left: ArrayLike<number>, right: ArrayLike<number>, sampleRate: number) {
    if (!(sampleRate > 0)) {
      throw new RangeError(`LoudnessAnalysis: sampleRate must be positive, got ${sampleRate}`);
    }
    this.sampleRate = sampleRate;
    this.hop = Math.max(1, Math.floor(sampleRate / 10));
    const hopCount = Math.floor(left.length / this.hop);
    this.hops = new Array<number>(hopCount).fill(0);

    const take = hopCount * this.hop;
    for (const channel of [left, right]) {
      const [shelf, highPass] = kWeighting(sampleRate);
      const limit = Math.min(channel.length, take);
      for (let i = 0; i < limit; i += 1) {
        const y = highPass.process(shelf.process(channel[i] ?? 0));
        this.hops[Math.floor(i / this.hop)] =
          (this.hops[Math.floor(i / this.hop)] ?? 0) + y * y;
      }
    }
  }

  /** The hop index of a sample, clamped to the analysed range. */
  private hopRange(start: number, end: number): { start: number; end: number } {
    return {
      start: Math.min(Math.floor(start / this.hop), this.hops.length),
      end: Math.min(Math.floor(end / this.hop), this.hops.length),
    };
  }

  /**
   * Mean square of windows of `hopsPerWindow` hops starting at every hop of `[start, end)`.
   */
  windows(start: number, end: number, hopsPerWindow: number): number[] {
    const range = this.hopRange(start, end);
    if (range.end - range.start < hopsPerWindow) {
      return [];
    }
    const out: number[] = [];
    const divisor = hopsPerWindow * this.hop;
    for (let i = range.start; i <= range.end - hopsPerWindow; i += 1) {
      let sum = 0;
      for (let k = 0; k < hopsPerWindow; k += 1) {
        sum += this.hops[i + k] ?? 0;
      }
      out.push(sum / divisor);
    }
    return out;
  }

  /**
   * `LoudnessAnalysis::integrated` — the gated integrated loudness of a sample range in LUFS.
   *
   * Two gates, both in the mean square domain: -70 LUFS absolute, then 10 dB below the mean of
   * what survived.
   */
  integrated(start: number, end: number): number {
    const blocks = this.windows(start, end, MOMENTARY_HOPS);
    const gated = blocks.filter((z) => z >= ABSOLUTE_GATE_MEAN_SQUARE);
    if (gated.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }
    const relative =
      (gated.reduce((sum, z) => sum + z, 0) / gated.length) * RELATIVE_GATE_FACTOR;
    const kept = gated.filter((z) => z >= relative);
    if (kept.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }
    return energyToLufs(kept.reduce((sum, z) => sum + z, 0) / kept.length);
  }

  /** `LoudnessAnalysis::momentary` — 400 ms loudness every 100 ms. */
  momentary(): number[] {
    return this.windows(0, this.hopCountSamples(), MOMENTARY_HOPS).map(energyToLufs);
  }

  /** `LoudnessAnalysis::short_term` — 3 s loudness every 100 ms. */
  shortTerm(): number[] {
    return this.windows(0, this.hopCountSamples(), SHORT_TERM_HOPS).map(energyToLufs);
  }

  /** `LoudnessAnalysis::loudness_range` — EBU Tech 3342, in LU. */
  loudnessRange(): number | null {
    const shortTerm = this.windows(0, this.hopCountSamples(), SHORT_TERM_HOPS).filter(
      (z) => z >= ABSOLUTE_GATE_MEAN_SQUARE,
    );
    if (shortTerm.length === 0) {
      return null;
    }
    const relative = (shortTerm.reduce((sum, z) => sum + z, 0) / shortTerm.length) * 0.01;
    const kept = shortTerm.filter((z) => z >= relative).map(energyToLufs);
    if (kept.length === 0) {
      return null;
    }
    kept.sort((a, b) => a - b);
    const n = kept.length;
    const low = kept[Math.round((n - 1) * 0.1)] ?? Number.NaN;
    const high = kept[Math.round((n - 1) * 0.95)] ?? Number.NaN;
    return high - low;
  }

  /**
   * `LoudnessAnalysis::quiet_ranges` — ranges of at least `minSeconds` where the momentary
   * loudness is below `thresholdLufs`.
   */
  quietRanges(thresholdLufs: number, minSeconds: number): { start: number; end: number }[] {
    const hopSeconds = this.hop / this.sampleRate;
    const momentary = this.momentary();
    const ranges: { start: number; end: number }[] = [];
    let startIndex: number | null = null;

    momentary.forEach((loudness, i) => {
      const quiet = loudness < thresholdLufs;
      if (startIndex === null && quiet) {
        startIndex = i;
      } else if (startIndex !== null && !quiet) {
        // A momentary block covers 4 hops: the quiet part ends where the block that hears the
        // sound begins, plus its length.
        const end = (i + MOMENTARY_HOPS - 1) * hopSeconds;
        if (end - startIndex * hopSeconds >= minSeconds) {
          ranges.push({ start: startIndex * hopSeconds, end });
        }
        startIndex = null;
      }
    });

    if (startIndex !== null) {
      const end = (momentary.length + MOMENTARY_HOPS - 1) * hopSeconds;
      if (end - startIndex * hopSeconds >= minSeconds) {
        ranges.push({ start: startIndex * hopSeconds, end });
      }
    }

    return ranges;
  }

  /** The length of a 100 ms hop in seconds. */
  hopSeconds(): number {
    return this.hop / this.sampleRate;
  }

  private hopCountSamples(): number {
    return this.hops.length * this.hop;
  }
}

/** One momentary (or short-term) measurement. */
export interface LoudnessWindow {
  /** Start of the window in seconds. */
  readonly timeSeconds: number;
  /** End of the window in seconds. */
  readonly endSeconds: number;
  /** Loudness in LUFS, `null` for digital silence. */
  readonly lufs: number | null;
}

function toWindows(values: number[], hopSeconds: number, hops: number): LoudnessWindow[] {
  return values.map((lufs, i) => ({
    timeSeconds: Math.round(i * hopSeconds * 1000) / 1000,
    endSeconds: Math.round((i + hops) * hopSeconds * 1000) / 1000,
    lufs: finiteLufs(lufs),
  }));
}

/** Loudness of a named part of the mix, usually a scene. */
export interface SectionAnalysis {
  readonly name: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** Integrated loudness in LUFS, `null` for silence. */
  readonly integratedLufs: number | null;
  /** True peak in dBTP, `null` for silence. */
  readonly truePeakDb: number | null;
}

/** Everything `fframes audio analyze` reports. */
export interface AudioAnalysis {
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly integratedLufs: number | null;
  readonly loudnessRangeLu: number | null;
  readonly maxMomentaryLufs: number | null;
  readonly maxShortTermLufs: number | null;
  /** Highest single sample, in dBFS. */
  readonly samplePeakDb: number | null;
  /** Highest level after 4x oversampling, in dBTP. */
  readonly truePeakDb: number | null;
  /** Samples beyond full scale (either channel); they distort once encoded. */
  readonly clippingSamples: number;
  /** True when every sample of both channels is exactly zero. */
  readonly silent: boolean;
  /** Parts quieter than -60 LUFS for at least a second, as `[start, end]` second pairs. */
  readonly silentRanges: readonly [number, number][];
  /** 400 ms loudness every 100 ms. */
  readonly momentary: readonly LoudnessWindow[];
  /** 3 s loudness every 100 ms. */
  readonly shortTerm: readonly LoudnessWindow[];
  /** Loudness per scene or other named part. */
  readonly sections: readonly SectionAnalysis[];
}

export interface AnalyzeAudioInput {
  /** Left channel, or the only channel of a mono mix. */
  readonly left?: ArrayLike<number> | null;
  /** Right channel; `left` is used twice when it is missing. */
  readonly right?: ArrayLike<number> | null;
  /** Interleaved samples, for callers that have no separate channels. */
  readonly interleaved?: ArrayLike<number> | null;
  /** Channel count of `interleaved`, `2` by default. */
  readonly channels?: number;
  readonly sampleRate: number;
}

interface Channels {
  readonly left: ArrayLike<number>;
  readonly right: ArrayLike<number>;
}

function resolveChannels(input: AnalyzeAudioInput): Channels {
  if (input.left !== undefined && input.left !== null) {
    return { left: input.left, right: input.right ?? input.left };
  }
  if (input.interleaved !== undefined && input.interleaved !== null) {
    const channels = Math.max(1, input.channels ?? 2);
    const frames = Math.floor(input.interleaved.length / channels);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      left[i] = input.interleaved[i * channels] ?? 0;
      right[i] = channels >= 2 ? (input.interleaved[i * channels + 1] ?? 0) : (left[i] ?? 0);
    }
    return { left, right };
  }
  return { left: [], right: [] };
}

/** A sub-range of a channel, as a `Float32Array` so `truePeak` can index it cheaply. */
function sliceChannel(channel: ArrayLike<number>, start: number, end: number): Float32Array {
  if (channel instanceof Float32Array) {
    return channel.subarray(start, end);
  }
  const out = new Float32Array(Math.max(0, end - start));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = channel[start + i] ?? 0;
  }
  return out;
}

/** A named sample range, used for the per-scene report. */
export interface AnalysisSection {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * `analyze_audio` — the full report for a mix.
 *
 * ```ts
 * const report = analyzeAudio({ left, right, sampleRate: 44100 });
 * report.integratedLufs; // -14.02
 * report.truePeakDb;      // -1.1
 * ```
 *
 * `sections` are named sample ranges, usually the scenes.
 */
export function analyzeAudio(
  input: AnalyzeAudioInput,
  sections: readonly AnalysisSection[] = [],
): AudioAnalysis {
  const { left, right } = resolveChannels(input);
  const sampleRate = input.sampleRate;
  const loudness = new LoudnessAnalysis(left, right, sampleRate);
  const frames = left.length;

  // `left.iter().chain(right)`, so a mono mix is counted twice, like the Rust report.
  let samplePeak = 0;
  let clippingSamples = 0;
  let silent = frames > 0;
  for (const channel of [left, right]) {
    for (let i = 0; i < channel.length; i += 1) {
      const absolute = Math.abs(channel[i] ?? 0);
      if (absolute > samplePeak) samplePeak = absolute;
      if (absolute > 1) clippingSamples += 1;
      if (absolute !== 0) silent = false;
    }
  }

  const peakOf = (start: number, end: number): number => {
    const from = Math.min(start, frames);
    const to = Math.min(end, frames);
    if (to <= from) {
      return 0;
    }
    return Math.max(
      truePeak(sliceChannel(left, from, to)),
      truePeak(sliceChannel(right, from, to)),
    );
  };

  const momentary = loudness.momentary();
  const shortTerm = loudness.shortTerm();
  const hopSeconds = loudness.hopSeconds();
  const rangeLu = loudness.loudnessRange();
  const max = (values: number[]): number =>
    values.reduce((acc, value) => Math.max(acc, value), Number.NEGATIVE_INFINITY);

  return {
    durationSeconds: frames / sampleRate,
    sampleRate,
    integratedLufs: finiteLufs(loudness.integrated(0, frames)),
    loudnessRangeLu: rangeLu === null || !Number.isFinite(rangeLu) ? null : Math.round(rangeLu * 100) / 100,
    maxMomentaryLufs: finiteLufs(max(momentary)),
    maxShortTermLufs: finiteLufs(max(shortTerm)),
    samplePeakDb: finiteLufs(toDb(samplePeak)),
    truePeakDb: finiteLufs(toDb(peakOf(0, frames))),
    clippingSamples,
    silent,
    silentRanges: loudness
      .quietRanges(-60, 1)
      .map(
        (range): [number, number] => [
          Math.round(range.start * 100) / 100,
          Math.round(range.end * 100) / 100,
        ],
      ),
    momentary: toWindows(momentary, hopSeconds, MOMENTARY_HOPS),
    shortTerm: toWindows(shortTerm, hopSeconds, SHORT_TERM_HOPS),
    sections: sections.map((section) => ({
      name: section.name,
      startSeconds: section.start / sampleRate,
      endSeconds: section.end / sampleRate,
      integratedLufs: finiteLufs(loudness.integrated(section.start, section.end)),
      truePeakDb: finiteLufs(toDb(peakOf(section.start, section.end))),
    })),
  };
}
