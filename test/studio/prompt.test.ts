/**
 * `prompt.test.ts` — the system prompt says everything §5.4 requires, and the fence helper behaves.
 *
 * The prompt is the quality core of Studio and the gate can only check it by grepping, so the markers
 * pinned here are the same ones the gate looks for: the `Video` contract, the import list,
 * `animate`/`timeline`/`Easing`, the `svgr` rules, the image asset rule **including the null guard**,
 * the erasable syntax constraints, the font path, the determinism rule, the 10 second ceiling and the
 * single ```ts fence.
 *
 * The golden example is pinned *byte for byte* against `examples/hello-world/video.ts` on disk, so
 * "verbatim" is a fact rather than a claim: an editing slip in `prompt.ts` fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractCodeFence } from '../../src/studio/llm.ts';
import {
  ASSET_REFERENCE_SNIPPET,
  DEFAULT_FONT_FILE,
  EXAMPLES,
  FFRAMES_SPECIFIER,
  HELLO_WORLD_EXAMPLE,
  SYSTEM_PROMPT,
  VISION_INSTRUCTION,
  buildUserPrompt,
} from '../../src/studio/prompt.ts';

/** Asserts every marker of `markers` appears in `haystack`, naming the first that does not. */
function containsAll(haystack: string, markers: readonly string[], what: string): void {
  for (const marker of markers) {
    assert.ok(haystack.includes(marker), `${what} is missing ${JSON.stringify(marker)}`);
  }
}

test('the Video contract is spelled out member by member', () => {
  containsAll(
    SYSTEM_PROMPT,
    [
      'readonly fps: number;',
      'readonly width: number;',
      'readonly height: number;',
      'duration(): Duration;',
      'audio(): AudioMap;',
      'fonts(): string[];',
      'renderFrame(frame: Frame, ctx: FFramesContext): Svgr;',
      'defineScenes(): readonly Scene[] | null;',
      'readonly defaultOutput?: string;',
      'export default new X();',
      'AudioMap.none()',
      'return null',
    ],
    'the Video contract',
  );
});

test('the import list is the real one, from the canonical specifier', () => {
  containsAll(
    SYSTEM_PROMPT,
    [
      'svgr, seconds, frames, auto, fromAudio, timeline, Easing, Color, Transform, AudioMap, audioTrack, Svgr, Scenes',
      'Video, Scene, Frame, FFramesContext, Duration',
      '必须带 `.ts` 扩展名',
      // Svgr must never be taught as a type-only import: it carries `.empty()`/`.group()` statics,
      // so `import type { Svgr }` gets erased and `Svgr.empty()` throws `Svgr is not defined`.
      'Svgr 永远当值导入',
      'Svgr is not defined',
    ],
    'the import list',
  );
  assert.equal(FFRAMES_SPECIFIER, '../../../src/index.ts');
  assert.ok(
    SYSTEM_PROMPT.includes(`'${FFRAMES_SPECIFIER}'`),
    'the canonical specifier must appear verbatim in the prompt',
  );
});

test('animation, svgr and the empty-frame fallback are covered', () => {
  containsAll(
    SYSTEM_PROMPT,
    [
      'frame.animate(',
      'timeline<',
      'Easing.linear',
      'Easing.easeIn',
      'Easing.easeOut',
      'Easing.easeInOut',
      'Easing.cubicBezier(',
      'Easing.spring(',
      'frame.animateLoop(',
      'svgr`<svg',
      'Svgr.empty()',
      'ctx.renderScenes(frame)',
    ],
    'the animation and svgr rules',
  );
});

test('the image asset rule includes the null guard and the supported types', () => {
  containsAll(
    SYSTEM_PROMPT,
    [
      "ctx.getImage('logo.png')",
      "ctx.getImage('logo.png') ?? ''",
      'ctx.hasMedia(',
      '<image href=',
      'preserveAspectRatio="xMidYMid meet"',
      'png / gif / jpg / jpeg',
      '返回 null',
    ],
    'the image asset rules',
  );
  // The same rule has to survive in the fragment the model copies from.
  containsAll(
    ASSET_REFERENCE_SNIPPET,
    ["ctx.getImage('logo.png') ?? ''", 'ctx.hasMedia(', '<image href=', 'preserveAspectRatio='],
    'the asset reference snippet',
  );
});

test('the hard constraints name erasable syntax, the font file and determinism', () => {
  containsAll(
    SYSTEM_PROMPT,
    [
      '禁 enum',
      '禁 namespace',
      '构造函数参数属性',
      '禁装饰器',
      '.ts',
      DEFAULT_FONT_FILE,
      "['/System/Library/Fonts/Helvetica.ttc']",
      'font-family="Helvetica"',
      '禁止网络请求',
      '禁止文件 IO',
      '禁止随机数',
      'ctx.getImage 是唯一合法的媒体读取口',
    ],
    'the hard constraints',
  );
  assert.equal(DEFAULT_FONT_FILE, '/System/Library/Fonts/Helvetica.ttc');
});

