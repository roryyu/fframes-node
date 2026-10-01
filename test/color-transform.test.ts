/**
 * Color and Transform, mirroring the Rust unit tests of `color.rs` and `transform.rs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Color } from '../src/core/color.ts';
import { Rotate, Scale, Transform } from '../src/core/transform.ts';

function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected} ± ${epsilon}, got ${actual}`);
}

test('a 6 digit hex color parses to opaque rgb', () => {
  const color = Color.fromHex('#ff8800');
  assert.equal(color.r, 255);
  assert.equal(color.g, 136);
  assert.equal(color.b, 0);
  assert.equal(color.a, 1);
  assert.ok(color.isOpaque);
  assert.ok(!color.isTransparent);
});

test('a 3 digit hex color expands each digit', () => {
  const color = Color.fromHex('#abc');
  assert.equal(color.r, 170);
  assert.equal(color.g, 187);
  assert.equal(color.b, 204);
  assert.equal(color.a, 1);
  assert.deepEqual(Color.fromHex('#f0f'), new Color(255, 0, 255, 1));
});

test('a 4 digit hex color carries the alpha', () => {
  const color = Color.fromHex('#f0f8');
  assert.equal(color.r, 255);
  assert.equal(color.g, 0);
  assert.equal(color.b, 255);
  assert.equal(color.alphaByte, 136);
  assertClose(color.a, 136 / 255);
});

test('an 8 digit hex color carries rgb and alpha', () => {
  const color = Color.fromHex('#ff00ff80');
  assert.equal(color.r, 255);
  assert.equal(color.g, 0);
  assert.equal(color.b, 255);
  assert.equal(color.alphaByte, 128);
  assert.deepEqual(Color.fromHex('#ef4444'), new Color(239, 68, 68, 1));
  assert.deepEqual(Color.fromHex('#1c1917'), new Color(28, 25, 23, 1));
});

test('uppercase hex parses the same as lowercase', () => {
  assert.ok(Color.fromHex('#EF4444').equals(Color.fromHex('#ef4444')));
  assert.ok(Color.fromHex('#F0F8').equals(Color.fromHex('#f0f8')));
});

test('an invalid hex falls back to black, like the Rust version', () => {
  assert.ok(Color.fromHex('ff8800').equals(Color.black), 'no leading hash');
  assert.ok(Color.fromHex('#ff880').equals(Color.black), 'wrong length');
  assert.ok(Color.fromHex('#gggggg').equals(Color.black), 'not hex');
  assert.ok(Color.fromHex('').equals(Color.black));
});

test('the named colors match the Rust constants', () => {
  assert.deepEqual(Color.black, new Color(0, 0, 0, 1));
  assert.deepEqual(Color.white, new Color(255, 255, 255, 1));
  assert.ok(Color.transparent.isTransparent);
  assert.deepEqual([Color.chromaKey.r, Color.chromaKey.g, Color.chromaKey.b], [0, 177, 64]);
  assert.ok(Color.transparent.isTransparent, 'the chroma key is fully transparent');
  assert.ok(Color.rgb(255, 0, 0).isOpaque);
  assert.ok(!Color.rgba(255, 0, 0, 0.5).isOpaque);
});

test('rgb, rgba and with_alpha build colors', () => {
  assert.deepEqual(Color.rgb(1, 2, 3), new Color(1, 2, 3, 1));
  assert.deepEqual(Color.rgba(1, 2, 3, 0.25), new Color(1, 2, 3, 0.25));
  assert.deepEqual(Color.fromAlphaByte(1, 2, 3, 128), new Color(1, 2, 3, 128 / 255));
  // `with_alpha` takes the alpha as a `u8`, like the Rust (color.rs:224), while the `a` field
  // stays the float `0..1` of the contract — hence the round trip through `alphaByte`.
  assert.equal(Color.rgb(255, 0, 0).withAlpha(0).alphaByte, 0);
  assert.equal(Color.rgb(255, 0, 0).withAlpha(128).alphaByte, 128);
  const semi = Color.rgb(255, 0, 0).withAlpha(128);
  assert.ok(!semi.isOpaque && !semi.isTransparent, 'alpha 128 is neither opaque nor transparent');
  // 指挥官修复(gen1轮): assertClose 签名是 (actual, expected, epsilon)，原第三参传了消息字符串导致 NaN 比较恒败
  assertClose(semi.a, 128 / 255);
  assert.equal(Color.rgb(255, 0, 0).withAlpha(300).alphaByte, 255, 'an alpha byte saturates');
  assert.equal(Color.rgb(255, 0, 0).withAlpha(-5).alphaByte, 0, 'a negative alpha byte clamps to 0');
});

test('channels are clamped into their range', () => {
  const color = new Color(300, -20, 12.6, 4);
  assert.equal(color.r, 255);
  assert.equal(color.g, 0);
  assert.equal(color.b, 13);
  assert.equal(color.a, 1, 'the alpha saturates at 1');
  assert.equal(new Color(0, 0, 0, -1).a, 0);
});

test('interpolate blends the channels linearly and truncates the rgb ones', () => {
  const black = Color.fromHex('#000000');
  const white = Color.fromHex('#ffffff');
  const middle = black.interpolate(white, 0.5);
  assert.equal(middle.r, 127, '255 * 0.5 = 127.5, truncated like the Rust cast');
  assert.equal(middle.g, 127);
  assert.equal(middle.b, 127);
  assert.equal(black.interpolate(white, 0).r, 0);
  assert.equal(black.interpolate(white, 1).r, 255);
});

test('interpolate blends the alpha as a float', () => {
  const clear = new Color(0, 0, 0, 0);
  const opaque = new Color(0, 0, 0, 1);
  assertClose(clear.interpolate(opaque, 0.5).a, 0.5);
  assertClose(clear.interpolate(opaque, 0.25).a, 0.25);
  assert.equal(clear.interpolate(opaque, 1).a, 1);
});

test('toSvg emits a hex when opaque and rgba when translucent', () => {
  assert.equal(Color.fromHex('#ff8800').toSvg(), '#ff8800');
  assert.equal(Color.rgb(1, 2, 3).toSvg(), '#010203');
  assert.equal(new Color(255, 136, 0, 0.5).toSvg(), 'rgba(255, 136, 0, 0.5)');
  assert.equal(Color.transparent.toSvg(), 'rgba(0, 0, 0, 0)');
});

test('toString mirrors the Rust Display implementation', () => {
  assert.equal(Color.rgb(255, 0, 0).toString(), 'rgb(255, 0, 0)');
  assert.equal(Color.rgba(255, 0, 0, 0.502).toString(), 'rgba(255, 0, 0, 0.502)');
});

test('distance grows with the channel difference', () => {
  assert.equal(Color.black.distance(Color.black), 0);
  assertClose(Color.black.distance(Color.white), Math.sqrt(255 * 255 * 3));
  assert.ok(Color.black.distance(new Color(10, 0, 0, 1)) < Color.black.distance(new Color(100, 0, 0, 1)));
  assert.ok(
    Color.transparent.distance(new Color(0, 0, 0, 1)) > 0,
    'the alpha counts as 255 full steps',
  );
});

test('a translate transform serializes as translate(x y)', () => {
  assert.equal(Transform.translate(10, 20).toSvgAttribute(), 'translate(10 20)');
  assert.equal(Transform.translate(-10, 0.5).toSvgAttribute(), 'translate(-10 0.5)');
  assert.equal(Transform.identity().toSvgAttribute(), '', 'the identity serializes to nothing');
});

test('a uniform scale serializes with one argument', () => {
  assert.equal(Transform.scale(2).toSvgAttribute(), 'scale(2)');
  assert.equal(Transform.scale(2, 3).toSvgAttribute(), 'scale(2 3)');
  assert.equal(Transform.scale(1).toSvgAttribute(), '');
});

test('a rotation serializes with or without an origin', () => {
  assert.equal(Transform.rotate(45).toSvgAttribute(), 'rotate(45)');
  assert.equal(Transform.rotate(30, [10, 20]).toSvgAttribute(), 'rotate(30 10 20)');
  assert.equal(Transform.rotate(0).toSvgAttribute(), '');
});

test('skew serializes as skewX / skewY', () => {
  assert.equal(Transform.skew(45, 30).toSvgAttribute(), 'skewX(45) skewY(30)');
  assert.equal(Transform.skew(45, 0).toSvgAttribute(), 'skewX(45)');
  assert.equal(Transform.skew(0, 30).toSvgAttribute(), 'skewY(30)');
});

test('combined transforms concatenate in the documented order', () => {
  const transform = new Transform(10, 20, new Rotate(45), new Scale(2), 0, 0);
  assert.equal(transform.toSvgAttribute(), 'translate(10 20) rotate(45) scale(2)');
});

test('then combines two transforms', () => {
  const combined = Transform.translate(10, 20).then(Transform.translate(1, 2));
  assert.equal(combined.toSvgAttribute(), 'translate(11 22)');
  const scaled = Transform.scale(2).then(Transform.scale(3));
  assert.equal(scaled.toSvgAttribute(), 'scale(6)');
  assert.equal(Transform.identity().then(Transform.rotate(45)).toSvgAttribute(), 'rotate(45)');
});

test('interpolate blends every transform component', () => {
  const from = new Transform(0, 0, new Rotate(0), new Scale(1, 1), 0, 0);
  const to = new Transform(10, 20, new Rotate(90), new Scale(3, 5), 30, 40);
  const middle = from.interpolate(to, 0.5);

  assert.equal(middle.translateX, 5);
  assert.equal(middle.translateY, 10);
  assert.equal(middle.rotate.angle, 45);
  assert.equal(middle.scale.x, 2);
  assert.equal(middle.scale.y, 3);
  assert.equal(middle.skewX, 15);
  assert.equal(middle.skewY, 20);
  assert.equal(middle.toSvgAttribute(), 'translate(5 10) rotate(45) scale(2 3) skewX(15) skewY(20)');
});

test('interpolate keeps the left origin, then the right one', () => {
  const withOrigin = new Transform(0, 0, new Rotate(45, [5, 5]), new Scale());
  const without = new Transform(0, 0, new Rotate(0), new Scale());
  // `origin: self.rotate.origin.or(to.rotate.origin)` (transform.rs:99) — left, then right.
  assert.deepEqual(withOrigin.interpolate(without, 0.5).rotate.origin, [5, 5], 'the left origin wins');
  assert.deepEqual(without.interpolate(withOrigin, 0.5).rotate.origin, [5, 5], 'then the right one');
  assert.equal(without.interpolate(without, 0.5).rotate.origin, null, 'no origin at all stays null');
});

test('transform distance is the euclidean distance over the components', () => {
  assert.equal(Transform.identity().distance(Transform.identity()), 0);
  assertClose(Transform.identity().distance(Transform.translate(3, 4)), 5);
});

test('a transform stringifies to its svg attribute', () => {
  assert.equal(String(Transform.translate(1, 2)), 'translate(1 2)');
  assert.ok(Transform.translate(1, 2).equals(Transform.translate(1, 2)));
  assert.ok(!Transform.translate(1, 2).equals(Transform.translate(1, 3)));
});

test('a scale defaults to a uniform factor of one', () => {
  assert.deepEqual([new Scale().x, new Scale().y], [1, 1]);
  assert.deepEqual([new Scale(3).x, new Scale(3).y], [3, 3]);
  assert.deepEqual([new Scale(2, 5).x, new Scale(2, 5).y], [2, 5]);
  assert.deepEqual([new Rotate(0).angle, new Rotate(0).origin], [0, null]);
});
