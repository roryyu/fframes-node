/**
 * `AudioMixer`: exact sample placement, linear summing, fades, ducking, de-click and the
 * lookahead limiter.
 *
 * Every assertion here mirrors a test of `audio_mix.rs:691-946`, so the Rust module tests are the
 * oracle. All sources are synthetic (constants, ramps and sines) — no file, no ffmpeg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AudioMap, audioTrack, resolve } from '../src/audio/audio-map.ts';
import type { ResolvedAudioTrack } from '../src/audio/audio-map.ts';
import {
  AudioMixer,
  DECLICK_SECONDS,
  DEFAULT_LIMITER_OPTIONS,
  DEFAULT_MIXER_OPTIONS,
  Limiter,
  dbToGain,
  duckDb,
  mergeRanges,
  mixAudioToFile,
  panGains,
} from '../src/audio/mixer.ts';
import type { LimiterOptions, MixerOptions, SampleRange, TrackAudio } from '../src/audio/mixer.ts';
import { readWavHeader } from '../src/audio/wav.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RATE = 44100;

function constant(value: number, count: number): Float32Array {
  const out = new Float32Array(count);
  out.fill(value);
  return out;
}

function ramp(count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = i / count;
  return out;
}

function tone(frequency: number, count: number, rate: number, amplitude = 1): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return out;
}

/** The `Media` of the Rust tests: a map of name to decoded samples. */
function media(files: Record<string, Float32Array>, sampleRate = RATE): Record<string, TrackAudio> {
  const out: Record<string, TrackAudio> = {};
  for (const [name, samples] of Object.entries(files)) {
    out[name] = { samples, right: null, sampleRate };
  }
  return out;
}

/** `audio_mix.rs:732-743 resolve` */
function resolveMap(
  map: AudioMap,
  files: Record<string, Float32Array>,
  fps = 30,
  sampleRate = RATE,
): ResolvedAudioTrack[] {
  return resolve(map, {
    fps,
    sampleRate,
    resolveAudioDuration: (file) => {
      const samples = files[file];
      if (samples === undefined) throw new Error(`unknown media file ${file}`);
      return samples.length / sampleRate;
    },
  });
}

/** `audio_mix.rs:745-751 no_master` */
function noMaster(): MixerOptions {
  return { limiter: null, declick: false };
}

function mix(
  tracks: ResolvedAudioTrack[],
  files: Record<string, TrackAudio>,
  extra: {
    sampleRate?: number;
    mapSampleRate?: number;
    outputRange?: SampleRange;
    totalSamples?: number;
    options?: MixerOptions;
  } = {},
): AudioMixer {
  return new AudioMixer({
    tracks,
    audio: files,
    sampleRate: extra.sampleRate ?? RATE,
    mapSampleRate: extra.mapSampleRate,
    outputRange: extra.outputRange,
    totalSamples: extra.totalSamples,
    options: extra.options ?? noMaster(),
  });
}

test('short sounds start at their exact sample', () => {
  // A click of 1000 samples at 0.51 s: not frame aligned and in the middle of an encoder block.
  const click = constant(0.5, 1000);
  const files = media({ click });
  const map = resolveMap(AudioMap.of([audioTrack('click', { start: 0.51 })]), { click });
  const start = Math.round(0.51 * RATE);
  assert.equal(map[0]?.range.start, start);
  // `Eof` is the file duration plus the start of the range (audio_map.rs:152), so the range is
  // 1000 samples long — the track plays the whole file, shifted by the 0.51 s base.
  assert.equal(map[0]?.range.end, start + 1000, 'the file is 1000 samples plus the 0.51 s base');

  const { left, right } = mix(map, files, { outputRange: { start: 0, end: RATE }, totalSamples: RATE }).renderAll();
  assert.equal(left[start - 1], 0);
  assert.equal(left[start], 0.5);
  assert.equal(right[start + 999], 0.5);
  assert.equal(left[start + 1000], 0, 'the file is over, even though the range goes on');
  assert.equal(left.filter((s) => s !== 0).length, 1000);
});

