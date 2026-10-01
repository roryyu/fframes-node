/**
 * What `render` *reports*, as opposed to what it encodes — the parts that are pure functions of a
 * session and can therefore be asserted without ffmpeg.
 *
 * `missingAudioFiles` used to be computed from the decode cache, which is still empty at report time
 * (nothing is decoded until the mix) and stays empty whenever the mix was skipped at all. Every
 * healthy video with audio therefore reported every one of its tracks as missing, while the render
 * itself succeeded and `audio: true`. Rust's judgement is the media provider's: `resolve_audio`
 * returning `None` is the only thing that lands on `missing` (`audio_mix.rs:417-427`), and `None`
 * means "the media directory does not hold this file". A file that exists but cannot be decoded
 * yields no samples either, so it is reported the same way — that is the `AudioData::Lazy` skip.
 *
 * The progress counters are here too, because the same "count it twice" bug made `rendered N/N`
 * unprintable and left a single frame render completely silent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createRenderSession,
  missingAudioFiles,
  missingAudioFilesOf,
  undecodableAudio,
} from '../src/render/resvg-backend.ts';
import type { RenderSession } from '../src/render/resvg-backend.ts';
import { MediaDirectory } from '../src/media/media-dir.ts';
import { renderText } from '../src/cli/render.ts';
import { svgr, seconds, AudioMap, audioTrack } from '../src/index.ts';
import type { FFramesContext, Frame, Svgr, Video } from '../src/index.ts';

/** A 1 s video with one track on `sine.wav`. */
function video(): Video {
  return {
    fps: 30,
    width: 32,
    height: 18,
    defaultOutput: 'out.mp4',
    duration: () => seconds(1),
    // An explicit range end: an `Eof` end would need the file's duration, and a file that is not
    // in the media directory has none, which would make the whole map unresolvable.
    audio: () => AudioMap.of([audioTrack('sine.wav', { start: 0, end: 1 })]),
    defineScenes: () => null,
    fonts: () => [],
    renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
      return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18">
        <text x="0" y="10">${frame.index}</text>
      </svg>`;
    },
  };
}

/**
 * The rule `cli/render.ts` and `cli/audio-cmd.ts` both report through, wrapped so the assertions
 * below read as the rule rather than as the call.
 */
function reportedMissing(session: RenderSession): string[] {
  return missingAudioFilesOf(session);
}

/** A media directory holding `sine.wav`. */
function mediaWithSine(): { dir: string; media: MediaDirectory } {
  const dir = join(mkdtempSync(join(tmpdir(), 'fframes-render-')), 'media');
  mkdirSync(dir);
  writeFileSync(join(dir, 'sine.wav'), 'not really audio');
  return { dir, media: new MediaDirectory(dir) };
}

test('a track the media directory holds is not missing, before anything is decoded', () => {
  const { media } = mediaWithSine();
  const session = createRenderSession(video(), { fps: 30, width: 32, height: 18, mediaDir: media });

  // Nothing has been decoded, which is exactly the state the report is produced in.
  assert.equal(session.audioCache.size, 0);
  assert.deepEqual(reportedMissing(session), [], 'the cache being empty says nothing about the file');
});

test('a track the media directory does not hold is missing', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'fframes-render-')), 'media');
  mkdirSync(dir);
  const session = createRenderSession(video(), {
    fps: 30,
    width: 32,
    height: 18,
    mediaDir: new MediaDirectory(dir),
  });
  assert.deepEqual(reportedMissing(session), ['sine.wav']);
});

test('a video with no media directory reports its tracks as missing', () => {
  const session = createRenderSession(video(), { fps: 30, width: 32, height: 18 });
  assert.equal(session.mediaDir, null);
  assert.deepEqual(reportedMissing(session), ['sine.wav']);
});

test('the rule itself, with no session involved', () => {
  const { media } = mediaWithSine();
  const undecodable = new Map<string, string>();

  assert.deepEqual(missingAudioFiles(['sine.wav'], media, undecodable), []);
  assert.deepEqual(missingAudioFiles(['other.wav'], media, undecodable), ['other.wav']);
  assert.deepEqual(missingAudioFiles(['sine.wav'], null, undecodable), ['sine.wav']);
  assert.deepEqual(missingAudioFiles([], null, undecodable), []);

  // Undecodable counts as missing: it contributed no samples, which is what `missing` means.
  undecodable.set('sine.wav', 'ffmpeg exited with code 1');
  assert.deepEqual(missingAudioFiles(['sine.wav'], media, undecodable), ['sine.wav']);
});

test('a file that exists but cannot be decoded counts as missing', () => {
  const { media } = mediaWithSine();
  const session = createRenderSession(video(), { fps: 30, width: 32, height: 18, mediaDir: media });
  assert.deepEqual(reportedMissing(session), []);

  // What `decodeSessionAudio` records when ffmpeg refuses the file.
  undecodableAudio(session).set('sine.wav', 'ffmpeg exited with code 1');
  assert.deepEqual(reportedMissing(session), ['sine.wav']);
});

test('the human report line still reads the range and the size', () => {
  const text = renderText({
    output: 'out.mp4',
    frames: { start: 0, end: 30 },
    startSeconds: 0,
    endSeconds: 1,
    seconds: 1,
    width: 32,
    height: 18,
    fps: 30,
    audio: true,
    missingAudioFiles: [],
    // A value with no rounding ambiguity: `elapsedSeconds.toFixed(1)` renders it verbatim, so the
    // assertion tests the line's shape (range + size + elapsed) rather than half-up rounding at the
    // 0.x5 boundary (1.25 -> "1.3", not "1.2").
    elapsedSeconds: 1.2,
  });
  assert.equal(text, 'out.mp4 frames 0..30 (0.00s..1.00s) 32x18 in 1.2s');
});

/** The lines `main.ts` prints, replayed from what `encodeVideo` would pass to `onProgress`. */
function progressLines(start: number, count: number): string[] {
  const lines: string[] = [];
  for (let written = 1; written <= count; written += 1) {
    // `renderVideo` forwards `range.start + written`, and `written` was already incremented
    // (`ffmpeg-encoder.ts:250-251`), so `frame` is the 1-based count of frames written.
    const frame = start + written;
    const done = frame - start;
    if (count > 0 && (done === count || done % 10 === 0)) {
      lines.push(`rendered ${done}/${count} frames`);
    }
  }
  return lines;
}

test('render progress counts frames once', () => {
  // The old `done = frame - range.start + 1` counted one more than the frames actually written,
  // which made the first frame report `2/N`, fired the final line a frame early, and never printed
  // `N/N` at all.
  assert.deepEqual(progressLines(0, 3), ['rendered 3/3 frames'], 'only the last frame, counted once');

  // A single frame render used to print nothing at all: `done` was 2, `2 !== 1` and `2 % 10 !== 0`.
  assert.deepEqual(progressLines(0, 1), ['rendered 1/1 frames'], 'one frame renders one line');

  // A non-zero range start does not shift the count.
  assert.deepEqual(progressLines(90, 3), ['rendered 3/3 frames'], 'the count is relative to the range');

  // And the 10-frame throttle is unchanged.
  assert.deepEqual(progressLines(0, 30), [
    'rendered 10/30 frames',
    'rendered 20/30 frames',
    'rendered 30/30 frames',
  ]);
});
