/**
 * TimeSpec syntax, mirroring the Rust unit tests of `time_spec.rs` and the syntax table of the
 * contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TimelineIndex,
  TimeSpecResolveError,
  formatTimeSpecError,
  normalizeSceneName,
  parseTimeSpec,
  shortSceneName,
  type TimeSpecError,
} from '../src/core/time-spec.ts';
import type { ResolvedScene } from '../src/core/scenes.ts';
import { Svgr } from '../src/core/svgr.ts';
import { seconds } from '../src/core/duration.ts';
import type { Scene } from '../src/core/types.ts';

/** The same index as the Rust test: 30 fps, 300 frames, three scenes with two names. */
function index(): TimelineIndex {
  return new TimelineIndex(30, 300, [
    { index: 0, name: 'Intro', fullName: 'video::Intro', startFrame: 0, endFrame: 100 },
    { index: 1, name: 'Speaker', fullName: 'video::Speaker', startFrame: 90, endFrame: 200 },
    { index: 2, name: 'Speaker', fullName: 'video::Speaker', startFrame: 200, endFrame: 300 },
  ]);
}

function errorOf(fn: () => unknown, kind: TimeSpecError['kind']): TimeSpecError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TimeSpecResolveError, `expected a TimeSpecResolveError, got ${error}`);
    assert.equal(error.error.kind, kind);
    return error.error;
  }
  assert.fail(`expected the call to fail with "${kind}"`);
}

test('short_scene_name drops the module path and the generics', () => {
  assert.equal(shortSceneName('a::b::Intro'), 'Intro');
  assert.equal(shortSceneName('Intro'), 'Intro');
  assert.equal(shortSceneName("video::scenes::Intro<'a>"), 'Intro');
});

test('scene names are matched case insensitively and ignore the Scene suffix', () => {
  assert.equal(normalizeSceneName('Intro'), 'intro');
  assert.equal(normalizeSceneName('intro_scene'), 'intro');
  assert.equal(normalizeSceneName('Intro-Scene'), 'intro');
  assert.equal(normalizeSceneName('INTRO SCENE'), 'intro');
  assert.equal(normalizeSceneName('Scene'), 'scene', 'a bare "scene" keeps its name');
});

test('a frame number is a frame number', () => {
  const t = index();
  assert.equal(t.resolveFrame('120'), 120);
  assert.equal(t.resolveFrame('120f'), 120);
  assert.equal(t.resolveFrame('0'), 0);
  assert.equal(parseTimeSpec('120', t), 120);
});

test('times, milliseconds and clock notation resolve to frames', () => {
  const t = index();
  assert.equal(t.resolveFrame('2s'), 60);
  assert.equal(t.resolveFrame('3.2s'), 96);
  assert.equal(t.resolveFrame('500ms'), 15);
  assert.equal(t.resolveFrame('0:02.5'), 75);
  assert.equal(t.resolveFrame('0:01'), 30);
  assert.equal(t.resolveRange('0:00:01..0:00:02').start, 30, 'h:mm:ss multiplies by 60 per part');
  assert.equal(t.resolveRange('0:00:01..0:00:02').end, 60);
});

test('a percentage of the whole video resolves, 100% is the last frame', () => {
  const t = index();
  assert.equal(t.resolveFrame('50%'), 150);
  assert.equal(t.resolveFrame('100%'), 299);
  assert.equal(t.resolveFrame('0%'), 0);
  assert.equal(t.resolveFrame('33.3%'), 99);
});

test('start and end address the first and last frame', () => {
  const t = index();
  assert.equal(t.resolveFrame('start'), 0);
  assert.equal(t.resolveFrame('end'), 299);
});

