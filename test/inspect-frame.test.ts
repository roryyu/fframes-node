/**
 * `inspect` must never crash on a frame it cannot rasterize — it is the command whose whole job is
 * to survive broken frames.
 *
 * The `empty-frame` check is the one that needs pixels, and it was the only place in `inspectFrame`
 * where a throw escaped: `renderSvgToRgba` was called outside any `try`. A frame whose `renderFrame`
 * returns `Svgr.empty()` (the empty string) therefore took the whole process down with exit 1 —
 * exactly the frame the check exists to report. `renderFrameSvg` throwing was already handled and
 * became a `render-error` finding; the rasterizer was not.
 *
 * No ffmpeg, no real font files, no real rendering: the cases below fail *before* any pixels are
 * produced (an empty document, and a malformed one), which is where the throw used to be.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inspectFrame, inspectFrames, inspectMedia } from '../src/inspect/diagnostics.ts';
import { createRenderSession } from '../src/render/resvg-backend.ts';
import { svgr, seconds, AudioMap, Svgr } from '../src/index.ts';
import type { FFramesContext, Frame, Video } from '../src/index.ts';

/** A 2 s video whose frame renders whatever `svg` says. */
function videoWith(svg: (frame: Frame) => Svgr): Video {
  return {
    fps: 30,
    width: 32,
    height: 18,
    duration: () => seconds(2),
    audio: () => AudioMap.none(),
    defineScenes: () => null,
    fonts: () => [],
    renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
      return svg(frame);
    },
  };
}

test('a frame that renders nothing is a finding, not a crash', () => {
  const session = createRenderSession(videoWith(() => Svgr.empty()), {
    fps: 30,
    width: 32,
    height: 18,
  });

  // Pre-fix this threw `resvg-backend: can not render an empty SVG document` out of inspectFrame.
  const inspected = inspectFrame(session, 0, { checkEmpty: true });
  assert.deepEqual(inspected.findings.map((finding) => finding.kind), ['empty-frame']);
  assert.equal(inspected.findings[0]?.severity, 'warning');
  assert.match(inspected.findings[0]?.message ?? '', /rendered nothing/);
});

test('a frame that cannot be rasterized is a render-error finding', () => {
  // Malformed rather than empty: not `empty-frame`, but still a finding instead of a crash.
  const session = createRenderSession(
    videoWith(() => svgr`<svg><rect`),
    { fps: 30, width: 32, height: 18 },
  );

  const inspected = inspectFrame(session, 0, { checkEmpty: true });
  assert.equal(inspected.findings.length, 1);
  assert.equal(inspected.findings[0]?.kind, 'render-error');
  assert.equal(inspected.findings[0]?.severity, 'error');
  assert.match(inspected.findings[0]?.message ?? '', /could not be rasterized/);
});

test('a throwing renderFrame is still reported, and does not reach the rasterizer', () => {
  const session = createRenderSession(
    videoWith(() => {
      throw new Error('boom');
    }),
    { fps: 30, width: 32, height: 18 },
  );

  const inspected = inspectFrame(session, 7, { checkEmpty: true });
  assert.deepEqual(inspected.findings.map((finding) => finding.kind), ['render-error']);
  assert.match(inspected.findings[0]?.message ?? '', /renderFrame threw at frame 7 \(0\.23s\): boom/);
});

test('the empty check can still be turned off, and then the frame has no findings', () => {
  const session = createRenderSession(videoWith(() => Svgr.empty()), {
    fps: 30,
    width: 32,
    height: 18,
  });
  const inspected = inspectFrame(session, 0, { checkEmpty: false });
  assert.deepEqual(inspected.findings, []);
});

test('the sampled frames include both scene edges and the range boundary', () => {
  const scenes = [
    { startFrame: 0, endFrame: 10 },
    { startFrame: 10, endFrame: 20 },
  ];
  assert.deepEqual(
    inspectFrames({ start: 0, end: 20 }, scenes, { distance: 30 }),
    [0, 9, 10, 19],
    'the step alone would only have produced 0',
  );
  assert.deepEqual(
    inspectFrames({ start: 0, end: 20 }, scenes, { everyFrame: true }).length,
    20,
  );
});

test('missing-media only fires when the map actually names a file', () => {
  const empty: Video = {
    fps: 30,
    width: 32,
    height: 18,
    duration: () => seconds(1),
    audio: () => AudioMap.none(),
    defineScenes: () => null,
    fonts: () => [],
    renderFrame: (frame: Frame) =>
      svgr`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18">
        <text x="0" y="10">${frame.index}</text>
      </svg>`,
  };
  const session = createRenderSession(empty, { fps: 30, width: 32, height: 18 });
  assert.equal(session.mediaDir, null);
  assert.deepEqual(inspectMedia(session, 0), [], 'no track, so nothing to call missing');
});
