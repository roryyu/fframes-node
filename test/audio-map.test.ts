/**
 * `AudioMap`: the track builder, the fade curves, ducking defaults and `resolve`.
 *
 * The oracle for the sample-accurate positioning is the Rust test
 * `audio_mix.rs:753-772 short_sounds_start_at_their_exact_sample`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AudioMap,
  DEFAULT_DUCKING,
  DEFAULT_FADE_CURVE,
  DEFAULT_TRACK_MIX,
  FADE_CURVES,
  audioTrack,
  audioTrackAll,
  fadeCurveGain,
  framesFromSeconds,
  resolve,
  resolveAudioFrames,
  resolveAudioMap,
  resolveDucking,
  samplesFromSeconds,
  samplesToFrames,
  secondsFromSamples,
} from '../src/audio/audio-map.ts';

const RATE = 44100;

test('a fresh track plays the whole file with every mix field at its default', () => {
  const track = audioTrack('sine.wav');
  assert.equal(track.file, 'sine.wav');
  assert.deepEqual(track.range, {});
  assert.deepEqual(track.mix, DEFAULT_TRACK_MIX);
  assert.equal(track.mix.gainDb, 0);
  assert.equal(track.mix.pan, 0);
  assert.equal(track.mix.fadeIn, 0);
  assert.equal(track.mix.fadeOut, 0);
  assert.equal(track.mix.fadeCurve, 'equalPower');
  assert.equal(track.mix.offset, 0);
  assert.equal(track.mix.duck, null);
  assert.equal(track.mix.voice, false);
  assert.equal(DEFAULT_FADE_CURVE, 'equalPower', 'FadeCurve::default() is EqualPower');
});

test('audioTrackAll is the same track without a range', () => {
  assert.deepEqual(audioTrackAll('a.wav').range, {});
  assert.deepEqual(audioTrack('a.wav').range, audioTrackAll('a.wav').range);
});

test('the builder records every mix field', () => {
  const track = audioTrack('music.mp3')
    .gainDb(-14)
    .pan(-0.4)
    .fadeIn(1)
    .fadeOut(2)
    .fadeCurve('sCurve')
    .offset(3.2)
    .voice();

  assert.equal(track.mix.gainDb, -14);
  assert.equal(track.mix.pan, -0.4);
  assert.equal(track.mix.fadeIn, 1);
  assert.equal(track.mix.fadeOut, 2);
  assert.equal(track.mix.fadeCurve, 'sCurve');
  assert.equal(track.mix.offset, 3.2);
  assert.equal(track.mix.voice, true);
  assert.equal(track.file, 'music.mp3', 'the builder keeps the file name');
});

test('the builder never mutates the track it was called on', () => {
  const base = audioTrack('a.wav');
  const loud = base.gainDb(-6);
  assert.equal(base.mix.gainDb, 0);
  assert.equal(loud.mix.gainDb, -6);
});

test('volume is a linear level converted to decibels', () => {
  assert.ok(Math.abs(audioTrack('a').volume(0.5).mix.gainDb - -6.0206) < 1e-3);
  assert.ok(Math.abs(audioTrack('a').volume(1).mix.gainDb) < 1e-9);
  assert.ok(audioTrack('a').volume(0).mix.gainDb < -110, 'clamped like the Rust builder');
  assert.equal(audioTrack('a').volume(0.5).effectiveGainDb(), audioTrack('a').volume(0.5).mix.gainDb);
});

test('pan, fade and offset are clamped at the edges', () => {
  assert.equal(audioTrack('a').pan(5).mix.pan, 1);
  assert.equal(audioTrack('a').pan(-5).mix.pan, -1);
  assert.equal(audioTrack('a').fadeIn(-1).mix.fadeIn, 0);
  assert.equal(audioTrack('a').fadeOut(-1).mix.fadeOut, 0);
  assert.equal(audioTrack('a').offset(-1).mix.offset, 0);
});

test('voice and duckUnderVoice set the flags the mixer reads', () => {
  const ducked = audioTrack('music.wav').duckUnderVoice();
  assert.equal(ducked.mix.voice, false, 'ducking is not the same as being a voice');
  assert.deepEqual(ducked.mix.duck, DEFAULT_DUCKING);
  assert.deepEqual(DEFAULT_DUCKING, {
    depthDb: -12,
    attack: 0.2,
    hold: 0.3,
    release: 0.8,
    mergeGap: 0.8,
  });
  assert.equal(audioTrack('voice.wav').voice().mix.voice, true);
});

test('duck takes a partial ducking and fills the rest with the defaults', () => {
  const ducking = audioTrack('a.wav').duck({ depthDb: -6 }).mix.duck;
  assert.deepEqual(ducking, { depthDb: -6, attack: 0.2, hold: 0.3, release: 0.8, mergeGap: 0.8 });
  assert.deepEqual(resolveDucking(null), DEFAULT_DUCKING);
  assert.deepEqual(resolveDucking({}), DEFAULT_DUCKING);
  assert.deepEqual(resolveDucking({ mergeGap: 2 }), { ...DEFAULT_DUCKING, mergeGap: 2 });
});

test('fadeCurveGain follows the four documented shapes', () => {
  assert.deepEqual([...FADE_CURVES], ['linear', 'equalPower', 'sCurve', 'exponential']);
  assert.equal(fadeCurveGain('linear', 0), 0);
  assert.equal(fadeCurveGain('linear', 0.5), 0.5);
  assert.equal(fadeCurveGain('linear', 1), 1);

  assert.equal(fadeCurveGain('equalPower', 0), 0);
  assert.ok(Math.abs(fadeCurveGain('equalPower', 0.5) - Math.sin(Math.PI / 4)) < 1e-12);
  assert.equal(fadeCurveGain('equalPower', 1), 1);

  assert.equal(fadeCurveGain('sCurve', 0), 0);
  assert.ok(Math.abs(fadeCurveGain('sCurve', 0.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(fadeCurveGain('sCurve', 1) - 1) < 1e-12);

  assert.equal(fadeCurveGain('exponential', 0), 0, 't <= 0 is digital silence');
  assert.equal(fadeCurveGain('exponential', 1), 1);
  assert.ok(Math.abs(fadeCurveGain('exponential', 0.5) - 10 ** -1.5) < 1e-12);
});

test('fadeCurveGain clamps the progress to 0..1', () => {
  for (const curve of FADE_CURVES) {
    assert.equal(fadeCurveGain(curve, -3), 0, curve);
    assert.equal(fadeCurveGain(curve, 7), 1, curve);
  }
});

test('the exponential fade is linear in decibels, -60 dB just after 0 and 0 dB at 1', () => {
  // audio_map.rs:198-203 — `if t <= 0 { 0 } else { 10f32.powf(-60 * (1 - t) / 20) }`. So t = 0 is
  // digital silence, and -60 dB is the limit from above: at t = 0.001 the curve is 20*log10 of
  // 10^(-2.997), i.e. exactly -59.94 dB, not -60 and not -57. The tolerance below is 0.1 dB
  // because 0.06 dB is the *exact* distance of the formula at that t — not a slack for a
  // near miss — while still being 100x tighter than the -59 vs -57 mixup it guards against.
  assert.equal(fadeCurveGain('exponential', 0), 0, 't <= 0 is digital silence');
  assert.ok(Math.abs(20 * Math.log10(fadeCurveGain('exponential', 1e-9)) + 60) < 0.01);
  assert.ok(Math.abs(20 * Math.log10(fadeCurveGain('exponential', 0.001)) + 60) < 0.1);
  assert.ok(Math.abs(20 * Math.log10(fadeCurveGain('exponential', 0.5)) + 30) < 1e-9, 'half is -30 dB');
  assert.equal(fadeCurveGain('exponential', 1), 1, '0 dB at the end of the fade');
  assert.ok(fadeCurveGain('exponential', 0.9) > 0.5, 'and most of the way up by 90%');
});

test('AudioMap.none has no tracks and AudioMap.of collects them', () => {
  const none = AudioMap.none();
  assert.equal(none.isNone(), true);
  assert.equal(none.isEmpty(), true);
  assert.equal(none.tracks, null);
  assert.deepEqual(none.trackNames(), []);
  assert.equal(none.usedAudioFiles(), null);

  const map = AudioMap.of([audioTrack('a.wav'), audioTrack('b.wav'), audioTrack('a.wav')]);
  assert.equal(map.isNone(), false);
  assert.equal(map.isEmpty(), false);
  assert.equal(map.tracks?.length, 3);
  assert.deepEqual(map.trackNames(), ['a.wav', 'b.wav'], 'de-duplicated, in order');
  assert.equal(AudioMap.of(null).isNone(), true);
  assert.equal(AudioMap.of([]).isEmpty(), true);
});

test('usedAudioFiles lists only the files whose range ends at Eof', () => {
  const map = AudioMap.of([
    audioTrack('whole.wav'),
    audioTrack('whole.wav'),
    audioTrack('part.wav', { start: 1, end: 2 }),
  ]);
  assert.deepEqual(map.usedAudioFiles(), ['whole.wav']);
});

test('flattenWithScenes appends the scene tracks and stays none when both are empty', () => {
  const none = AudioMap.none();
  assert.equal(none.flattenWithScenes([AudioMap.none()]).isNone(), true);

  const flat = none.flattenWithScenes([AudioMap.of([audioTrack('scene.wav')])]);
  assert.deepEqual(flat.trackNames(), ['scene.wav']);

  const both = AudioMap.of([audioTrack('video.wav')]).flattenWithScenes([
    AudioMap.of([audioTrack('scene.wav')]),
  ]);
  assert.deepEqual(both.trackNames(), ['video.wav', 'scene.wav']);
});

test('resolve places a track at its exact sample, not at a frame boundary', () => {
  // 4.25 s at 44 100 Hz is 187 425 samples: neither a whole second nor a whole frame.
  assert.equal(samplesFromSeconds(4.25, RATE), 187425);
  const resolved = resolve(AudioMap.of([audioTrack('whoosh.wav', { start: 4.25 })]), {
    fps: 30,
    sampleRate: RATE,
    resolveAudioDuration: () => 10,
  });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.range.start, 187425);
  assert.equal(resolved[0]?.file, 'whoosh.wav');
  // `Eof` is the file duration plus the start of the range minus the offset.
  assert.equal(resolved[0]?.range.end, samplesFromSeconds(14.25, RATE));
});

test('resolve mirrors the Rust exact-sample test for a short click', () => {
  // audio_mix.rs:753-772 — a click of 1000 samples at 0.51 s.
  const resolved = resolve(AudioMap.of([audioTrack('click', { start: 0.51 })]), {
    fps: 30,
    sampleRate: RATE,
    resolveAudioDuration: () => 1000 / RATE,
  });
  const start = Math.round(0.51 * RATE);
  assert.equal(start, 22491);
  assert.equal(resolved[0]?.range.start, start);
  // `Eof` is the file duration plus the start of the range (audio_map.rs:152, `eof_base` is
  // `start - offset` and the offset is 0), so the range is 1000 samples long: 22491 + 1000 = 23491.
  assert.equal(
    resolved[0]?.range.end,
    start + 1000,
    'the file is 1000 samples plus the 0.51 s base',
  );
});

test('resolve subtracts the offset from the Eof base so a file is not played twice', () => {
  const resolved = resolve(AudioMap.of([audioTrack('take.wav', { start: 10, end: 14 }).offset(3.2)]), {
    fps: 30,
    sampleRate: RATE,
    resolveAudioDuration: () => 60,
  });
  assert.equal(resolved[0]?.range.start, samplesFromSeconds(10, RATE));
  assert.equal(resolved[0]?.range.end, samplesFromSeconds(14, RATE));
  assert.equal(resolved[0]?.mix.offset, 3.2);
});

test('an explicit end is not extended by the file duration', () => {
  const loud = resolve(
    AudioMap.of([audioTrack('a.wav', { start: 1, end: 2 })]),
    { fps: 30, sampleRate: RATE, resolveAudioDuration: () => 999 },
  );
  assert.equal(loud[0]?.range.start, samplesFromSeconds(1, RATE));
  assert.equal(loud[0]?.range.end, samplesFromSeconds(2, RATE));
});

test('an empty or inverted range resolves to no track at all', () => {
  const resolved = resolve(
    AudioMap.of([
      audioTrack('a.wav', { start: 5, end: 5 }),
      audioTrack('b.wav', { start: 9, end: 2 }),
    ]),
    { fps: 30, sampleRate: RATE, resolveAudioDuration: () => 20 },
  );
  assert.deepEqual(resolved, []);
});

test('resolve throws when a range ends at Eof and the duration is unknown', () => {
  assert.throws(
    () => resolve(AudioMap.of([audioTrack('a.wav')]), { fps: 30, sampleRate: RATE }),
    /can not resolve the duration of "a.wav"/,
  );
  assert.throws(
    () =>
      resolve(AudioMap.of([audioTrack('a.wav')]), {
        fps: 30,
        sampleRate: RATE,
        resolveAudioDuration: () => null,
      }),
    /can not resolve the duration/,
  );
});

test('scene audio is placed at the scene start frame', () => {
  const resolved = resolve(AudioMap.of([audioTrack('global.wav', { start: 0, end: 1 })]), {
    fps: 30,
    sampleRate: RATE,
    resolveAudioDuration: () => 4,
    sceneAudio: [{ startFrame: 30, map: AudioMap.of([audioTrack('scene.wav', { start: 0, end: 1 })]) }],
  });

  assert.equal(resolved.length, 2);
  assert.equal(resolved[0]?.range.start, 0);
  assert.equal(resolved[1]?.range.start, samplesFromSeconds(1, RATE));
  assert.equal(resolved[1]?.range.end, samplesFromSeconds(2, RATE));
});

test('timelineEndFrame is the last frame the track occupies, for Duration auto', () => {
  const resolved = resolve(AudioMap.of([audioTrack('a.wav', { start: 0, end: 2 })]), {
    fps: 30,
    sampleRate: RATE,
    resolveAudioDuration: () => 2,
  });
  // 2 s at 30 fps is frame 60; the Rust integer math is `samples * fps / sample_rate`.
  assert.equal(resolved[0]?.timelineEndFrame, 60);
  assert.equal(samplesToFrames(samplesFromSeconds(2, RATE), { fps: 30, sampleRate: RATE }), 60);
});

test('the sample and frame unit conversions match the Rust AudioTimelineUnit impls', () => {
  // AudioTimelineSamples::from_seconds rounds and clamps (audio_map.rs:89-91).
  assert.equal(samplesFromSeconds(-5, RATE), 0, 'clamped at zero');
  assert.equal(samplesFromSeconds(4.25, RATE), 187425);
  assert.equal(secondsFromSamples(samplesFromSeconds(4.25, RATE), RATE), 4.25);
  // AudioTimelineSamples::to_frames is integer division (audio_map.rs:98-100).
  assert.equal(samplesToFrames(samplesFromSeconds(2, RATE), { fps: 30, sampleRate: RATE }), 60);
  // AudioTimelineFrames::from_seconds is `seconds_to_frames_floor` (audio_map.rs:108-110):
  // `(seconds.max(0) * fps + 1e-6).floor()`. The 1e-6 tolerance is in *frames*, so it forgives
  // 1e-9 s of float noise but not a 1e-5 s shortfall.
  assert.equal(framesFromSeconds(2.5, 30), 75);
  assert.equal(framesFromSeconds(0.5 - 1e-9, 30), 15, 'float noise of 3e-8 frames is forgiven');
  assert.equal(framesFromSeconds(0.99999, 30), 29, 'a real 3e-4 frame shortfall truncates');
  assert.equal(framesFromSeconds(-1, 30), 0);
});

test('resolveAudioMap wraps the tracks and knows the stream duration', () => {
  const map = resolveAudioMap(
    AudioMap.of([
      audioTrack('a.wav', { start: 0, end: 1 }),
      audioTrack('b.wav', { start: 0, end: 3 }),
    ]),
    { fps: 30, sampleRate: RATE, resolveAudioDuration: () => 3 },
  );
  assert.equal(map.tracks.length, 2);
  assert.equal(map.calcStreamDuration(), samplesFromSeconds(3, RATE));
  assert.equal(new AudioMap([]).tracks?.length, 0, 'AudioMap can be constructed directly');
  assert.equal(new AudioMap(null).isNone(), true);
});

test('roundMaxDuration clamps the ranges and drops tracks that start too late', () => {
  const map = resolveAudioMap(
    AudioMap.of([
      audioTrack('a.wav', { start: 0, end: 4 }),
      audioTrack('b.wav', { start: 2, end: 6 }),
      audioTrack('c.wav', { start: 9, end: 10 }),
    ]),
    { fps: 30, sampleRate: RATE, resolveAudioDuration: () => 10 },
  );
  const max = samplesFromSeconds(3, RATE);
  const clamped = map.roundMaxDuration(max);

  assert.equal(clamped.tracks.length, 2, 'the track at 9 s is not played at all');
  assert.equal(clamped.tracks[0]?.range.end, max);
  assert.equal(clamped.tracks[1]?.range.end, max);
  assert.equal(map.calcStreamDuration(), samplesFromSeconds(10, RATE), 'the original is untouched');
});

test('resolveAudioFrames gives the same map in whole frames', () => {
  const map = AudioMap.of([audioTrack('a.wav', { start: 1, end: 2.5 })]);
  const options = { fps: 30, sampleRate: RATE, resolveAudioDuration: () => 10 };

  const frames = resolveAudioFrames(map, options);
  assert.equal(frames[0]?.range.start, 30);
  assert.equal(frames[0]?.range.end, 75);
  assert.equal(frames[0]?.timelineEndFrame, 75);

  const samples = resolve(map, options);
  assert.equal(samples[0]?.range.start, samplesFromSeconds(1, RATE));
  assert.equal(samples[0]?.range.end, samplesFromSeconds(2.5, RATE));
});
