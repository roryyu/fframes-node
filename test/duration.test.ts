/**
 * Duration resolution, mirroring `.source/fframes/fframes/src/duration.rs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDuration,
  auto,
  frames,
  fromAudio,
  seconds,
  secondsToFramesFloor,
  subDuration,
  toFrames,
  usedAudioFiles,
  type Duration,
} from '../src/core/duration.ts';
import { Scenes } from '../src/core/scenes.ts';
import { Svgr } from '../src/core/svgr.ts';
import type { Scene } from '../src/core/types.ts';

function sceneWithDuration(duration: Duration, name?: string): Scene {
  return {
    name,
    duration: () => duration,
    renderFrame: () => Svgr.empty(),
  };
}

test('seconds truncate to whole frames', () => {
  assert.equal(seconds(2.5).kind, 'seconds');
  assert.equal(toFrames(seconds(2.5), 30), 75);
  assert.equal(toFrames(seconds(2.567), 30), 77, '2.567 * 30 = 77.01, truncated');
  assert.equal(toFrames(seconds(0), 30), 0);
  assert.equal(toFrames(seconds(0.5), 30), 15);
  assert.equal(toFrames(seconds(0.033), 30), 0, 'anything below a frame is dropped');
});

test('frames are kept as is', () => {
  assert.equal(frames(10).kind, 'frames');
  assert.equal(toFrames(frames(10), 30), 10);
  assert.equal(toFrames(frames(0), 30), 0);
  assert.equal(toFrames(frames(10), 24), 10, 'the fps does not change a frame count');
});

test('a duration from audio uses the probed file length', () => {
  const durations: Record<string, number> = { 'a.wav': 2.5, 'b.wav': 1 };
  const resolve = (file: string): number | null => durations[file] ?? null;

  assert.equal(fromAudio('a.wav').kind, 'fromAudio');
  assert.equal(toFrames(fromAudio('a.wav'), 30, { resolveAudioDuration: resolve }), 75);
  assert.equal(toFrames(fromAudio('b.wav'), 30, { resolveAudioDuration: resolve }), 30);
  assert.throws(
    () => toFrames(fromAudio('missing.wav'), 30, { resolveAudioDuration: resolve }),
    /can not resolve the duration of "missing.wav"/,
  );
  assert.throws(() => toFrames(fromAudio('a.wav'), 30), /resolveAudioDuration is required/);
});

test('a probed duration is tolerant to floating point error', () => {
  // The tolerance is 1e-6 of a frame, so a value a few float ULPs below a whole second
  // still counts as a whole second.
  assert.equal(secondsToFramesFloor(9.99999999, 30), 300);
  assert.equal(secondsToFramesFloor(0, 30), 0);
  assert.equal(secondsToFramesFloor(-5, 30), 0, 'negative durations clamp to zero');
  assert.equal(toFrames(fromAudio('a.wav'), 30, { resolveAudioDuration: () => 9.99999999 }), 300);
});

test('auto resolves from the scene durations', () => {
  assert.equal(auto.kind, 'auto');
  const scenes = Scenes.from([
    sceneWithDuration(seconds(2)),
    sceneWithDuration(seconds(1)),
    sceneWithDuration(frames(15)),
  ]);
  const resolved = scenes.resolveTimeline(30);
  assert.equal(resolved.totalDurationInFrames, 60 + 30 + 15);
  assert.equal(
    toFrames(auto, 30, { scenesDurationInFrames: resolved.totalDurationInFrames }),
    105,
  );
});

test('auto falls back to the last frame of the audio map', () => {
  const fromAudioMap = toFrames(auto, 30, {
    audioMap: { tracks: [{ timelineEndFrame: 240 }, { timelineEndFrame: 450 }] },
  });
  assert.equal(fromAudioMap, 450, 'the longest track wins');
});

test('auto without scenes or audio is an error', () => {
  assert.throws(() => toFrames(auto, 30), /auto requires either scenes or an audio map/);
  assert.throws(
    () => toFrames(auto, 30, { audioMap: { tracks: [] } }),
    /auto requires either scenes or an audio map/,
  );
});

test('durations add up', () => {
  const total = addDuration(seconds(2), frames(30));
  assert.equal(total.kind, 'add');
  assert.equal(toFrames(total, 30), 90);
  assert.equal(toFrames(addDuration(seconds(1), addDuration(seconds(1), seconds(1))), 30), 90);
  assert.equal(
    toFrames(addDuration(auto, seconds(1)), 30, { scenesDurationInFrames: 30 }),
    60,
    'auto resolves inside a sum too',
  );
});

test('durations subtract and saturate at zero', () => {
  const rest = subDuration(seconds(3), seconds(1));
  assert.equal(rest.kind, 'sub');
  assert.equal(toFrames(rest, 30), 60);
  assert.equal(toFrames(subDuration(seconds(1), seconds(2)), 30), 0, 'never negative');
  assert.equal(toFrames(subDuration(frames(10), frames(20)), 30), 0);
  assert.equal(
    toFrames(subDuration(auto, seconds(1)), 30, { scenesDurationInFrames: 30 }),
    0,
  );
});

test('used_audio_files walks the whole tree', () => {
  assert.deepEqual(usedAudioFiles(seconds(1)), []);
  assert.deepEqual(usedAudioFiles(fromAudio('a.wav')), ['a.wav']);
  assert.deepEqual(usedAudioFiles(auto), []);
  assert.deepEqual(
    usedAudioFiles(addDuration(fromAudio('a.wav'), subDuration(seconds(1), fromAudio('b.wav')))),
    ['a.wav', 'b.wav'],
  );
});

test('a duration tree can be nested arbitrarily', () => {
  const tree = addDuration(
    subDuration(addDuration(seconds(10), fromAudio('a.wav')), seconds(2)),
    auto,
  );
  const resolved = toFrames(tree, 30, {
    resolveAudioDuration: () => 5,
    scenesDurationInFrames: 30,
  });
  assert.equal(resolved, (10 * 30 + 150 - 60) + 30);
});
