/**
 * `MediaDirectory` containment: a name may only reach a file inside the directory.
 *
 * The class doc says a name that would escape (`../…`) is "never contained", so `inspect` reports
 * it as missing instead of reading an unrelated file. The implementation compared paths with
 * `startsWith`, which is a *string* relation: `/proj/media-secret/keys.wav` starts with
 * `/proj/media`, so a `../media-secret/keys.wav` reference was resolved to a real file outside the
 * media directory. Containment is a path relation, so the tests below pin it per segment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MediaDirectory, mediaKindFor } from '../src/media/media-dir.ts';

/** A temp tree with `media/x.wav` and the sibling `media-secret/x.wav`. */
function tree(): { root: string; media: MediaDirectory; mediaDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'fframes-media-'));
  const mediaDir = join(root, 'media');
  mkdirSync(mediaDir);
  writeFileSync(join(mediaDir, 'x.wav'), 'wav');
  mkdirSync(join(root, 'media-secret'));
  writeFileSync(join(root, 'media-secret', 'keys.wav'), 'secret');
  return { root, media: new MediaDirectory(mediaDir), mediaDir };
}

test('a name that escapes the directory is not contained', () => {
  const { media, mediaDir, root } = tree();
  // `path` is plain joining, so it happily leaves the directory — which is exactly why `exists` has
  // to check containment itself. The sibling file really exists, so only that rule can reject it.
  assert.equal(media.path('../media-secret/keys.wav'), join(mediaDir, '..', 'media-secret', 'keys.wav'));
  assert.equal(media.exists('../media-secret/keys.wav'), false);
  // And `../media/x.wav` — which lands back inside — is what a caller has to spell to reach it.
  assert.equal(media.exists('../media/x.wav'), true, `expected ${mediaDir} to contain it`);
  assert.equal(media.exists('../media-secret/../media/x.wav'), true, 'a `..` pair that stays inside');
  assert.equal(
    media.exists(join(root, 'media-secret', 'keys.wav')),
    false,
    'an absolute name is never contained',
  );
});

test('a file of the directory is contained, and the directory itself is not a file', () => {
  const { media, mediaDir } = tree();
  assert.equal(media.exists('x.wav'), true);
  assert.equal(media.exists('./x.wav'), true);
  assert.equal(media.exists('missing.wav'), false);
  // `relative(dir, dir)` is the empty string: the directory contains itself as a path, but a
  // directory is not one of its files.
  assert.equal(media.exists('.'), false);
  assert.equal(media.exists(mediaDir), false);
});

test('a `..` that climbs back out is rejected however it is spelled', () => {
  const { media } = tree();
  for (const name of ['../x.wav', '../../etc/passwd', 'sub/../../media-secret/keys.wav', 'a/b/../../../media-secret/keys.wav']) {
    assert.equal(media.exists(name), false, `"${name}" must not be contained`);
  }
});

test('usedFiles reports an escaping name as missing without touching the file', () => {
  const { media } = tree();
  const check = media.usedFiles(['x.wav', '../media-secret/keys.wav']);
  assert.deepEqual(check.used, ['x.wav', '../media-secret/keys.wav']);
  assert.deepEqual(check.missing, ['../media-secret/keys.wav']);
  assert.equal(check.ok, false);
  assert.equal(media.hasAll(['x.wav']), true);
});

test('the kinds are the ones fframes reads', () => {
  assert.equal(mediaKindFor('a.wav'), 'audio');
  assert.equal(mediaKindFor('a.PNG'), 'image');
  assert.equal(mediaKindFor('a.mov'), 'video');
  assert.equal(mediaKindFor('a.ttc'), 'font');
  assert.equal(mediaKindFor('a.txt'), 'unknown');
  assert.equal(mediaKindFor('noextension'), 'unknown');
});

test('list reads the directory and skips what fframes does not read', () => {
  const { media, mediaDir } = tree();
  writeFileSync(join(mediaDir, 'notes.txt'), 'text');
  writeFileSync(join(mediaDir, 'bg.png'), 'png');
  assert.deepEqual(media.names(), ['bg.png', 'x.wav']);
  assert.deepEqual(media.audioFiles(), ['x.wav']);
  assert.deepEqual(media.imageFiles(), ['bg.png']);
  assert.equal(media.list()[0]?.size, 3);
  assert.throws(
    () => new MediaDirectory(join(mediaDir, 'x.wav')).readFolder(),
    /must be a folder/,
    'a file is not a media directory',
  );
});