test('the duration ceiling and the single fence rule are stated', () => {
  containsAll(
    SYSTEM_PROMPT,
    ['duration() ≤ 10 秒', 'seconds(n)', '只输出一个 ```ts 代码围栏'],
    'the output rules',
  );
});

test('the golden example is the hello-world file, byte for byte', () => {
  const onDisk = readFileSync(
    new URL('../../examples/hello-world/video.ts', import.meta.url),
    'utf8',
  );
  assert.equal(
    HELLO_WORLD_EXAMPLE.trim(),
    onDisk.trim(),
    'HELLO_WORLD_EXAMPLE must be examples/hello-world/video.ts verbatim',
  );
  assert.ok(
    SYSTEM_PROMPT.includes(HELLO_WORLD_EXAMPLE.trim()),
    'the prompt must embed the golden example',
  );
  // And the embedded copy still looks like the file it claims to be.
  containsAll(
    HELLO_WORLD_EXAMPLE,
    [
      'class HelloWorld implements Video',
      'export default new HelloWorld();',
      'ctx.renderScenes(frame)',
      "return ['/System/Library/Fonts/Helvetica.ttc'];",
    ],
    'the golden example',
  );
});

test('buildUserPrompt is the sentence alone when nothing is ticked', () => {
  const prompt = '做一个 5 秒的开场，深蓝渐变背景';
  assert.equal(buildUserPrompt(prompt), prompt);
  assert.equal(buildUserPrompt(`  ${prompt}  `), prompt);
  assert.equal(buildUserPrompt(prompt, []), prompt);
  assert.ok(!buildUserPrompt(prompt).includes('可用素材'));
});

test('buildUserPrompt injects the ticked assets in the contract format', () => {
  const prompt = buildUserPrompt('做一个片头', [
    { name: 'logo.png', description: '蓝色圆形标志', width: 1024, height: 1024 },
    { name: 'bg.png', description: '渐变背景' },
  ]);
  assert.ok(prompt.startsWith('做一个片头'));
  assert.ok(prompt.includes("可用素材（已在 media/ 中，用 ctx.getImage('<name>') 引用）："));
  assert.ok(prompt.includes('- logo.png（1024x1024）：蓝色圆形标志'));
  assert.ok(prompt.includes('- bg.png：渐变背景'), 'an asset without a size must not print a broken one');
  assert.ok(!prompt.includes('undefined'));
  assert.ok(prompt.includes('不要臆造不存在的素材名'));
  assert.ok(prompt.includes("ctx.getImage(name) ?? ''"));
});

test('an asset with no description still gets a placeholder', () => {
  const prompt = buildUserPrompt('x', [{ name: 'bg.png', description: '   ' }]);
  assert.ok(prompt.includes('- bg.png：（无描述）'));
});

test('the vision instruction asks for a short description plus a use', () => {
  containsAll(
    VISION_INSTRUCTION,
    ['主体', '配色', '风格', '≤120字', '怎么用'],
    'the vision instruction',
  );
});

test('EXAMPLES gives the ① panel at least three ready to send prompts', () => {
  assert.ok(EXAMPLES.length >= 3, `expected 3+ chips, got ${EXAMPLES.length}`);
  const names = new Set<string>();
  for (const chip of EXAMPLES) {
    assert.ok(chip.name.length > 0, 'a chip needs a name');
    assert.ok(chip.prompt.length > 10, `chip "${chip.name}" needs a real prompt`);
    assert.ok(!names.has(chip.name), `duplicate chip name ${chip.name}`);
    names.add(chip.name);
  }
  assert.ok(names.has('hello-world'), 'the page mockup (§1) shows a hello-world chip');
});

test('extractCodeFence strips a ts fence and keeps everything else', () => {
  assert.equal(extractCodeFence('```ts\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(
    extractCodeFence('Here you go:\n```ts\nconst a = 1;\n```\nHope that helps.'),
    'const a = 1;',
    'prose around the fence must be dropped',
  );
  assert.equal(
    extractCodeFence('```typescript\nconst a: number = 1;\n```'),
    'const a: number = 1;',
  );
  assert.equal(extractCodeFence('```ts\r\nconst a = 1;\r\n```'), 'const a = 1;', 'CRLF too');
});

test('extractCodeFence prefers the ts fence and falls back to the first one', () => {
  assert.equal(
    extractCodeFence('```json\n{"a":1}\n```\n```ts\nconst a = 1;\n```'),
    'const a = 1;',
    'a stray json fence must not win over the ts one',
  );
  assert.equal(
    extractCodeFence('```js\nconst a = 1;\n```'),
    'const a = 1;',
    'a fence in another language is still code',
  );
  assert.equal(extractCodeFence('```ts const a = 1; ```'), 'const a = 1;', 'single line fence');
});

test('extractCodeFence takes a fence-less completion as the source', () => {
  const raw = 'const a = 1;\nexport default a;\n';
  assert.equal(extractCodeFence(raw), 'const a = 1;\nexport default a;');
  // The mock fixture ships without a fence, so this is the path the gate exercises.
  assert.ok(
    extractCodeFence('import { svgr } from \'../../src/index.ts\';\nexport default null;').includes(
      'import { svgr }',
    ),
  );
});