test('a scene name addresses the first frame of that scene', () => {
  const t = index();
  assert.equal(t.resolveFrame('intro'), 0);
  assert.equal(t.resolveFrame('Intro'), 0);
  assert.equal(t.resolveFrame('IntroScene'), 0);
  assert.equal(t.resolveFrame('intro_scene'), 0);
  assert.equal(t.resolveFrame('video::Intro'), 0, 'the full name of a scene matches too');
  assert.equal(t.resolveFrame('Speaker[0]'), 90, 'the nth match disambiguates');
  assert.equal(t.resolveFrame('Speaker[1]'), 200);
});

test('#index addresses a scene by its 0-based index', () => {
  const t = index();
  assert.equal(t.resolveFrame('#0'), 0);
  assert.equal(t.resolveFrame('#1'), 90);
  assert.equal(t.resolveFrame('#2'), 200);
});

test('an offset inside a scene is relative to the scene start', () => {
  const t = index();
  assert.equal(t.resolveFrame('Intro@1s'), 30);
  assert.equal(t.resolveFrame('intro_scene@1s'), 30);
  assert.equal(t.resolveFrame('Intro@30'), 30);
  assert.equal(t.resolveFrame('Intro@50%'), 50);
  assert.equal(t.resolveFrame('Intro@end'), 99);
  assert.equal(t.resolveFrame('Intro@start'), 0);
});

test('scenesAt lists every scene covering a frame', () => {
  const t = index();
  assert.deepEqual(
    t.scenesAt(0).map((scene) => scene.index),
    [0],
  );
  assert.deepEqual(
    t.scenesAt(95).map((scene) => scene.index),
    [0, 1],
    'the two test scenes overlap between 90 and 100',
  );
  assert.deepEqual(
    t.scenesAt(150).map((scene) => scene.index),
    [1],
  );
  assert.deepEqual(t.scenesAt(300), [], 'the end frame is exclusive');
});

test('the timeline index exposes the duration in seconds', () => {
  const t = index();
  assert.equal(t.durationInSeconds(), 10);
  assert.equal(t.frameToSeconds(150), 5);
  assert.deepEqual(t.fullRange(), { start: 0, end: 300 });
});

test('a range is end exclusive', () => {
  const t = index();
  assert.deepEqual(t.resolveRange('1s..2s'), { start: 30, end: 60 });
  assert.deepEqual(t.resolveRange('5s..'), { start: 150, end: 300 });
  assert.deepEqual(t.resolveRange('..1s'), { start: 0, end: 30 });
  assert.deepEqual(t.resolveRange('0..1000'), { start: 0, end: 300 }, 'clamped to the video');
  assert.deepEqual(t.resolveRange('all'), { start: 0, end: 300 });
  assert.deepEqual(t.resolveRange('*'), { start: 0, end: 300 });
});

test('a scene name alone is the whole scene, on both sides of a range', () => {
  const t = index();
  assert.deepEqual(t.resolveRange('Intro'), { start: 0, end: 100 });
  assert.deepEqual(t.resolveRange('intro'), { start: 0, end: 100 });
  assert.deepEqual(t.resolveRange('#2'), { start: 200, end: 300 });
  assert.deepEqual(t.resolveRange('Intro..#1'), { start: 0, end: 200 });
  // The fixture only holds Intro and two Speakers, so the right hand side names one of those:
  // a scene there means its exclusive end frame (`resolve_point(.., Side::End)`, time_spec.rs:287).
  assert.deepEqual(t.resolveRange('Intro..Speaker[0]'), { start: 0, end: 200 });
  assert.deepEqual(t.resolveRange('Intro..Speaker[0]@end'), { start: 0, end: 200 });
  assert.throws(
    () => t.resolveRange('Intro..Outro'),
    TimeSpecResolveError,
    'a scene outside the fixture stays unknown on either side',
  );
});

test('a single point is a one frame range', () => {
  const t = index();
  assert.deepEqual(t.resolveRange('42'), { start: 42, end: 43 });
  assert.deepEqual(t.resolveRange('2s'), { start: 60, end: 61 });
  assert.deepEqual(t.resolveRange('120'), { start: 120, end: 121 });
});

