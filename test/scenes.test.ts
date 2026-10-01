/**
 * Scene placement on the timeline and `renderScenes`, mirroring
 * `ResolvedScenesTimeline::from_scenes` and `FFramesContext::render_scenes`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Frame } from '../src/core/frame.ts';
import { Scenes, renderScenes } from '../src/core/scenes.ts';
import { Svgr, svgr } from '../src/core/svgr.ts';
import { seconds, type Duration } from '../src/core/duration.ts';
import { TimelineIndex } from '../src/core/time-spec.ts';
import type { FFramesContext, Scene, Video } from '../src/core/types.ts';

/** A scene that records the frame it was called with. */
class Probe implements Scene {
  readonly name: string;
  readonly durationValue: Duration;
  readonly seen: Frame[] = [];

  constructor(name: string, durationValue: Duration) {
    this.name = name;
    this.durationValue = durationValue;
  }

  duration(): Duration {
    return this.durationValue;
  }

  renderFrame(frame: Frame): Svgr {
    this.seen.push(frame);
    return svgr`<g data-scene="${this.name}" data-index="${frame.index}" data-global="${frame.globalIndex}"/>`;
  }
}

function context(scenes: Scenes | null, timeline = scenes?.resolveTimeline(30)): FFramesContext {
  return {
    timeBase: { fps: 30, sampleRate: 44100 },
    currentVideoSize: { width: 1920, height: 1080 },
    durationInFrames: timeline?.totalDurationInFrames ?? 0,
    mode: 'renderer',
    scenes: timeline ?? null,
    definedScenes: scenes,
    mediaDir: null,
    fontFiles: [],
    resolveAudioDuration: null,
    renderScenes: () => Svgr.empty(),
    scenesAt: () => [],
    getAudio: () => null,
    getImage: () => null,
    hasMedia: () => false,
  };
}

/** A minimal `Video` double: only `defineScenes` matters for `renderScenes`. */
function videoWith(scenes: Scenes | readonly Scene[]): Video {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    duration: () => seconds(4),
    audio: () => ({}) as unknown as ReturnType<Video['audio']>,
    defineScenes: () => scenes,
    fonts: () => [],
    renderFrame: () => Svgr.empty(),
  };
}

test('scenes are placed back to back in the order they are defined', () => {
  const scenes = Scenes.from([
    new Probe('Intro', seconds(1)),
    new Probe('Body', seconds(2)),
    new Probe('Outro', seconds(0.5)),
  ]);
  const resolved = scenes.resolveTimeline(30);

  assert.equal(resolved.timeline.length, 3);
  assert.equal(resolved.totalDurationInFrames, 30 + 60 + 15);
  assert.deepEqual(
    resolved.timeline.map((scene) => [scene.name, scene.startFrame, scene.endFrame]),
    [
      ['Intro', 0, 30],
      ['Body', 30, 90],
      ['Outro', 90, 105],
    ],
  );
});

test('a resolved scene reports its index, duration and position in the video', () => {
  const scenes = Scenes.from([new Probe('Intro', seconds(1)), new Probe('Outro', seconds(1))]);
  const [first, second] = scenes.resolveTimeline(30).timeline;

  assert.equal(first?.index, 0);
  assert.equal(first?.isLast, false);
  assert.equal(first?.totalScenes, 2);
  assert.equal(first?.durationInFrames, 30);
  assert.equal(first?.fullName, 'Intro');
  assert.equal(second?.index, 1);
  assert.equal(second?.isLast, true);
});

test('a scene duration in frames is honoured', () => {
  const scenes = Scenes.from([new Probe('Intro', { kind: 'frames', value: 12 })]);
  assert.equal(scenes.resolveTimeline(30).totalDurationInFrames, 12);
});

test('an empty video has an empty timeline', () => {
  const scenes = Scenes.empty();
  assert.equal(scenes.length, 0);
  assert.ok(scenes.isEmpty());
  assert.equal(scenes.resolveTimeline(30).totalDurationInFrames, 0);
  assert.equal(scenes.tryResolveTimeline(30), null);
  assert.deepEqual(Scenes.emptyTimeline().timeline, []);
});

test('Scenes.from accepts arrays, iterables and nothing at all', () => {
  const scene = new Probe('Intro', seconds(1));
  assert.equal(Scenes.from([scene]).length, 1);
  assert.equal(Scenes.from(new Set([scene])).length, 1);
  assert.equal(Scenes.from(null).length, 0);
  assert.equal(Scenes.from(undefined).length, 0);
  assert.equal(Scenes.fromValue([scene]).length, 1);
  assert.equal(Scenes.fromValue(scenesOf(scene)).length, 1, 'an existing Scenes is kept');
});

function scenesOf(scene: Scene): Scenes {
  return Scenes.from([scene]);
}