test('overlapping tracks sum linearly and the limiter catches the peaks', () => {
  const a = constant(0.6, RATE);
  const b = constant(0.3, RATE);
  const map = resolveMap(AudioMap.of([audioTrack('a'), audioTrack('b')]), { a, b });
  const quiet = mix(map, media({ a, b }), { outputRange: { start: 0, end: RATE }, totalSamples: RATE });
  assert.ok(Math.abs((quiet.renderAll().left[100] ?? 0) - 0.9) < 1e-6, '0.6 + 0.3 = 0.9');

  const loud = constant(0.9, RATE);
  const loudFiles = media({ a: loud, b: loud });
  const limited = mix(map, loudFiles, {
    outputRange: { start: 0, end: RATE },
    totalSamples: RATE,
    options: DEFAULT_MIXER_OPTIONS,
  });
  const { left } = limited.renderAll();
  const ceiling = dbToGain(-1);

  assert.ok(left.every((s) => Math.abs(s) <= ceiling + 1e-6), 'nothing above the ceiling');
  assert.ok(
    Math.abs((left[RATE / 2] ?? 0) - ceiling) < 1e-3,
    `mid signal is at the ceiling, got ${String(left[RATE / 2])}`,
  );
  assert.equal(DEFAULT_LIMITER_OPTIONS.ceilingDb, -1);
  assert.equal(DEFAULT_LIMITER_OPTIONS.lookaheadMs, 5);
  assert.equal(DEFAULT_LIMITER_OPTIONS.releaseMs, 80);
});

test('the limiter lags by lookahead - 1 samples and the mix compensates it', () => {
  const options: LimiterOptions = { ceilingDb: 20, lookaheadMs: 5, releaseMs: 80 };
  // A ceiling above the signal means the limiter never reduces the level, so the limiter on its own
  // is the input delayed by exactly `latency()` samples.
  assert.equal(Math.round((0.005 * RATE)), 221, '5 ms at 44.1 kHz');
  assert.equal(new Limiter(options, RATE).latency(), 220, 'audio_mix.rs:194-197, lookahead - 1');

  const limiter = new Limiter(options, RATE);
  const stepped: number[] = [];
  for (let i = 0; i < 222; i += 1) stepped.push(limiter.process(1, 1)[0]);
  assert.ok(
    stepped.slice(0, 220).every((value) => value === 0),
    'the delay line is primed with silence',
  );
  assert.equal(stepped[219], 0, 'still silent one sample earlier');
  assert.equal(stepped[220], 1, 'the first input sample comes out 220 samples later');
  assert.equal(stepped[221], 1);

  // The mixer primes the limiter with the `latency` samples in front of the range
  // (audio_mix.rs:576-584), so the *mix* is not delayed: a track that starts at sample 0 is heard
  // from sample 0, which is what keeps audio and video in sync.
  const step = constant(1, RATE);
  const files = { step: { samples: step, right: null, sampleRate: RATE } };
  const map = resolveMap(AudioMap.of([audioTrack('step')]), { step });
  const { left } = mix(map, files, {
    outputRange: { start: 0, end: RATE },
    totalSamples: RATE,
    options: { limiter: options, declick: false },
  }).renderAll();

  assert.equal(left[0], 1, 'the mix is not delayed by the limiter');
  assert.equal(left[220], 1, 'and stays sample exact across the block boundary');
  assert.equal(left[RATE - 1], 1, 'through the end of the range');
});

test('gain, pan and offset compose the way the Rust test asserts', () => {
  const source = ramp(RATE);
  const files = media({ ramp: source });
  const map = resolveMap(
    AudioMap.of([audioTrack('ramp', { start: 0, end: 0.5 }).offset(0.25).gainDb(-6.0206).pan(1)]),
    { ramp: source },
  );
  const { left, right } = mix(map, files, { outputRange: { start: 0, end: RATE }, totalSamples: RATE }).renderAll();

  // Offset: the first output sample is the file at 0.25 s, at half the level.
  assert.ok(Math.abs((right[0] ?? 0) - 0.125) < 1e-3, `got ${String(right[0])}`);
  // Hard right: nothing on the left.
  assert.ok(left.every((s) => Math.abs(s) < 1e-6));
  // Range end: silent after 0.5 s.
  assert.equal(right[RATE / 2 + 1], 0);
});

