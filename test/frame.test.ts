/**
 * `Frame`: time conversions, scene offsets and the animation entry points.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Frame, setVisualizationResolver } from '../src/core/frame.ts';
import { Easing } from '../src/core/animation/easing.ts';
import { timeline } from '../src/core/animation/timeline.ts';
import { Color } from '../src/core/color.ts';
import { Transform } from '../src/core/transform.ts';
import { DecodedAudio } from '../src/media/audio-decode.ts';
import type { VisualizeFrameInput } from '../src/core/types.ts';

test('seconds is the index divided by the fps', () => {
  assert.equal(new Frame(0, 0, 30).seconds(), 0);
  assert.equal(new Frame(15, 15, 30).seconds(), 0.5);
  assert.equal(new Frame(30, 30, 30).seconds(), 1);
  assert.equal(new Frame(45, 45, 60).seconds(), 0.75);
});

test('frame and second conversions round trip through the fps', () => {
  const frame = new Frame(0, 0, 30);
  assert.equal(frame.frameToSecond(60), 2);
  assert.equal(frame.secondToFrame(2), 60);
  assert.equal(frame.secondToFrame(2.5), 75);
  assert.equal(frame.secondToFrame(0.5), 15);
  assert.equal(new Frame(0, 0, 24).frameToSecond(48), 2);
});

test('secondToFrame truncates instead of rounding', () => {
  const frame = new Frame(0, 0, 30);
  assert.equal(frame.secondToFrame(0.99), 29);
  assert.equal(frame.secondToFrame(-1), -30, 'no clamping, like the Rust cast');
});

test('animate samples the timeline at the frame time', () => {
  const animation = timeline<number>({
    start: 0,
    end: 2,
    from: 0,
    to: 100,
    easing: Easing.linear,
  });

  // 30 fps, so frame 30 is exactly one second in: half of the tween.
  assert.ok(Math.abs(new Frame(30, 30, 30).animate(animation) - 50) < 1e-9);
  assert.ok(Math.abs(new Frame(0, 0, 30).animate(animation) - 0) < 1e-9);
  assert.ok(Math.abs(new Frame(60, 60, 30).animate(animation) - 100) < 1e-9);
  assert.ok(Math.abs(new Frame(90, 90, 30).animate(animation) - 100) < 1e-9, 'past the end');
});

test('animate matches a hand computed eased value', () => {
  const animation = timeline<number>({
    start: 0,
    end: 1,
    from: 200,
    to: 1000,
    easing: Easing.easeInOut,
  });

  const frame = new Frame(15, 15, 30); // 0.5 s
  const progress = Easing.easeInOut.solve(0.5);
  assert.ok(Math.abs(frame.animate(animation) - (200 + (1000 - 200) * progress)) < 1e-9);
});

test('animate interpolates colors and transforms', () => {
  const colorAnimation = timeline<Color>({
    start: 0,
    end: 2,
    from: Color.fromHex('#000000'),
    to: Color.fromHex('#ffffff'),
    easing: Easing.linear,
  });
  assert.equal(new Frame(30, 30, 30).animate(colorAnimation).r, 127);

  const transformAnimation = timeline<Transform>({
    start: 0,
    end: 2,
    from: Transform.translate(0, 0),
    to: Transform.translate(0, 100),
    easing: Easing.linear,
  });
  assert.equal(new Frame(30, 30, 30).animate(transformAnimation).toSvgAttribute(), 'translate(0 50)');
});

test('animateLoop wraps around the total duration', () => {
  const animation = timeline<number>({
    start: 0,
    end: 1,
    from: 0,
    to: 10,
    easing: Easing.linear,
  });

  assert.ok(Math.abs(new Frame(15, 15, 30).animateLoop(animation) - 5) < 1e-9);
  // 3 s at 30 fps wraps to 0 s: 3 % 1 = 0.
  assert.ok(Math.abs(new Frame(90, 90, 30).animateLoop(animation) - 0) < 1e-9);
});

test('animateRuntime clamps to from before and to after the tween', () => {
  const input = { onSecond: 1, from: 0, to: 100, duration: 1, easing: Easing.linear };

  assert.equal(new Frame(0, 0, 30).animateRuntime(input), 0, 'before the start');
  assert.ok(Math.abs(new Frame(45, 45, 30).animateRuntime(input) - 50) < 1e-9, 'midway');
  assert.equal(new Frame(90, 90, 30).animateRuntime(input), 100, 'after the end');
});

test('a scene frame keeps the global index', () => {
  const global = new Frame(100, 100, 60);
  const scene = Frame.cloneWithSceneOffset(global, 40);
  assert.equal(scene.index, 60);
  assert.equal(scene.globalIndex, 100);
  assert.equal(scene.fps, 60);
});

test('cloneWithSceneOffset rebases the index onto the scene start', () => {
  const timelineFrame = new Frame(150, 150, 30);
  const firstScene = Frame.cloneWithSceneOffset(timelineFrame, 150);
  assert.equal(firstScene.index, 0, 'the first frame of a scene');
  assert.equal(firstScene.seconds(), 0);
  assert.equal(firstScene.globalIndex, 150, 'the global index still points into the video');

  const secondScene = Frame.cloneWithSceneOffset(timelineFrame, 90);
  assert.equal(secondScene.index, 60);
  assert.equal(secondScene.seconds(), 2);
  assert.equal(secondScene.globalIndex, 150);
});

test('intoGlobal replaces the relative index with the global one', () => {
  const scene = Frame.cloneWithSceneOffset(new Frame(150, 150, 30), 90);
  const global = scene.intoGlobal();
  assert.equal(global.index, 150);
  assert.equal(global.globalIndex, 150);
  assert.equal(global.seconds(), 5);
});

test('a scene frame animates relative to the scene', () => {
  const animation = timeline<number>({
    start: 0,
    end: 1,
    from: 0,
    to: 60,
    easing: Easing.linear,
  });

  const sceneFrame = Frame.cloneWithSceneOffset(new Frame(150, 150, 30), 120);
  assert.ok(Math.abs(sceneFrame.animate(animation) - 60) < 1e-9, '30 frames into the scene');
  assert.ok(Math.abs(new Frame(150, 150, 30).animate(animation) - 60) < 1e-9);
});

test('visualizeAudioFrame reports a missing spectrum provider', () => {
  setVisualizationResolver(null);

  const input: VisualizeFrameInput = {
    audio: new DecodedAudio(new Float32Array(512), 44100),
    sampleSize: 512,
    smoothLevel: 2,
  };

  assert.throws(() => new Frame(10, 10, 30).visualizeAudioFrame(input), /no spectrum provider installed/);
});

test('visualizeAudioFrame smooths over smoothLevel frames on each side', () => {
  const calls: number[] = [];
  setVisualizationResolver((frameIndex) => {
    calls.push(frameIndex);
    return new Float32Array([frameIndex, frameIndex * 2]);
  });

  const input: VisualizeFrameInput = {
    audio: new DecodedAudio(new Float32Array(512), 44100),
    sampleSize: 512,
    smoothLevel: 2,
  };

  // Too early to smooth: the raw spectrum is returned as is.
  const early = new Frame(2, 2, 30).visualizeAudioFrame(input);
  assert.deepEqual([...early], [2, 4]);
  assert.deepEqual(calls, [2]);

  calls.length = 0;
  const smoothed = new Frame(10, 10, 30).visualizeAudioFrame(input);
  assert.deepEqual(calls, [8, 9, 10, 11], 'four frames: index ± 2');
  // (8+9+10+11) / 4 = 9.5 and (16+18+20+22) / 4 = 19
  assert.ok(Math.abs((smoothed[0] as number) - 9.5) < 1e-6);
  assert.ok(Math.abs((smoothed[1] as number) - 19) < 1e-6);

  setVisualizationResolver(null);
});
