/**
 * The `svgr` tagged template and the interpolation rules of the Rust `svgr!` macro.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Svgr, concatSvgr, stringifySvgrValue, svgr } from '../src/core/svgr.ts';
import { Color } from '../src/core/color.ts';
import { Transform } from '../src/core/transform.ts';

test('a template without interpolation is returned verbatim', () => {
  const tree = svgr`<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
  assert.ok(tree instanceof Svgr);
  assert.equal(tree.value, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(String(tree), tree.value);
});

test('numbers are stringified', () => {
  assert.equal(svgr`<rect width="${1920}" height="${1080}"/>`.value, '<rect width="1920" height="1080"/>');
  assert.equal(svgr`${0}`.value, '0');
  assert.equal(svgr`${1.5}`.value, '1.5');
  assert.equal(svgr`${-0.25}`.value, '-0.25');
});

test('strings are inserted as is, without escaping', () => {
  assert.equal(svgr`<text>${'hello & goodbye'}</text>`.value, '<text>hello & goodbye</text>');
  assert.equal(svgr`<rect fill="${'#ff8800'}"/>`.value, '<rect fill="#ff8800"/>');
});

test('null and undefined contribute nothing', () => {
  assert.equal(svgr`a${null}b${undefined}c`.value, 'abc');
  assert.equal(svgr`${null}`.value, '');
  assert.equal(stringifySvgrValue(null), '');
  assert.equal(stringifySvgrValue(undefined), '');
});

test('booleans are stringified', () => {
  assert.equal(svgr`${true}${false}`.value, 'truefalse');
  assert.equal(stringifySvgrValue(true), 'true');
});

test('a nested Svgr contributes its value', () => {
  const inner = svgr`<g><rect x="1"/></g>`;
  assert.equal(svgr`<svg>${inner}</svg>`.value, '<svg><g><rect x="1"/></g></svg>');
  assert.equal(stringifySvgrValue(inner), '<g><rect x="1"/></g>');
});

test('arrays are concatenated item by item', () => {
  const items = [svgr`<rect/>`, svgr`<circle/>`];
  assert.equal(svgr`<g>${items}</g>`.value, '<g><rect/><circle/></g>');
  assert.equal(
    stringifySvgrValue(['a', 1, null, svgr`<b/>`]),
    'a1<b/>',
    'each item follows the same rules',
  );
});

test('a Color interpolates as an svg paint', () => {
  assert.equal(svgr`<rect fill="${Color.fromHex('#ff8800')}"/>`.value, '<rect fill="#ff8800"/>');
  assert.equal(
    svgr`<rect fill="${Color.rgba(255, 136, 0, 0.5)}"/>`.value,
    '<rect fill="rgba(255, 136, 0, 0.5)"/>',
  );
});

test('a Transform interpolates as a transform attribute', () => {
  assert.equal(
    svgr`<g transform="${Transform.translate(10, 20)}">${''}</g>`.value,
    '<g transform="translate(10 20)"></g>',
  );
  assert.equal(
    svgr`<g transform="${Transform.rotate(45)}">${''}</g>`.value,
    '<g transform="rotate(45)"></g>',
  );
});

test('an unknown object is stringified with String()', () => {
  const value = { toString: () => 'custom' };
  assert.equal(stringifySvgrValue(value), 'custom');
  assert.equal(stringifySvgrValue({ plain: 1 }), '[object Object]');
  assert.equal(stringifySvgrValue(new Date(0)), new Date(0).toString());
});

test('a realistic frame template concatenates in order', () => {
  const frame = 42;
  const background = Color.fromHex('#f8fafc');
  const tree = svgr`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
  <rect width="1920" height="1080" fill="${background}"/>
  <text x="100" y="440" font-family="Helvetica" font-size="74" fill="#4b5563">frame ${frame}</text>
</svg>`;

  assert.ok(tree.value.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1920"'));
  assert.ok(tree.value.includes('fill="#f8fafc"'));
  assert.ok(tree.value.includes('>frame 42</text>'));
  assert.ok(tree.value.endsWith('</svg>'));
});

test('Svgr.empty is an empty string', () => {
  assert.equal(Svgr.empty().value, '');
  assert.equal(Svgr.from('<rect/>').value, '<rect/>');
});

test('concatSvgr joins fragments like the FromIterator impl', () => {
  const joined = concatSvgr([svgr`<a/>`, Svgr.from('<b/>'), svgr`<c/>`]);
  assert.equal(joined.value, '<a/><b/><c/>');
  assert.equal(concatSvgr([]).value, '');
  assert.equal(concatSvgr([Svgr.empty(), svgr`<a/>`]).value, '<a/>');
});

test('concatSvgr accepts any iterable, including a generator', () => {
  function* frames(): Generator<Svgr> {
    for (let i = 0; i < 3; i += 1) {
      yield svgr`<rect id="${i}"/>`;
    }
  }
  assert.equal(
    concatSvgr(frames()).value,
    '<rect id="0"/><rect id="1"/><rect id="2"/>',
  );
});