test('an equal power fade in reaches sin(PI/4) at its midpoint', () => {
  const source = constant(1, RATE);
  const files = media({ tone: source });
  const map = resolveMap(AudioMap.of([audioTrack('tone').fadeIn(0.5)]), { tone: source });
  const { left } = mix(map, files, { outputRange: { start: 0, end: RATE }, totalSamples: RATE }).renderAll();

  // fade_in(0.5) is 22 050 samples, so the midpoint is frame 11 025 of the fade.
  assert.ok(
    Math.abs((left[RATE / 4] ?? 0) - Math.sin(Math.PI / 4)) < 1e-6,
    `got ${String(left[RATE / 4])}`,
  );
  assert.equal(left[0], 0, 'a fade in starts silent');
  assert.equal(left[RATE - 1], 1, 'full level after the fade');

  // The same for a fade over the whole track.
  const whole = resolveMap(AudioMap.of([audioTrack('tone').fadeIn(1)]), { tone: source });
  const wholeMix = mix(whole, files, { outputRange: { start: 0, end: RATE }, totalSamples: RATE }).renderAll();
  assert.ok(
    Math.abs((wholeMix.left[RATE / 2] ?? 0) - Math.sin(Math.PI / 4)) < 1e-6,
    `whole-track fade midpoint: ${String(wholeMix.left[RATE / 2])}`,
  );
});

test('a linear fade out is silent on its last sample', () => {
  const source = constant(1, RATE);
  const files = media({ tone: source });
  const map = resolveMap(
    AudioMap.of([audioTrack('tone').fadeOut(1).fadeCurve('linear')]),
    { tone: source },
  );
  const { left } = mix(map, files, { outputRange: { start: 0, end: RATE }, totalSamples: RATE }).renderAll();

  // fade_out(1) covers the whole track: to_end / fade_out runs from ~1 down to 0.
  assert.ok((left[0] ?? 0) > 0.999, `the first sample is nearly full, got ${String(left[0])}`);
  assert.ok(Math.abs((left[RATE / 2] ?? 0) - 0.5) < 1e-3);
  assert.equal(left[RATE - 1], 0, 'to_end - 1 == 0 at the last sample');
});

test('de-click ramps the first 5 ms linearly whenever a track starts inside a sound', () => {
  // declick_in needs `offset > 0`, so the track starts in the middle of the file.
  const source = constant(1, RATE);
  const files = media({ cut: source });
  const map = resolveMap(AudioMap.of([audioTrack('cut').offset(0.25)]), { cut: source });
  const { left } = mix(map, files, {
    outputRange: { start: 0, end: RATE },
    totalSamples: RATE,
    options: { limiter: null, declick: true },
  }).renderAll();

  const edge = DECLICK_SECONDS * RATE;
  assert.equal(left[0], 0, 'the first sample is muted');
  assert.ok(Math.abs((left[110] ?? 0) - 110 / edge) < 1e-6, `half way: ${String(left[110])}`);
  assert.ok(Math.abs((left[220] ?? 0) - 220 / edge) < 1e-6, `almost full: ${String(left[220])}`);
  assert.ok(Math.abs((left[221] ?? 0) - 1) < 1e-6, 'and full right after the ramp');
  assert.equal(edge, 220.5, '5 ms at 44.1 kHz');
});

test('de-click can be turned off', () => {
  const source = constant(1, RATE);
  const files = media({ cut: source });
  const map = resolveMap(AudioMap.of([audioTrack('cut').offset(0.25)]), { cut: source });
  const { left } = mix(map, files, {
    outputRange: { start: 0, end: RATE },
    totalSamples: RATE,
    options: { limiter: null, declick: false },
  }).renderAll();
  assert.equal(left[0], 1, 'no ramp, the cut is audible');
});

