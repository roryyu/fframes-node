/**
 * The `typeset` module — the port of cy-carousel (chengyi-ai/cy-carousel-skill, MIT).
 *
 * Two halves:
 * - `atoms` / wrapping are pure and deterministic: the measure function is 10px per code point,
 *   so every expected line below is derived by hand from the algorithm and no font is needed;
 * - metrics / `typeset` / `renderCard` read real font files — they use the macOS system fonts and
 *   skip on a machine that does not have them (the port targets macOS, the suite should not).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { atoms, visibleLength, wrapText, wrapTextDetailed } from '../src/typeset/wrap.ts';
import { FontMetrics } from '../src/typeset/font-metrics.ts';
import { typeset, type FontFace } from '../src/typeset/text.ts';
import { renderCard } from '../src/typeset/card.ts';

// ---- deterministic measure: 10px per code point, no fonts involved --------

const measure = (text: string): number => [...text].length * 10;

// ---- atoms ----------------------------------------------------------------

test('punctuation sticks to the word before it and never starts a line', () => {
  assert.deepEqual(atoms('你好，世界。'), ['你', '好，', '世', '界。']);
  assert.deepEqual(atoms('OK，好'), ['OK，', '好']);
});

test('a quoted short phrase is one atom', () => {
  assert.deepEqual(atoms('「你好」'), ['「你好」']);
});

test('a number and its unit stay together', () => {
  assert.deepEqual(atoms('12岁'), ['12岁']);
  assert.deepEqual(atoms('2026年'), ['2026年']);
});

test('the middle dot glues to both of its neighbours', () => {
  assert.deepEqual(atoms('名字·间隔'), ['名', '字·间', '隔']);
});

test('protected words survive as single atoms', () => {
  assert.deepEqual(atoms('我叫小明', { protect: ['小明'] }), ['我', '叫', '小明']);
});

test('a latin run is one atom', () => {
  assert.deepEqual(atoms('用SVG排版'), ['用', 'SVG', '排', '版']);
});

test('visibleLength ignores punctuation and whitespace', () => {
  assert.equal(visibleLength('你好，世 界。'), 4);
  assert.equal(visibleLength('「」'), 0);
});

// ---- wrapping (measure = 10px per code point) ------------------------------

test('a long run breaks at the most balanced point, not at the hard limit', () => {
  // 16 chars, capacity 10: the hard limit would take 10 + 6, the balance term picks 8 + 8.
  assert.deepEqual(wrapText('一二三四五六七八九十一二三四五六', { width: 100, measure }), [
    '一二三四五六七八',
    '九十一二三四五六',
  ]);
});

test('a punctuation atom stays at the end of a line', () => {
  assert.deepEqual(wrapText('你好，世界。', { width: 39, measure }), ['你好，', '世界。']);
});

test('a sentence ending in a full stop does not take the next sentence along', () => {
  assert.deepEqual(wrapText('甲乙丙。丁戊己。', { width: 55, measure }), ['甲乙丙。', '丁戊己。']);
});

test('the orphan guard moves the last atom down to fill a two-char last line', () => {
  // Without the guard the last line would hold 「戊己。」 (two visible chars). 「丁。」 moves down
  // as one atom — the full stop travels with it, which is why it ends up mid-line.
  assert.deepEqual(wrapText('甲乙丙丁。戊己。', { width: 55, measure }), ['甲乙丙', '丁。戊己。']);
});

test('manual line breaks are kept and marked as hard breaks', () => {
  assert.deepEqual(wrapTextDetailed('第一行\n第二行', { width: 100, measure }), [
    { text: '第一行', soft: false },
    { text: '第二行', soft: false },
  ]);
});

test('soft breaks carry the flag justify uses', () => {
  assert.deepEqual(wrapTextDetailed('一二三四五六七八九十一二三四五六', { width: 100, measure }), [
    { text: '一二三四五六七八', soft: true },
    { text: '九十一二三四五六', soft: false },
  ]);
});

test('an atom wider than the column throws instead of overflowing silently', () => {
  assert.throws(() => wrapText('AAAAAAAAAA', { width: 50, measure }), /超过栏宽/);
});

// ---- real fonts (macOS system fonts, skipped elsewhere) --------------------

const SONGTI = '/System/Library/Fonts/Supplemental/Songti.ttc';
const TIMES = '/System/Library/Fonts/Supplemental/Times New Roman.ttf';
const hasSongti = existsSync(SONGTI);
const hasTimes = existsSync(TIMES);

const songFace = (): FontFace => ({
  family: 'Songti SC',
  metrics: FontMetrics.load(SONGTI, { index: 0 }),
});

test('FontMetrics reads the head/hhea/name tables of a real font', { skip: !hasSongti }, () => {
  const metrics = FontMetrics.load(SONGTI, { index: 0 });
  assert.ok(metrics.unitsPerEm > 0, 'unitsPerEm is read');
  assert.ok(metrics.ascentEm > 0, 'ascentEm is read');
  assert.ok(metrics.descentEm >= 0, 'descentEm is read');
  assert.ok(metrics.family !== null && metrics.family.length > 0, 'family name is read');
});

test('a full-width char advances by about 1em, missing glyphs report undefined', { skip: !hasSongti }, () => {
  const metrics = FontMetrics.load(SONGTI, { index: 0 });
  const guo = metrics.advanceEm('国'.codePointAt(0)!);
  assert.ok(guo !== undefined && Math.abs(guo - 1) < 0.05, `国 advances ${guo}em, want ≈1`);
  assert.equal(metrics.hasGlyph(0x1f600), false, 'no emoji glyph in Songti');
  assert.equal(metrics.advanceEm(0x1f600), undefined, 'and no advance either');
});

test('glyph bounds come from the glyf table', { skip: !hasSongti }, () => {
  const metrics = FontMetrics.load(SONGTI, { index: 0 });
  const bounds = metrics.boundsEm('国'.codePointAt(0)!);
  assert.ok(bounds !== undefined, 'Songti is TrueType, bounds are readable');
  assert.ok(bounds.xMin < bounds.xMax && bounds.yMin < bounds.yMax, 'a non-empty ink box');
  assert.ok(bounds.yMin < 0 && bounds.yMax > 0, 'the ink box straddles the baseline');
});

// ---- typeset ---------------------------------------------------------------

test('a short line is laid out and reports its height', { skip: !hasSongti }, () => {
  const face = songFace();
  const block = typeset('你好世界', { width: 800, size: 40, face });
  assert.equal(block.lineCount, 1);
  assert.ok(Math.abs(block.usedHeight - 40 * 1.36) < 1e-9, 'default line height is size × 1.36');
  assert.match(block.svg.value, /<text /);
  assert.ok(block.usedWidth > 0);
});

test('the dash is drawn as a thin rect, not as the font glyph', { skip: !hasSongti }, () => {
  const face = songFace();
  const block = typeset('见——如上', { width: 800, size: 40, face });
  assert.equal(block.glyphs.filter((glyph) => glyph.special === 'dash').length, 2);
  assert.match(block.svg.value, /<rect /);
  assert.equal(block.svg.value.includes('—'), false, 'the character itself is not emitted');
});

test('the ellipsis is drawn as three dots per mark', { skip: !hasSongti }, () => {
  const face = songFace();
  const block = typeset('如下……', { width: 800, size: 40, face });
  assert.equal(block.glyphs.filter((glyph) => glyph.special === 'dots').length, 2);
  assert.equal((block.svg.value.match(/<circle/g) ?? []).length, 6, 'two marks, three dots each');
});

test('brackets and the middle dot stay text glyphs and get a kerning shift', { skip: !hasSongti }, () => {
  const face = songFace();
  const block = typeset('【注】名·字', { width: 800, size: 40, face });
  assert.equal(block.svg.value.includes('<rect'), false, 'no special markup involved');
  assert.equal(block.svg.value.includes('<circle'), false, 'no special markup involved');
  for (const [char, special] of [
    ['【', 'bracket-open'],
    ['】', 'bracket-close'],
    ['·', 'middot'],
  ] as const) {
    const glyph = block.glyphs.find((item) => item.char === char && item.special === special);
    assert.ok(glyph !== undefined, `${char} is typeset as ${special}`);
    assert.notEqual(glyph.shift, 0, `${char} gets a side-bearing correction`);
  }
});

test('a missing glyph throws instead of drawing tofu', { skip: !hasSongti }, () => {
  const face = songFace();
  assert.throws(
    () => typeset('😀', { width: 800, size: 40, face }),
    /缺字.*U\+1F600/,
    'the error names the character and its code point',
  );
});

test('an overflowing block throws with both numbers', { skip: !hasSongti }, () => {
  const face = songFace();
  assert.throws(
    () => typeset('很长的一行字', { width: 800, size: 40, face, height: 10 }),
    /溢出/,
  );
});

test('maxLines truncates and adds a trailing ellipsis', { skip: !hasSongti }, () => {
  const face = songFace();
  const text = '一二三四五六七八九十'.repeat(3);
  const block = typeset(text, { width: 800, size: 40, face, maxLines: 1 });
  assert.equal(block.lineCount, 1);
  assert.ok(block.lines[0]!.endsWith('…'), 'the kept line ends with the ellipsis');
});

test('justify widens a soft-broken line and never changes the breaks', { skip: !hasSongti }, () => {
  const face = songFace();
  const text = '一二三四五六七八九十一二三四五六';
  const options = { width: 400, size: 48, face } as const;
  const plain = typeset(text, { ...options, justify: false });
  const stretched = typeset(text, { ...options, justify: true });
  assert.equal(stretched.lineCount, plain.lineCount, 'justify does not move the breaks');
  const rowWidth = (block: typeof plain): number =>
    block.glyphs.filter((glyph) => glyph.line === 0).reduce((sum, glyph) => sum + glyph.advance, 0);
  assert.ok(rowWidth(stretched) > rowWidth(plain), 'the first line is stretched to the column width');
});

test('latin runs can render in their own face on the shared baseline', { skip: !hasSongti || !hasTimes }, () => {
  const face = songFace();
  const latin: FontFace = {
    family: 'Times New Roman',
    metrics: FontMetrics.load(TIMES, { index: 0 }),
  };
  const block = typeset('SVG 排版', { width: 800, size: 40, face, latin });
  assert.equal(block.glyphs.find((glyph) => glyph.char === 'S')!.family, 'Times New Roman');
  assert.equal(block.glyphs.find((glyph) => glyph.char === '排')!.family, 'Songti SC');
});

// ---- renderCard ------------------------------------------------------------

test('a card that fits is laid out at the top scale', { skip: !hasSongti }, () => {
  const card = renderCard({
    width: 1080,
    height: 1440,
    face: songFace(),
    blocks: [
      { kind: 'text', text: '标题', role: 'title' },
      { kind: 'rule' },
      { kind: 'text', text: '正文。', role: 'body' },
    ],
    footer: 'footer',
  });
  assert.equal(card.scale, 1.08, 'the first scale that fits wins');
  assert.deepEqual(
    card.placements.map((placement) => placement.kind),
    ['text', 'rule', 'text'],
  );
  const ys = card.placements.map((placement) => placement.y);
  assert.ok(ys[0]! < ys[1]! && ys[1]! < ys[2]!, 'blocks run top to bottom');
  assert.match(card.svg.value, /<text /);
  assert.match(card.svg.value, /<rect /, 'the rule and the background are rects');
});

test('too much text throws with what is needed and what there is', { skip: !hasSongti }, () => {
  const long = '这是一句很长的测试文本。'.repeat(50);
  assert.throws(
    () => renderCard({ width: 1080, height: 1440, face: songFace(), blocks: [{ kind: 'text', text: long }] }),
    (error: Error) => /放不下/.test(error.message) && /需要/.test(error.message) && /只有/.test(error.message),
  );
});

test('appear keeps a block invisible before its time', { skip: !hasSongti }, () => {
  const spec = {
    width: 1080,
    height: 1440,
    face: songFace(),
    blocks: [
      { kind: 'text' as const, text: '第一块', appear: { at: 0, dur: 0.4 } },
      { kind: 'text' as const, text: '第二块', appear: { at: 0.5, dur: 0.4 } },
    ],
  };
  const early = renderCard(spec, undefined, { localTime: 0.3 });
  assert.ok(early.svg.value.includes('第一块'), 'the first block is up');
  assert.equal(early.svg.value.includes('第二块'), false, 'the second one has not started');
  assert.match(early.svg.value, /opacity="0\.844"/, 'eased ink at 75% of the first fade');

  const later = renderCard(spec, undefined, { localTime: 0.7 });
  assert.ok(later.svg.value.includes('第二块'), 'the second block is up too');
});

test('without appear the frame is static and carries no opacity', { skip: !hasSongti }, () => {
  const card = renderCard({
    width: 1080,
    height: 1440,
    face: songFace(),
    blocks: [{ kind: 'text', text: '静态帧' }],
  });
  assert.ok(card.svg.value.includes('静态帧'));
  assert.equal(card.svg.value.includes('opacity'), false);
});