test('a scene name falls back to the class name', () => {
  class Intro implements Scene {
    duration(): Duration {
      return seconds(1);
    }
    renderFrame(): Svgr {
      return Svgr.empty();
    }
  }

  const resolved = Scenes.from([new Intro()]).resolveTimeline(30);
  assert.equal(resolved.timeline[0]?.name, 'Intro');
  assert.equal(resolved.timeline[0]?.fullName, 'Intro');
});

test('the resolved timeline can be addressed with a TimelineIndex', () => {
  const scenes = Scenes.from([
    new Probe('Intro', seconds(1)),
    new Probe('Body', seconds(1)),
    new Probe('Body', seconds(1)),
  ]);
  const resolved = scenes.resolveTimeline(30);
  const index = TimelineIndex.fromScenes(30, resolved.totalDurationInFrames, resolved.timeline);

  assert.equal(index.resolveFrame('Body[1]'), 60, 'the second scene named Body');
  assert.equal(index.resolveFrame('#2'), 60);
  assert.deepEqual(index.resolveRange('Body[0]'), { start: 30, end: 60 });
});

test('renderScenes renders only the scene that covers the frame', () => {
  const intro = new Probe('Intro', seconds(1));
  const body = new Probe('Body', seconds(1));
  const scenes = Scenes.from([intro, body]);
  const ctx = context(scenes);
  const video = videoWith(scenes);

  const first = renderScenes(new Frame(0, 0, 30), video, ctx);
  assert.equal(first.value, '<g data-scene="Intro" data-index="0" data-global="0"/>');
  assert.equal(body.seen.length, 0, 'the second scene was not rendered');

  const last = renderScenes(new Frame(59, 59, 30), video, ctx);
  assert.equal(last.value, '<g data-scene="Body" data-index="29" data-global="59"/>');
  assert.equal(intro.seen.length, 1);
  assert.equal(body.seen.length, 1);
});

test('a scene frame is rebased onto the scene start', () => {
  const intro = new Probe('Intro', seconds(1));
  const body = new Probe('Body', seconds(2));
  const scenes = Scenes.from([intro, body]);
  const ctx = context(scenes);
  const video = videoWith(scenes);

  // Frame 45 is 15 frames into the second scene.
  renderScenes(new Frame(45, 45, 30), video, ctx);
  const sceneFrame = body.seen[0];
  assert.ok(sceneFrame !== undefined);
  assert.equal(sceneFrame.index, 15, 'relative to the scene');
  assert.equal(sceneFrame.globalIndex, 45, 'still the frame of the video');
  assert.equal(sceneFrame.seconds(), 0.5);
});

test('the scene boundary frames belong to exactly one scene', () => {
  const intro = new Probe('Intro', seconds(1));
  const body = new Probe('Body', seconds(1));
  const scenes = Scenes.from([intro, body]);
  const ctx = context(scenes);
  const video = videoWith(scenes);

  assert.ok(renderScenes(new Frame(29, 29, 30), video, ctx).value.includes('Intro'));
  assert.ok(renderScenes(new Frame(30, 30, 30), video, ctx).value.includes('Body'));
  assert.equal(intro.seen.length, 1);
  assert.equal(body.seen.length, 1);
});

test('renderScenes is empty when no scene covers the frame', () => {
  const intro = new Probe('Intro', seconds(1));
  const scenes = Scenes.from([intro]);
  const ctx = context(scenes);
  const video = videoWith(scenes);

  assert.equal(renderScenes(new Frame(500, 500, 30), video, ctx).value, '');
  assert.equal(
    renderScenes(new Frame(0, 0, 30), videoWith(Scenes.empty()), context(null)).value,
    '',
    'a video without scenes renders nothing',
  );
});

test('renderScenes falls back to the scenes declared by the video', () => {
  const intro = new Probe('Intro', seconds(1));
  const scenes = Scenes.from([intro]);
  const video = videoWith(scenes);
  const ctx = context(null);

  assert.equal(
    renderScenes(new Frame(3, 3, 30), video, ctx).value,
    '<g data-scene="Intro" data-index="3" data-global="3"/>',
    'the timeline is resolved from video.defineScenes()',
  );
});

test('a video may declare its scenes as a plain array', () => {
  const intro = new Probe('Intro', seconds(1));
  const video: Video = {
    fps: 30,
    width: 1920,
    height: 1080,
    duration: () => seconds(1),
    audio: () => ({}) as unknown as ReturnType<Video['audio']>,
    defineScenes: () => [intro],
    fonts: () => ['/System/Library/Fonts/Helvetica.ttc'],
    renderFrame: () => Svgr.empty(),
  };

  assert.equal(Scenes.fromValue(video.defineScenes()).length, 1);
  assert.equal(
    renderScenes(new Frame(1, 1, 30), video, context(null)).value,
    '<g data-scene="Intro" data-index="1" data-global="1"/>',
  );
});