test('the rendered range itself is de-clicked at both ends', () => {
  const source = constant(1, 4 * RATE);
  const files = media({ long: source });
  const map = resolveMap(AudioMap.of([audioTrack('long')]), { long: source });
  const { left } = mix(map, files, {
    outputRange: { start: RATE, end: 3 * RATE },
    totalSamples: 4 * RATE,
    options: { limiter: null, declick: true },
  }).renderAll();

  // The range de-click truncates the 5 ms edge to whole samples, the track de-click does not.
  const edge = Math.trunc(DECLICK_SECONDS * RATE);
  assert.equal(edge, 220);
  assert.equal(left.length, 2 * RATE);
  assert.equal(left[0], 0, 'the range starts inside the sound');
  assert.ok(Math.abs((left[110] ?? 0) - 110 / edge) < 1e-6);
  assert.equal(left[RATE], 1, 'full level in the middle');
  assert.ok((left[2 * RATE - 2] ?? 0) > 0, 'and the tail is still fading out');
  assert.equal(left[2 * RATE - 1], 0, 'the range ends inside it');
});

test('ducking follows the voice ranges', () => {
  const music = constant(0.5, 4 * RATE);
  const voice = constant(0, RATE);
  const files = media({ music, voice });
  const map = resolveMap(
    AudioMap.of([audioTrack('music').duckUnderVoice(), audioTrack('voice', { start: 1 }).voice()]),
    { music, voice },
  );
  const { left } = mix(map, files, {
    outputRange: { start: 0, end: 4 * RATE },
    totalSamples: 4 * RATE,
  }).renderAll();

  const ducked = 0.5 * dbToGain(-12);
  assert.ok(Math.abs((left[RATE / 4] ?? 0) - 0.5) < 1e-6, 'before the attack');
  assert.ok(Math.abs((left[RATE + RATE / 2] ?? 0) - ducked) < 1e-4, 'during the voice');
  const attackSample = left[RATE - RATE / 10] ?? 0;
  assert.ok(attackSample < 0.5 && attackSample > ducked, 'the attack ramp is in between');
  // Voice ends at 2 s, hold 0.3 s, release 0.8 s: back to full level at 3.1 s.
  const releaseSample = left[2 * RATE + RATE / 2] ?? 0;
  assert.ok(releaseSample > ducked && releaseSample < 0.5, 'the release ramp is in between');
  assert.ok(Math.abs((left[3 * RATE + RATE / 5] ?? 0) - 0.5) < 1e-6, 'released');
});

test('a voice at 3..5 s ducks the music to -12 dB in the middle and back to 0 dB after it', () => {
  const music = constant(0.5, 8 * RATE);
  const voice = constant(0, 2 * RATE);
  const files = media({ music, voice });
  const map = resolveMap(
    AudioMap.of([
      audioTrack('music').duckUnderVoice(),
      audioTrack('voice', { start: 3 }).voice(),
    ]),
    { music, voice },
  );
  const { left } = mix(map, files, {
    outputRange: { start: 0, end: 8 * RATE },
    totalSamples: 8 * RATE,
  }).renderAll();

  // The voice range is 3 s .. (2 s file + 3 s base) = 5 s.
  assert.equal(map[1]?.range.start, 3 * RATE);
  assert.equal(map[1]?.range.end, 5 * RATE);

  const ducked = 0.5 * dbToGain(-12);
  const mid = left[4 * RATE] ?? 0;
  assert.ok(Math.abs(20 * Math.log10(mid / 0.5) + 12) < 0.5, `effective gain ${String(20 * Math.log10(mid / 0.5))} dB`);
  assert.ok(Math.abs((left[RATE] ?? 0) - 0.5) < 1e-6, 'before the voice');
  // hold 0.3 s then release 0.8 s after 5 s, so full level from 6.1 s.
  assert.ok(Math.abs((left[7 * RATE] ?? 0) - 0.5) < 1e-6, 'released');
  const mid2 = left[5 * RATE + 22050] ?? 0;
  assert.ok(mid2 > ducked && mid2 < 0.5, 'the release ramp is in between');
});

test('a voice track does not duck itself', () => {
  const voice = constant(0.5, 2 * RATE);
  const files = media({ voice });
  const map = resolveMap(
    AudioMap.of([audioTrack('voice', { start: 0.5 }).voice().duckUnderVoice()]),
    { voice },
  );
  const { left } = mix(map, files, {
    outputRange: { start: 0, end: 2 * RATE },
    totalSamples: 2 * RATE,
  }).renderAll();
  assert.ok(Math.abs((left[RATE] ?? 0) - 0.5) < 1e-6, 'still at full level inside its own range');
});

