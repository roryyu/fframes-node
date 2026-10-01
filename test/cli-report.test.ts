/**
 * The `--json` and `--text` report shapes of the CLI, pinned to the contract's field names.
 *
 * Both items here are contract violations that only a reader of the output could see:
 *
 * - `timeline --json` spelled the track's file offset `offset`, while contract §3 spells the track
 *   list `…startSeconds, endSeconds, offsetSeconds, gainDb…`. A consumer written against the
 *   contract read `track.offsetSeconds` and got `undefined`, and nothing in the tree recorded that
 *   the name had been changed.
 * - `audio render` wrote the constant `audio.wav` while contract §3 asks for the video's
 *   `defaultOutput` without its extension (`out.mp4` -> `out.wav`), or `out.wav` when there is
 *   none. Rust spells the constant (`cli.rs:226`); where the contract and the original disagree,
 *   the contract is the single source of truth for this port.
 *
 * Nothing here renders or spawns ffmpeg: `timelineReport` is a pure function of a resolved
 * session, and `defaultAudioOutput` is a pure function of a name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultAudioOutput } from '../src/cli/audio-cmd.ts';
import { timelineReport, timelineText } from '../src/cli/timeline.ts';
import { createRenderSession } from '../src/render/resvg-backend.ts';
import { svgr, seconds, AudioMap, audioTrack } from '../src/index.ts';
import type { FFramesContext, Frame, Svgr, Video } from '../src/index.ts';

/** A 4 s video with one offset track, so the report has something to say about `offsetSeconds`. */
function video(): Video {
  return {
    fps: 30,
    width: 64,
    height: 36,
    defaultOutput: 'out.mp4',
    duration: () => seconds(4),
    audio: () => AudioMap.of([audioTrack('sine.wav', { start: 0, end: 2 }).offset(1.5).gainDb(-6)]),
    defineScenes: () => null,
    fonts: () => [],
    renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
      return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36">
        <text x="0" y="10">${frame.index}</text>
      </svg>`;
    },
  };
}

test('timeline --json spells the track offset `offsetSeconds`, as the contract does', () => {
  const session = createRenderSession(video(), { fps: 30, width: 64, height: 36 });
  const report = timelineReport(session);

  assert.equal(report.audio.tracks.length, 1);
  const [track] = report.audio.tracks;
  assert.ok(track !== undefined);

  // The contract's field name, and the value still comes from `TrackMix.offset`.
  assert.equal(track.offsetSeconds, 1.5);
  assert.ok('offsetSeconds' in track, 'the key the contract names is present');
  assert.equal('offset' in track, false, 'the bare `offset` key is gone: a consumer reading the ' +
    'contract would have found `undefined`');

  // The rest of the contract's track fields are unchanged.
  for (const key of [
    'file',
    'startSeconds',
    'endSeconds',
    'gainDb',
    'volume',
    'pan',
    'fadeIn',
    'fadeOut',
    'fadeCurve',
    'voice',
    'ducking',
  ]) {
    assert.ok(key in track, `${key} is still there`);
  }

  // And the same object survives `JSON.stringify`, which is what `--json` prints.
  const json = JSON.parse(JSON.stringify(report)) as {
    audio: { tracks: Record<string, unknown>[] };
  };
  assert.equal(json.audio.tracks[0]?.['offsetSeconds'], 1.5);
  assert.equal(json.audio.tracks[0]?.['offset'], undefined);

  // The human report keeps the note, reading the renamed field.
  assert.match(timelineText(report), /from 1\.50s of the file/);
});

test('a track without an offset reports 0, not a missing field', () => {
  const plain: Video = {
    ...video(),
    audio: () => AudioMap.of([audioTrack('sine.wav', { start: 0, end: 2 })]),
  };
  const session = createRenderSession(plain, { fps: 30, width: 64, height: 36 });
  const [track] = timelineReport(session).audio.tracks;
  assert.equal(track?.offsetSeconds, 0);
});

test('the default audio output follows the video defaultOutput', () => {
  assert.equal(defaultAudioOutput('out.mp4'), 'out.wav');
  assert.equal(defaultAudioOutput('a/b.mov'), 'a/b.wav');
  assert.equal(defaultAudioOutput('movie.webm'), 'movie.wav');
  // No extension: the name is already extensionless, so only `.wav` is appended.
  assert.equal(defaultAudioOutput('movie'), 'movie.wav');
  // No `defaultOutput` at all: the contract's fallback.
  assert.equal(defaultAudioOutput(), 'out.wav');
  assert.equal(defaultAudioOutput(null), 'out.wav');
  assert.equal(defaultAudioOutput(''), 'out.wav');
  // A dot that belongs to a directory is not an extension.
  assert.equal(defaultAudioOutput('releases/v1.2/out'), 'releases/v1.2/out.wav');
});

test('the audio-demo video default output maps to a WAV next to it', () => {
  // The example the gate renders: `defaultOutput = 'audio-demo.mp4'`.
  assert.equal(defaultAudioOutput('audio-demo.mp4'), 'audio-demo.wav');
});