test('the end of a scene is the exclusive end frame', () => {
  const t = index();
  assert.deepEqual(t.resolveRange('Intro@end..'), { start: 99, end: 300 });
  assert.deepEqual(t.resolveRange('..#1'), { start: 0, end: 200 });
});

test('an unknown scene lists the available ones', () => {
  const t = index();
  const error = errorOf(() => t.resolveFrame('Outro'), 'unknownScene');
  assert.deepEqual(error.kind === 'unknownScene' ? error.available : [], [
    '#0 Intro',
    '#1 Speaker',
    '#2 Speaker',
  ]);
  assert.match(formatTimeSpecError(error), /no scene "Outro", available: #0 Intro/);
});

test('an unknown scene in a video without scenes reports the syntax instead', () => {
  const t = new TimelineIndex(30, 100, []);
  const error = errorOf(() => t.resolveFrame('Intro'), 'invalid');
  assert.match(formatTimeSpecError(error), /can not parse "Intro"/);
});

test('a name matching several scenes is ambiguous', () => {
  const t = index();
  const error = errorOf(() => t.resolveFrame('Speaker'), 'ambiguousScene');
  assert.deepEqual(error.kind === 'ambiguousScene' ? error.indexes : [], [1, 2]);
  // `{indexes:?}` on a `Vec<usize>` prints `[1, 2]` — Rust's slice `Debug` separates with `, `.
  assert.match(formatTimeSpecError(error), /matches scenes \[1, 2\]/);
});

test('a frame past the end of the video is out of range', () => {
  const t = index();
  const error = errorOf(() => t.resolveFrame('11s'), 'outOfRange');
  assert.match(formatTimeSpecError(error), /frame 330 is outside the video \(0\.\.300\)/);
  assert.equal(t.resolveFrame('299'), 299, 'the last frame is addressable');
});

test('an inverted range is empty', () => {
  const t = index();
  const error = errorOf(() => t.resolveRange('2s..1s'), 'emptyRange');
  assert.equal(error.kind === 'emptyRange' ? error.start : -1, 60);
  assert.equal(error.kind === 'emptyRange' ? error.end : -1, 30);
  assert.match(formatTimeSpecError(error), /is empty/);
  errorOf(() => t.resolveRange('5s..5s'), 'emptyRange');
});

test('a number with trailing junk is rejected, because Rust parses strictly', () => {
  // `str::parse::<f64>()` (time_spec.rs:303-323) rejects the whole string, while
  // `Number.parseFloat` accepts any numeric prefix — which silently turned these typos into frame
  // numbers (360, 150, 30). Each one must fall through to the scene lookup and fail as a spec.
  const t = index();
  for (const spec of ['12abcs', '5xx s', '1..2s', '1.2.3s', '500mms', '1:0:5x']) {
    assert.throws(
      () => t.resolveFrame(spec),
      TimeSpecResolveError,
      `"${spec}" must be rejected rather than parsed as a prefix`,
    );
  }
  // The legal forms of the same branches keep their values.
  assert.equal(t.resolveFrame('1.5s'), 45);
  assert.equal(t.resolveFrame('500ms'), 15);
  assert.equal(t.resolveFrame('0:05'), 150);
  // `h:mm:ss` and `m:ss` accumulate 60 per segment, so the clock branch is still exercised (on an
  // index long enough for a minute to be addressable).
  assert.equal(new TimelineIndex(30, 2000, []).resolveFrame('1:00.5'), 1815);
  assert.equal(t.resolveFrame('50%'), 150);
  assert.equal(t.resolveFrame('1e1%'), 30);
});

test('a percentage outside 0..100 saturates at the ends, as a Rust cast does', () => {
  // `(length as f64 * percent / 100.).floor() as usize` saturates rather than wrapping
  // (time_spec.rs:304-306): `-30.0 as usize == 0`.
  const t = index();
  assert.equal(t.resolveFrame('-10%'), 0);
  assert.equal(t.resolveFrame('0%'), 0);
  assert.equal(t.resolveFrame('150%'), 299);
  assert.equal(t.resolveRange('-10%..5s').start, 0);
});

test('garbage is rejected, as an unknown scene or as a syntax error', () => {
  const t = index();
  for (const spec of ['', 'abc', '12abc', '1..2..3x', '#', '#x', 'Intro@zz', '-5', '%']) {
    assert.throws(() => t.resolveFrame(spec), TimeSpecResolveError, `"${spec}" must be rejected`);
  }
  // With scenes on the timeline an unparseable spec is reported as the unknown scene it looks
  // like; the syntax hint is only used when the video defines no scene at all
  // (`resolve_point`, time_spec.rs:279-285).
  const unknown = errorOf(() => t.resolveFrame('abc'), 'unknownScene');
  assert.deepEqual(unknown.kind === 'unknownScene' ? unknown.available : [], [
    '#0 Intro',
    '#1 Speaker',
    '#2 Speaker',
  ]);
  assert.match(formatTimeSpecError(unknown), /no scene "abc", available: #0 Intro/);
  const withoutScenes = errorOf(() => new TimelineIndex(30, 100, []).resolveFrame('abc'), 'invalid');
  assert.match(formatTimeSpecError(withoutScenes), /use a frame \(120\), time \(3\.2s, 1:05\)/);
});

test('an unknown scene index is an unknown scene', () => {
  const t = index();
  // A `#index` that parses but is out of bounds is an unknown scene, not a syntax error
  // (`find_scene`, time_spec.rs:141-150).
  const error = errorOf(() => t.resolveFrame('#7'), 'unknownScene');
  assert.deepEqual(error.kind === 'unknownScene' ? error.available : [], [
    '#0 Intro',
    '#1 Speaker',
    '#2 Speaker',
  ]);
  // Without any scene the same lookup carries an empty `available` list, which `resolve_point`
  // turns into the syntax error (time_spec.rs:279-285).
  errorOf(() => new TimelineIndex(30, 100, []).resolveFrame('#0'), 'invalid');
});

test('an out of bounds nth scene is an unknown scene', () => {
  const t = index();
  errorOf(() => t.resolveFrame('Intro[5]'), 'unknownScene');
});

test('a timeline index can be built from resolved scenes', () => {
  const scene: Scene = { name: 'Scene', duration: () => seconds(2), renderFrame: () => Svgr.empty() };
  const scenes: ResolvedScene[] = [
    {
      index: 0,
      name: 'Intro',
      fullName: 'Intro',
      startFrame: 0,
      endFrame: 60,
      durationInFrames: 60,
      isLast: false,
      totalScenes: 2,
      scene,
    },
    {
      index: 1,
      name: 'Outro',
      fullName: 'Outro',
      startFrame: 60,
      endFrame: 120,
      durationInFrames: 60,
      isLast: true,
      totalScenes: 2,
      scene,
    },
  ];

  const t = TimelineIndex.fromScenes(30, 120, scenes);
  assert.deepEqual(
    t.scenes.map((entry) => ({ ...entry })),
    [
      { index: 0, name: 'Intro', fullName: 'Intro', startFrame: 0, endFrame: 60 },
      { index: 1, name: 'Outro', fullName: 'Outro', startFrame: 60, endFrame: 120 },
    ],
    'the index keeps index / name / fullName / frames, like TimelineIndex::new',
  );
  assert.equal(t.scenes.length, 2);
  assert.equal(t.resolveFrame('Outro'), 60);
  assert.equal(t.resolveFrame('Outro@end'), 119);
  // 指挥官修复(gen1轮): Rust resolve_range 右侧场景名走 Side::End = 该场景结束帧（time_spec.rs:228），'Intro..Outro' → {0,120}
  assert.deepEqual(t.resolveRange('Intro..Outro'), { start: 0, end: 120 });
});