test('mergeRanges joins ranges closer than the merge gap', () => {
  const merged = mergeRanges(
    [
      { start: 0, end: 10 },
      { start: 12, end: 20 },
      { start: 100, end: 110 },
    ],
    2,
  );
  assert.deepEqual(merged, [
    { start: 0, end: 20 },
    { start: 100, end: 110 },
  ]);
  assert.deepEqual(mergeRanges([], 1), []);
  assert.deepEqual(mergeRanges([{ start: 5, end: 6 }], 0), [{ start: 5, end: 6 }]);
});

test('duckDb is a raised cosine ramp with hold and release, in dB', () => {
  // audio_mix.rs:321-348. The envelope is a pure function of samples, so the rate is 1 here and
  // the ducking fields below are in samples: a voice from 100 to 200 with a 20 / 10 / 30 sample
  // attack / hold / release puts every ramp boundary on a round number.
  const voices = [{ start: 100, end: 200 }];
  const ducking = { depthDb: -12, attack: 20, hold: 10, release: 30, mergeGap: 0 };
  /** `duckDb` at a sample, with -0 folded to 0 so `assert.equal` can compare it. */
  const at = (n: number): number => duckDb(voices, ducking, n, 1) + 0;

  // The ramp endpoints are exactly 0 and `depthDb` (no `cos` in that arithmetic), so they stay
  // exact comparisons; every sample in the middle of a ramp goes through `Math.cos`, whose result
  // is irrational in binary, so those are compared with a tolerance against the closed form.
  assert.equal(at(79), 0, 'before the attack starts');
  assert.equal(at(80), 0, 'the raised cosine ramp starts at 0 dB');
  assert.ok(Math.abs(at(90) + 6) < 1e-9, 'half way down the attack is -6 dB');
  assert.equal(at(100), -12, 'fully down when the voice starts');
  assert.equal(at(209), -12, 'held until the voice end plus hold');
  assert.equal(at(210), -12, 'the release ramp starts at the bottom');
  assert.ok(Math.abs(at(225) + 6) < 1e-9, 'half way up the release is -6 dB');
  // The release ends at `upFrom + release` = 240 and is *excluded* there (audio_mix.rs:331), so at
  // 239 the ramp is 29/30 of the way up: `-12 * (1 - raised_cosine(29/30))` = -6 * (1 + cos(29π/30)),
  // i.e. -0.0327 dB — not yet 0, which is the point of the next assertion.
  assert.ok(
    Math.abs(at(239) - -6 * (1 + Math.cos((29 / 30) * Math.PI))) < 1e-9,
    `one sample before the ramp ends, got ${String(at(239))}`,
  );
  assert.equal(at(240), 0, 'and exactly released when it ends');
  assert.equal(duckDb([], ducking, 150, 1) + 0, 0, 'no voices, no ducking');
});

test('resampling keeps a tone at its frequency and level', () => {
  const sourceRate = 48000;
  const source = tone(1000, 48000, sourceRate);
  const files = { tone: { samples: source, right: null, sampleRate: sourceRate } };
  const map = resolveMap(AudioMap.of([audioTrack('tone')]), { tone: source });

  const { left } = mix(map, files, {
    outputRange: { start: 0, end: RATE },
    totalSamples: RATE,
  }).renderAll();

  for (const i of [1000, 20000, 40000]) {
    const expected = Math.sin((2 * Math.PI * 1000 * i) / RATE);
    assert.ok(
      Math.abs((left[i] ?? 0) - expected) < 2e-3,
      `${i}: ${String(left[i])} vs ${expected}`,
    );
  }
});

test('a map resolved at another rate is rescaled onto the output timeline', () => {
  const click = constant(0.5, 100);
  const files = media({ click });
  // Resolved at 44.1 kHz, mixed at 48 kHz: the click still starts at 0.5 s.
  const map = resolveMap(AudioMap.of([audioTrack('click', { start: 0.5 })]), { click });
  const { left } = mix(map, files, {
    sampleRate: 48000,
    mapSampleRate: RATE,
    outputRange: { start: 0, end: 48000 },
    totalSamples: 48000,
  }).renderAll();

  assert.equal(left[23999], 0);
  assert.ok((left[24000] ?? 0) > 0.4);
});

