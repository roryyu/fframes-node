/**
 * BS.1770 loudness, true peak, clipping and silence.
 *
 * The reference values come from the standard and from the Rust module tests of
 * `audio_analysis.rs:414-497`: a 0 dBFS 997 Hz sine in one channel reads -3.01 LKFS, a stereo
 * 1 kHz sine at -23 dBFS reads -23 LUFS, and 3 s of digital silence is reported as a silent range.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ABSOLUTE_GATE_MEAN_SQUARE,
  LoudnessAnalysis,
  MOMENTARY_HOPS,
  RELATIVE_GATE_FACTOR,
  SHORT_TERM_HOPS,
  TRUE_PEAK_COEFFICIENT_COUNT,
  TRUE_PEAK_PHASES,
  analyzeAudio,
  dbToGain,
  energyToLufs,
  finiteLufs,
  kWeighting,
  toDb,
  truePeak,
} from '../src/audio/analysis.ts';

function sine(frequency: number, amplitude: number, seconds: number, rate: number): Float32Array {
  const count = Math.floor(seconds * rate);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return out;
}

test('the K-weighting filters match the BS.1770 coefficients at 48 kHz', () => {
  const [shelf, highPass] = kWeighting(48000);
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-12;

  assert.ok(close(shelf.b[0], 1.53512485958697));
  assert.ok(close(shelf.b[1], -2.69169618940638));
  assert.ok(close(shelf.b[2], 1.19839281085285));
  assert.ok(close(shelf.a[0], -1.69065929318241));
  assert.ok(close(shelf.a[1], 0.73248077421585));
  assert.ok(close(highPass.b[0], 1));
  assert.ok(close(highPass.b[1], -2));
  assert.ok(close(highPass.b[2], 1));
  assert.ok(close(highPass.a[0], -1.99004745483398));
  assert.ok(close(highPass.a[1], 0.99007225036621));
});

test('the K-weighting is the libebur128 shelf plus a 38 Hz high pass', () => {
  // The analytic prototype constants the contract pins down.
  const [, highPass] = kWeighting(48000);
  assert.ok(highPass.a[0] < 0, 'a high pass');
  assert.ok(Math.abs(highPass.a[1] - 0.99007225036621) < 1e-9);
  const [shelf] = kWeighting(48000);
  assert.ok(shelf.b[0] > 1, 'the shelf lifts the high end');
  // q = 0.7071752369554196 for the shelf, 0.5003270373238773 for the high pass.
  const [shelf44, highPass44] = kWeighting(44100);
  assert.notEqual(shelf44.a[0], shelf.a[0], 'the filters are rebuilt for the rate');
  assert.notEqual(highPass44.a[0], highPass.a[0]);
});

test('TRUE_PEAK_PHASES holds the 48 BS.1770 Annex 2 coefficients, digit for digit', () => {
  assert.equal(TRUE_PEAK_PHASES.length, 4);
  assert.equal(TRUE_PEAK_COEFFICIENT_COUNT, 48);
  for (const phase of TRUE_PEAK_PHASES) {
    assert.equal(phase.length, 12);
  }

  // Phase 0, as written in audio_analysis.rs:63-76.
  assert.deepEqual(
    [...TRUE_PEAK_PHASES[0]],
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
  );
  // Phase 2, as written in audio_analysis.rs:78-91.
  assert.deepEqual(
    [...TRUE_PEAK_PHASES[1]],
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
  );
  // Phase 3 is phase 1 reversed and phase 4 is phase 0 reversed.
  assert.deepEqual([...TRUE_PEAK_PHASES[2]], [...TRUE_PEAK_PHASES[1]].reverse());
  assert.deepEqual([...TRUE_PEAK_PHASES[3]], [...TRUE_PEAK_PHASES[0]].reverse());
});

test('a full scale 1 kHz sine in one channel reads about -3 LUFS', () => {
  const rate = 48000;
  const tone = sine(1000, 1, 10, rate);
  // The tone goes to the left channel only: BS.1770 sums the channel energies, so a 0 dBFS sine in
  // *both* channels reads 0 LUFS, 3 dB louder (audio_analysis.rs:170-175 sums, and the Rust test
  // `full_scale_997hz_sine_in_one_channel_reads_minus_3_lufs` at :441-451 puts the right channel
  // at zero to get -3.01 LKFS).
  const report = analyzeAudio({ left: tone, right: new Float32Array(tone.length), sampleRate: rate });

  // EBU Tech 3341 test 1: a stereo 1 kHz sine at -23 dBFS reads -23 LUFS (audio_analysis.rs:453-461),
  // so one full scale channel reads -3.01 LUFS.
  assert.ok(report.integratedLufs !== null);
  assert.ok(
    report.integratedLufs >= -3.4 && report.integratedLufs <= -2.6,
    `integrated ${String(report.integratedLufs)} LUFS`,
  );
  assert.equal(report.sampleRate, rate);
  assert.equal(report.durationSeconds, 10);
  assert.equal(report.silent, false);
});

test('the same tone 18.1 dB down reads about -21.1 LUFS, the ffmpeg baseline', () => {
  const rate = 48000;
  // 0.1245 is -18.10 dBFS, so the integrated loudness is -3.01 - 18.10 = -21.11 LUFS.
  const tone = sine(1000, 0.1245, 10, rate);
  const report = analyzeAudio({ left: tone, right: new Float32Array(tone.length), sampleRate: rate });

  assert.ok(
    report.integratedLufs !== null &&
      report.integratedLufs >= -21.6 &&
      report.integratedLufs <= -20.6,
    `integrated ${String(report.integratedLufs)} LUFS`,
  );
  assert.ok(Math.abs(toDb(0.1245) + 18.1) < 0.01, 'the amplitude is -18.1 dBFS');
});

test('a full scale 997 Hz sine in one channel reads -3.01 LKFS', () => {
  // The Rust test `full_scale_997hz_sine_in_one_channel_reads_minus_3_lufs`.
  const rate = 48000;
  const left = sine(997, 1, 5, rate);
  const right = new Float32Array(left.length);
  const report = analyzeAudio({ left, right, sampleRate: rate });

  assert.ok(
    report.integratedLufs !== null && Math.abs(report.integratedLufs + 3.01) < 0.5,
    `integrated ${String(report.integratedLufs)} LUFS`,
  );
  assert.ok(report.truePeakDb !== null && Math.abs(report.truePeakDb) < 0.5);
  assert.equal(report.clippingSamples, 0, 'a sine at exactly 1.0 never exceeds full scale');
});

test('the true peak of a full scale sine is 0 dBTP', () => {
  const rate = 48000;
  const tone = sine(1000, 1, 2, rate);
  const report = analyzeAudio({ left: tone, right: tone, sampleRate: rate });

  assert.ok(report.truePeakDb !== null, 'a finite value');
  assert.ok(
    report.truePeakDb >= -0.5 && report.truePeakDb <= 0.5,
    `true peak ${String(report.truePeakDb)} dBTP`,
  );
  assert.ok(report.samplePeakDb !== null && Math.abs(report.samplePeakDb) <= 0.01);
});

test('inter-sample peaks push the true peak above the sample peak', () => {
  // A signal that alternates sign every sample has samples of 1.0 but a 4x interpolated peak
  // well above that, which is exactly what a true peak meter is for.
  const alternating = new Float32Array(4096);
  for (let i = 0; i < alternating.length; i += 1) alternating[i] = i % 2 === 0 ? 1 : -1;
  const report = analyzeAudio({ left: alternating, right: alternating, sampleRate: 48000 });

  assert.ok(Math.abs((report.samplePeakDb ?? 0) - 0) < 0.01, 'samples sit at full scale');
  assert.ok((report.truePeakDb ?? 0) > 1, `interpolated peak is above: ${String(report.truePeakDb)}`);
  assert.ok(truePeak(alternating) > 1);
});

test('samples beyond full scale are counted as clipped', () => {
  const rate = 48000;
  const hot = sine(1000, 1.4, 1, rate);
  const report = analyzeAudio({ left: hot, right: hot, sampleRate: rate });

  assert.ok(report.clippingSamples > 0, `${report.clippingSamples} clipped samples`);
  assert.ok((report.samplePeakDb ?? 0) > 2.5);
  assert.ok((report.truePeakDb ?? 0) > 2.5, 'and the true peak follows');
});

test('digital silence is reported as silence, not as a number', () => {
  const rate = 44100;
  const silence = new Float32Array(rate * 3);
  const report = analyzeAudio({ left: silence, right: silence, sampleRate: rate });

  assert.equal(report.silent, true);
  assert.equal(report.integratedLufs, null, '-Infinity becomes null in the report');
  assert.equal(report.truePeakDb, null);
  assert.equal(report.samplePeakDb, null);
  assert.equal(report.clippingSamples, 0);
  assert.equal(report.silentRanges.length, 1);
  assert.ok((report.silentRanges[0]?.[0] ?? 1) < 0.1);
  assert.ok((report.silentRanges[0]?.[1] ?? 0) > 2.9);
});

test('silence followed by a tone is one silent range and two sections', () => {
  // The Rust test `silence_and_sections`.
  const rate = 44100;
  const left = new Float32Array(rate * 6);
  left.set(sine(440, 0.5, 3, rate), rate * 3);

  const report = analyzeAudio({ left, right: left, sampleRate: rate }, [
    { name: 'quiet', start: 0, end: rate * 3 },
    { name: 'tone', start: rate * 3, end: rate * 6 },
  ]);

  assert.equal(report.silent, false);
  assert.equal(report.silentRanges.length, 1);
  assert.ok((report.silentRanges[0]?.[0] ?? 1) < 0.1 && (report.silentRanges[0]?.[1] ?? 0) > 2.9);
  assert.equal(report.sections.length, 2);
  assert.equal(report.sections[0]?.integratedLufs, null, 'the silent section has no loudness');
  assert.equal(report.sections[0]?.name, 'quiet');
  assert.ok(report.sections[1]?.integratedLufs !== null, 'the tone section does');
  assert.equal(report.sections[1]?.startSeconds, 3);
  assert.equal(report.sections[1]?.endSeconds, 6);
});

test('the momentary windows are 400 ms long, every 100 ms', () => {
  const rate = 48000;
  const tone = sine(1000, 0.5, 2, rate);
  const report = analyzeAudio({ left: tone, right: tone, sampleRate: rate });

  // 2 s is 20 hops, a 4 hop window slides over 17 of them.
  assert.equal(report.momentary.length, 17);
  assert.equal(report.shortTerm.length, 0, '3 s is longer than the signal');
  assert.equal(report.momentary[0]?.timeSeconds, 0);
  assert.equal(report.momentary[1]?.timeSeconds, 0.1);
  assert.equal(report.momentary[0]?.endSeconds, 0.4);
  assert.equal(report.momentary[1]?.endSeconds, 0.5);
  assert.equal(MOMENTARY_HOPS, 4);
  assert.equal(SHORT_TERM_HOPS, 30);
  assert.ok(report.momentary.every((w) => w.lufs !== null), 'the whole signal is above the gate');
});

test('the gating thresholds are the BS.1770 ones', () => {
  assert.ok(Math.abs(ABSOLUTE_GATE_MEAN_SQUARE - 10 ** ((-70 + 0.691) / 10)) < 1e-18);
  assert.equal(RELATIVE_GATE_FACTOR, 0.1);
  // The gate lives in the mean square domain, so it is 10*log10 of it that reads -70 LUFS.
  assert.ok(Math.abs(10 * Math.log10(ABSOLUTE_GATE_MEAN_SQUARE) + 70 - 0.691) < 1e-9);
});

test('loudness is -0.691 plus ten times the log of the mean square', () => {
  assert.equal(energyToLufs(0), Number.NEGATIVE_INFINITY);
  assert.ok(Math.abs(energyToLufs(1) - -0.691) < 1e-12);
  assert.ok(Math.abs(energyToLufs(0.5) - (-0.691 + 10 * Math.log10(0.5))) < 1e-12);
  assert.equal(toDb(0), Number.NEGATIVE_INFINITY);
  assert.equal(toDb(1), 0);
  assert.ok(Math.abs(toDb(dbToGain(-6)) + 6) < 1e-12);
  assert.equal(finiteLufs(Number.NEGATIVE_INFINITY), null);
  assert.equal(finiteLufs(Number.NaN), null);
  assert.equal(finiteLufs(-14.0234), -14.02, 'the report rounds to two decimals');
});

test('a quiet passage mixed with a loud one barely moves the integrated loudness', () => {
  const rate = 48000;
  const loud = sine(1000, 1, 4, rate);
  const quiet = sine(1000, 0.001, 4, rate);
  const mixed = new Float32Array(loud.length * 2);
  mixed.set(loud, 0);
  mixed.set(quiet, loud.length);

  const whole = analyzeAudio({ left: mixed, right: mixed, sampleRate: rate });
  const loudOnly = analyzeAudio({ left: loud, right: loud, sampleRate: rate });

  // The quiet half is 60 dBFS down, so its mean square (1.17e-6 for a stereo pair) sits 10 dB
  // *above* the -70 LUFS absolute gate of 1.17e-7 (audio_analysis.rs:205): it is the relative gate,
  // not the absolute one, that drops the 37 fully quiet 400 ms blocks. What no gate can drop are
  // the three blocks that straddle the step, so the integrated loudness loses exactly
  // 10*log10(40 / 38.5) = 0.17 LU. Ungated, halving the loudness would cost 10*log10(2) = 3.01 LU.
  const drop = (loudOnly.integratedLufs ?? 0) - (whole.integratedLufs ?? 0);
  assert.ok(drop > 0, `the three boundary blocks pull the mean down a little, got ${drop}`);
  assert.ok(drop < 0.5, `gated: ${drop} LU, not the 3.01 LU an ungated mean would give`);
  assert.ok(3.01 - drop > 2.4, `and nowhere near the ungated answer: ${3.01 - drop} LU of margin`);
  assert.ok(Math.abs((whole.integratedLufs ?? 0) - (loudOnly.integratedLufs ?? 0)) < 1.5);
  // The quiet half is out of the short-term statistics too, so there is a range to report.
  assert.ok((whole.loudnessRangeLu ?? -1) > 0, 'the quiet passage gives the signal a range');
  assert.ok(loudOnly.loudnessRangeLu === 0, 'one level everywhere, so no range');
});

test('LoudnessAnalysis can measure a sub range on its own', () => {
  const rate = 48000;
  const left = sine(1000, 0.5, 4, rate);
  const analysis = new LoudnessAnalysis(left, left, rate);

  const first = analysis.integrated(0, rate * 2);
  const second = analysis.integrated(rate * 2, rate * 4);
  assert.ok(Number.isFinite(first) && Number.isFinite(second));
  assert.ok(Math.abs(first - second) < 0.1, 'two halves of the same tone');
  assert.equal(analysis.integrated(0, 10), Number.NEGATIVE_INFINITY, 'too short to measure');
  assert.ok(analysis.hopSeconds() > 0.099 && analysis.hopSeconds() < 0.101);
  assert.throws(() => new LoudnessAnalysis(left, left, 0), /sampleRate must be positive/);
});

test('analyzeAudio accepts interleaved samples as well as channels', () => {
  const rate = 48000;
  const tone = sine(1000, 0.5, 3, rate);
  const interleaved = new Float32Array(tone.length * 2);
  for (let i = 0; i < tone.length; i += 1) {
    interleaved[i * 2] = tone[i] ?? 0;
    interleaved[i * 2 + 1] = tone[i] ?? 0;
  }

  const fromChannels = analyzeAudio({ left: tone, right: tone, sampleRate: rate });
  const fromInterleaved = analyzeAudio({ interleaved, channels: 2, sampleRate: rate });
  assert.equal(fromInterleaved.integratedLufs, fromChannels.integratedLufs);
  assert.equal(fromInterleaved.durationSeconds, fromChannels.durationSeconds);
});

test('a mono mix is measured once per channel, like the Rust report', () => {
  const rate = 48000;
  const tone = sine(1000, 1.4, 1, rate);
  const mono = analyzeAudio({ left: tone, sampleRate: rate });
  const stereo = analyzeAudio({ left: tone, right: tone, sampleRate: rate });
  // `left.iter().chain(right)` counts a mono sample twice.
  assert.equal(mono.clippingSamples, stereo.clippingSamples);
  assert.equal(mono.durationSeconds, stereo.durationSeconds);
});