test('a range render starts in the middle of a track', () => {
  const source = ramp(RATE);
  const files = media({ ramp: source });
  const map = resolveMap(AudioMap.of([audioTrack('ramp')]), { ramp: source });
  const { left } = mix(map, files, {
    outputRange: { start: RATE / 2, end: RATE },
    totalSamples: RATE,
  }).renderAll();

  assert.equal(left.length, RATE / 2);
  assert.ok(Math.abs((left[0] ?? 0) - 0.5) < 1e-4);
});

test('a stereo file is balanced, not panned', () => {
  const leftSource = constant(0.5, RATE);
  const rightSource = constant(0.25, RATE);
  const files = { s: { samples: leftSource, right: rightSource, sampleRate: RATE } };
  const map = resolveMap(AudioMap.of([audioTrack('s').pan(1)]), { s: leftSource });
  const out = mix(map, files, { outputRange: { start: 0, end: RATE }, totalSamples: RATE }).renderAll();

  assert.ok(Math.abs((out.left[RATE / 2] ?? 0) - 0.5 * Math.cos(Math.PI / 2)) < 1e-6);
  assert.ok(Math.abs((out.right[RATE / 2] ?? 0) - 0.25) < 1e-6, 'the right side is untouched');
});

test('panGains compensates a mono source to unity at the centre', () => {
  assert.deepEqual(panGains(0, false), [1, 1]);
  assert.deepEqual(panGains(1e-9, false), [1, 1], 'a tiny pan is treated as centre');
  const [leftHard, rightHard] = panGains(1, false);
  assert.ok(Math.abs(leftHard - 0) < 1e-12);
  assert.equal(rightHard, 1);
  const [leftQuarter, rightQuarter] = panGains(0.5, false);
  assert.ok(leftQuarter > 0 && rightQuarter > leftQuarter, 'more to the right than to the left');
  assert.ok(leftQuarter <= 1 && rightQuarter <= 1, 'the Rust code caps both at unity');
  assert.equal(rightQuarter, 1, 'a hard-ish pan reaches unity on the near side');
  assert.ok(panGains(1, true)[0] < 1e-12, 'a stereo file is balanced by attenuation');
  assert.ok(panGains(-1, true)[1] < 1e-12, 'and the other way round');
  assert.deepEqual(panGains(0, true), [1, 1], 'no pan, no change');
});

test('the master gain scales the sum after the tracks are added', () => {
  const source = constant(0.5, RATE);
  const files = media({ a: source });
  const map = resolveMap(AudioMap.of([audioTrack('a')]), { a: source });
  const { left } = mix(map, files, {
    outputRange: { start: 0, end: RATE },
    totalSamples: RATE,
    options: { limiter: null, declick: false, masterGainDb: -6 },
  }).renderAll();
  assert.ok(Math.abs((left[RATE / 2] ?? 0) - 0.5 * dbToGain(-6)) < 1e-6);
});

test('a track whose file is missing is skipped and reported', () => {
  const source = constant(0.5, RATE);
  const map = resolveMap(AudioMap.of([audioTrack('present'), audioTrack('gone')]), {
    present: source,
    gone: source,
  });
  const mixer = mix(map, media({ present: source }), {
    outputRange: { start: 0, end: RATE },
    totalSamples: RATE,
  });

  assert.deepEqual(mixer.missingFiles(), ['gone']);
  assert.deepEqual(
    mixer.preparedTracks().map((t) => t.file),
    ['present'],
  );
  assert.ok(Math.abs((mixer.renderAll().left[RATE / 2] ?? 0) - 0.5) < 1e-6);
});

test('activeTracksAt reports the file position and the effective level', () => {
  const source = constant(0.5, 2 * RATE);
  const files = media({ music: source, voice: constant(0, RATE) });
  const map = resolveMap(
    AudioMap.of([
      audioTrack('music', { start: 0.5 }).offset(0.25).gainDb(-6),
      audioTrack('voice', { start: 1 }).voice(),
    ]),
    { music: source, voice: constant(0, RATE) },
  );
  const mixer = mix(map, files, {
    outputRange: { start: 0, end: 2 * RATE },
    totalSamples: 2 * RATE,
  });

  const inMusic = mixer.activeTracksAt(RATE / 2);
  assert.equal(inMusic.length, 1);
  assert.equal(inMusic[0]?.file, 'music');
  // The track starts on the timeline at 0.5 s, which is 0.25 s into the file because of the
  // offset: `fileSeconds` is the position inside the file, not on the timeline.
  assert.ok(Math.abs((inMusic[0]?.fileSeconds ?? 0) - 0.25) < 1e-9);
  assert.ok(Math.abs((inMusic[0]?.gainDb ?? 0) - -6) < 1e-6, 'gain, before ducking');
  assert.equal(inMusic[0]?.voice, false);
  assert.equal(inMusic[0]?.duckedDb, 0);

  const both = mixer.activeTracksAt(RATE + RATE / 2);
  assert.equal(both.length, 2);
  assert.equal(both.find((t) => t.file === 'voice')?.voice, true);
  assert.deepEqual(mixer.activeTracksAt(0), [], 'nothing plays at the first sample');
});

test('the interleaved output is the stereo mix, left then right', () => {
  const leftSource = constant(0.5, 1000);
  const rightSource = constant(0.25, 1000);
  const files = { s: { samples: leftSource, right: rightSource, sampleRate: RATE } };
  const map = resolveMap(AudioMap.of([audioTrack('s')]), { s: leftSource });
  const mixer = mix(map, files, { outputRange: { start: 0, end: 1000 }, totalSamples: 1000 });

  const interleaved = mixer.renderInterleaved();
  assert.equal(interleaved.length, 2000);
  assert.equal(interleaved[0], 0.5);
  assert.equal(interleaved[1], 0.25);
  assert.equal(interleaved[1998], 0.5);
});

test('mixAudioToFile writes a 16-bit stereo WAV of the whole mix', () => {
  const source = constant(0.5, 1000);
  const files = media({ a: source });
  const map = resolveMap(AudioMap.of([audioTrack('a')]), { a: source });
  const path = join(mkdtempSync(join(tmpdir(), 'fframes-mixer-')), 'mix.wav');

  const header = mixAudioToFile({ tracks: map, audio: files, sampleRate: RATE }, path, {
    dither: false,
  });

  assert.equal(header.formatTag, 1);
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, RATE);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.frames, 1000);
  assert.equal(header.dataSize, 4000);
  assert.deepEqual(readWavHeader(path).dataSize, 4000, 'the header reads back');
  // The 16-bit layout: a 16-byte `fmt ` (no `fact` chunk) and a data chunk at byte 44.
  assert.equal(header.fmtSize, 16);
  assert.equal(header.blockAlign, 4, '2 channels of 2 bytes');
  assert.equal(header.byteRate, RATE * 4);
  assert.equal(header.dataOffset, 44);
  assert.equal(header.float, false);
});

test('mixAudioToFile can write 32-bit float', () => {
  const source = constant(0.5, 10);
  const files = media({ a: source });
  const map = resolveMap(AudioMap.of([audioTrack('a')]), { a: source });
  const path = join(mkdtempSync(join(tmpdir(), 'fframes-mixer-')), 'mix-f32.wav');

  const header = mixAudioToFile({ tracks: map, audio: files, sampleRate: RATE }, path, {
    float: true,
  });
  assert.equal(header.formatTag, 3);
  assert.equal(header.bitsPerSample, 32);
  assert.equal(header.fmtSize, 18);
  // The float layout carries a `fact` chunk, so the frame count comes from there and the data
  // starts at byte 58 (audio_analysis.rs:382-389).
  assert.equal(header.frames, 10, 'the fact chunk declares the frame count');
  assert.equal(header.blockAlign, 8);
  assert.equal(header.dataOffset, 58);
  assert.equal(header.dataSize, 80, '10 stereo frames of 4 bytes');
  assert.equal(header.float, true);
});

test('the mixer rejects an impossible sample rate', () => {
  assert.throws(
    () => new AudioMixer({ tracks: [], audio: {}, sampleRate: 0 }),
    /positive integer/,
  );
});
