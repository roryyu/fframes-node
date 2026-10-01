/**
 * `projects.test.ts` — storage: import normalisation, the `?v=` cache bust, containment, and the
 * asset library rules of §5.5 / §8.4 / §8.5.
 *
 * Everything runs offline. The one test that really imports a `video.ts` writes its projects *inside*
 * the repository (`.studio/test-*`, gitignored and removed afterwards) on purpose: the canonical
 * import specifier is `'../../../src/index.ts'`, which only resolves three levels below the repo
 * root, so a temp directory under `/tmp` could not exercise the normalisation end to end.
 */

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, loadConfig } from '../../src/studio/config.ts';
import type { StudioConfig } from '../../src/studio/config.ts';
import {
  ProjectError,
  createProject,
  deleteAsset,
  getAssetRefs,
  listAssets,
  listProjects,
  loadProject,
  normalizeImports,
  readSource,
  resolveAssetPath,
  resolveProject,
  saveAsset,
  sourceRevision,
  writeSource,
} from '../../src/studio/projects.ts';

/** The canonical specifier every import must end up as (§5.5, decision D4). */
const CANONICAL = "'../../../src/index.ts'";

/** `\x89PNG\r\n\x1a\n` plus an IHDR length/type, enough for the magic check (ffprobe will fail: fine). */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
const NOT_AN_IMAGE = new TextEncoder().encode('<?php echo 1; ?>\n');

/** A config rooted in a throwaway directory inside `.studio/`, cleaned up by `t.after`. */
function workspace(t: TestContext, overrides: Partial<StudioConfig> = {}): StudioConfig {
  const projectsRoot = join(REPO_ROOT, '.studio', `test-${randomBytes(4).toString('hex')}`);
  t.after(() => rmSync(projectsRoot, { recursive: true, force: true }));
  return Object.freeze({
    ...loadConfig({
      LLM_BASE_URL: 'https://mock.invalid/v1',
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_MODEL: 'mock-code-model',
      LLM_MOCK_DIR: '',
    }),
    repoRoot: REPO_ROOT,
    projectsRoot,
    ...overrides,
  });
}

/** A `video.ts` whose import is deliberately at the wrong depth, the way a model writes it. */
function videoSource(fps: number): string {
  return [
    "import { svgr, seconds, AudioMap } from '../../src/index.ts';",
    "import type { FFramesContext, Frame, Svgr, Video } from '../../src/index.ts';",
    '',
    'class StudioTestVideo implements Video {',
    `  readonly fps = ${fps};`,
    '  readonly width = 32;',
    '  readonly height = 18;',
    '',
    '  duration() {',
    '    return seconds(1);',
    '  }',
    '',
    '  audio(): AudioMap {',
    '    return AudioMap.none();',
    '  }',
    '',
    '  defineScenes(): null {',
    '    return null;',
    '  }',
    '',
    '  fonts(): string[] {',
    "    return ['/System/Library/Fonts/Helvetica.ttc'];",
    '  }',
    '',
    '  renderFrame(_frame: Frame, _ctx: FFramesContext): Svgr {',
    '    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18">' +
      '<rect width="32" height="18" x="0" y="0" fill="#123456" /></svg>`;',
    '  }',
    '}',
    '',
    'export default new StudioTestVideo();',
    '',
  ].join('\n');
}

/** Asserts `fn` throws a `ProjectError` with `code`. */
function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ProjectError, `expected a ProjectError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// import normalisation
// ---------------------------------------------------------------------------

test('every malformed fframes specifier becomes the canonical one', () => {
  const cases: readonly (readonly [string, string])[] = [
    [
      "import { svgr } from '../../src/index.ts';",
      `import { svgr } from ${CANONICAL};`,
    ],
    ["import { svgr } from './src/index.ts';", `import { svgr } from ${CANONICAL};`],
    ["import { svgr } from '../src/index.ts';", `import { svgr } from ${CANONICAL};`],
    ['import { svgr } from "fframes";', 'import { svgr } from "../../../src/index.ts";'],
    ['import { svgr } from "../../../src/index.ts";', 'import { svgr } from "../../../src/index.ts";'],
    ['import { svgr } from "/abs/fframes-node/src/index.ts";', 'import { svgr } from "../../../src/index.ts";'],
    ["import type { Video } from '../../src/index.ts';", `import type { Video } from ${CANONICAL};`],
    ["export { svgr } from '../../src/index.ts';", `export { svgr } from ${CANONICAL};`],
    ["import '../../src/index.ts';", `import ${CANONICAL};`],
    [
      "import { svgr } from 'fframes';\nimport type { Video } from '../../src/index.ts';\n",
      `import { svgr } from ${CANONICAL};\nimport type { Video } from ${CANONICAL};\n`,
    ],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeImports(input), expected, `input: ${input}`);
  }
});

test('normalisation is idempotent and leaves other imports alone', () => {
  const source = [
    "import { join } from 'node:path';",
    "import { helper } from './helper.ts';",
    "import { svgr } from '../../src/index.ts';",
    '',
    'export default { join, helper, svgr };',
    '',
  ].join('\n');
  const once = normalizeImports(source);
  assert.equal(normalizeImports(once), once, 'a second pass must change nothing');
  assert.ok(once.includes("from 'node:path'"), 'node: imports are untouched');
  assert.ok(once.includes("from './helper.ts'"), 'a sibling import is untouched');
  assert.ok(once.includes(`import { svgr } from ${CANONICAL};`));
  assert.ok(source.includes("from '../../src/index.ts'"), 'the input is not mutated');
  assert.equal(normalizeImports(''), '');
});

// ---------------------------------------------------------------------------
// the project lifecycle and the module cache
// ---------------------------------------------------------------------------

test('a new project has video.ts, media/, out/ and an empty manifest', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  assert.match(project.id, /^p-\d{13}-[0-9a-f]{6}$/);
  assert.ok(project.id.split('').every((character) => /[A-Za-z0-9._-]/.test(character)));
  assert.ok(existsSync(project.dir));
  assert.ok(existsSync(project.mediaDir));
  assert.ok(existsSync(join(project.dir, 'out')));
  assert.deepEqual(JSON.parse(readFileSync(project.assetsPath, 'utf8')), []);
  assert.equal(project.videoPath, join(project.dir, 'video.ts'));
  assert.equal(listProjects(cfg).length, 1);
  assert.equal(sourceRevision(project), 0, 'a project that was never written has revision 0');
});

test('writeSource normalises on the way in and bumps the revision', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  writeSource(project, videoSource(30));
  assert.equal(readSource(project), normalizeImports(videoSource(30)));
  assert.ok(readSource(project).includes(`import { svgr, seconds, AudioMap } from ${CANONICAL};`));
  assert.ok(!readSource(project).includes("'../../src/index.ts'"));
  assert.equal(sourceRevision(project), 1);
  writeSource(project, videoSource(24));
  assert.equal(sourceRevision(project), 2);
});

test('loadProject re-evaluates the file after a write (?v=rev)', async (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);

  writeSource(project, videoSource(24));
  const first = await loadProject(project, cfg);
  assert.equal(first.video.fps, 24);
  assert.equal(first.session.video.fps, 24);
  assert.equal(first.session.size.width, 32);

  // Same path, same file name: without the revision query this would return the module above.
  writeSource(project, videoSource(30));
  const second = await loadProject(project, cfg);
  assert.equal(second.video.fps, 30, 'the rewritten video.ts must be a new module');
  assert.equal(second.session.video.fps, 30);
});

test('createProject refuses to pass maxProjects', (t) => {
  const cfg = workspace(t, { maxProjects: 1 });
  createProject(cfg);
  throwsCode(() => createProject(cfg), 'PROJECT_LIMIT');
});

test('listProjects ignores files and keeps the newest id first', (t) => {
  const cfg = workspace(t);
  const first = createProject(cfg);
  const second = createProject(cfg);
  writeFileSync(join(cfg.projectsRoot, 'stray.txt'), 'not a project', 'utf8');
  assert.deepEqual(
    listProjects(cfg).map((project) => project.id),
    [second.id, first.id],
  );
  assert.ok(listProjects(cfg).every((project) => project.id !== 'stray.txt'));
});

// ---------------------------------------------------------------------------
// containment
// ---------------------------------------------------------------------------

test('resolveProject refuses anything that is not a project id inside the root', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  for (const id of ['../../etc', '..', '.', `${project.id}/../${project.id}`, '/etc/passwd', 'a/b', '', 'p 1']) {
    throwsCode(() => resolveProject(cfg, id), 'INVALID_PROJECT_ID');
  }
  // A whitelist-clean id that simply does not exist is a 404, not a 400.
  throwsCode(() => resolveProject(cfg, 'p-1730000000000-abcdef'), 'PROJECT_NOT_FOUND');
  // And the real one resolves to the same paths createProject gave.
  assert.deepEqual(resolveProject(cfg, project.id), project);
});

test('a name that only shares the root as a string prefix is still refused', (t) => {
  const cfg = workspace(t);
  createProject(cfg);
  // `..evil` passes the `[A-Za-z0-9._-]` whitelist and starts with the same characters the root
  // does, so only the per-segment containment check can catch it: it resolves to `<root>/../evil`.
  throwsCode(() => resolveProject(cfg, '..evil'), 'INVALID_PROJECT_ID');
  throwsCode(() => resolveProject(cfg, '..'), 'INVALID_PROJECT_ID');
});

test('resolveAssetPath refuses traversal and separators', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  for (const name of ['../video.ts', '../../etc/passwd', '..', '.', 'a/b.png', 'a\\b.png', '', 'x.png/']) {
    throwsCode(() => resolveAssetPath(project, name), 'INVALID_ASSET_NAME');
  }
  const resolved = resolveAssetPath(project, 'logo.png');
  assert.equal(resolved, join(project.mediaDir, 'logo.png'));
  assert.ok(resolved.startsWith(`${project.mediaDir}/`) || resolved.startsWith(`${project.mediaDir}\\`));
});

// ---------------------------------------------------------------------------
// the asset library
// ---------------------------------------------------------------------------

test('saveAsset writes the file and records the manifest', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  const asset = saveAsset(
    project,
    { suggestedName: 'logo.png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfg,
  );
  assert.equal(asset.name, 'logo.png');
  assert.equal(asset.mime, 'image/png');
  assert.equal(asset.bytes, PNG_BYTES.byteLength);
  assert.equal(asset.source, 'upload');
  assert.equal(asset.description, null);
  assert.equal(readFileSync(join(project.mediaDir, 'logo.png')).length, PNG_BYTES.byteLength);
  assert.deepEqual(listAssets(project).map((entry) => entry.name), ['logo.png']);
  assert.deepEqual(
    JSON.parse(readFileSync(project.assetsPath, 'utf8')).map((entry: { name: string }) => entry.name),
    ['logo.png'],
  );
});

test('saveAsset derives the extension from the mime, not from the name', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  const jpeg = saveAsset(
    project,
    { suggestedName: 'photo.png', bytes: JPEG_BYTES, mime: 'image/jpeg', source: 'upload' },
    cfg,
  );
  assert.equal(jpeg.name, 'photo.jpg', 'a jpeg declared as a .png has to become a .jpg');
  const gif = saveAsset(
    project,
    { suggestedName: 'anim.gif', bytes: GIF_BYTES, mime: 'image/gif', source: 'generated' },
    cfg,
  );
  assert.equal(gif.name, 'anim.gif');
  assert.equal(gif.source, 'generated');
});

test('saveAsset sanitises the name and de-duplicates instead of overwriting', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  const messy = saveAsset(
    project,
    { suggestedName: 'my logo (1).png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfg,
  );
  assert.equal(messy.name, 'mylogo1.png');

  const fallback = saveAsset(
    project,
    { suggestedName: '???', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfg,
  );
  assert.match(fallback.name, /^asset-\d+\.png$/);

  const names = ['logo.png', 'logo.png', 'logo.png'].map((suggestedName) =>
    saveAsset(
      project,
      { suggestedName, bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
      cfg,
    ).name,
  );
  assert.deepEqual(names, ['logo.png', 'logo-1.png', 'logo-2.png']);
  // The first file is untouched: a duplicate never overwrites.
  assert.equal(readFileSync(join(project.mediaDir, 'logo.png')).length, PNG_BYTES.byteLength);
});

test('saveAsset refuses a name that tries to be a path', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  for (const suggestedName of ['../../evil.png', '..', '.', 'media/../../x.png', 'a\\b.png']) {
    throwsCode(
      () =>
        saveAsset(
          project,
          { suggestedName, bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
          cfg,
        ),
      'INVALID_ASSET_NAME',
    );
  }
  assert.deepEqual(listAssets(project), [], 'nothing was written');
  assert.ok(!existsSync(join(cfg.repoRoot, 'evil.png')));
});

test('saveAsset refuses a mime the bytes do not back up', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  // The forged extension: declared png, actually a gif (and text, and a truncated png).
  throwsCode(
    () =>
      saveAsset(
        project,
        { suggestedName: 'forged.png', bytes: GIF_BYTES, mime: 'image/png', source: 'upload' },
        cfg,
      ),
    'ASSET_MAGIC_MISMATCH',
  );
  throwsCode(
    () =>
      saveAsset(
        project,
        { suggestedName: 'shell.png', bytes: NOT_AN_IMAGE, mime: 'image/png', source: 'upload' },
        cfg,
      ),
    'ASSET_MAGIC_MISMATCH',
  );
  throwsCode(
    () =>
      saveAsset(
        project,
        { suggestedName: 'short.png', bytes: PNG_BYTES.subarray(0, 4), mime: 'image/png', source: 'upload' },
        cfg,
      ),
    'ASSET_MAGIC_MISMATCH',
  );
  throwsCode(
    () =>
      saveAsset(
        project,
        { suggestedName: 'x.webp', bytes: PNG_BYTES, mime: 'image/webp', source: 'upload' },
        cfg,
      ),
    'UNSUPPORTED_IMAGE_TYPE',
  );
  assert.deepEqual(listAssets(project), []);
});

test('saveAsset refuses an oversized upload', (t) => {
  const cfg = workspace(t, { maxUploadBytes: PNG_BYTES.byteLength - 1 });
  const project = createProject(cfg);
  throwsCode(
    () =>
      saveAsset(
        project,
        { suggestedName: 'big.png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
        cfg,
      ),
    'ASSET_TOO_LARGE',
  );
  // Exactly at the limit is fine.
  const cfgAtLimit = workspace(t, { maxUploadBytes: PNG_BYTES.byteLength });
  const projectAtLimit = createProject(cfgAtLimit);
  const asset = saveAsset(
    projectAtLimit,
    { suggestedName: 'exact.png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfgAtLimit,
  );
  assert.equal(asset.bytes, PNG_BYTES.byteLength);
});

test('listAssets is the manifest reconciled against the directory', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  saveAsset(
    project,
    { suggestedName: 'a.png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfg,
  );
  saveAsset(
    project,
    { suggestedName: 'b.png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfg,
  );
  assert.deepEqual(listAssets(project).map((entry) => entry.name), ['a.png', 'b.png']);
  // Deleting the file behind the studio's back must hide the entry (§5.5).
  unlinkSync(join(project.mediaDir, 'a.png'));
  assert.deepEqual(listAssets(project).map((entry) => entry.name), ['b.png']);
});

test('deleteAsset removes the file and the entry, and is not a no-op for a stranger', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  saveAsset(
    project,
    { suggestedName: 'a.png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfg,
  );
  saveAsset(
    project,
    { suggestedName: 'b.png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfg,
  );
  deleteAsset(project, 'a.png');
  assert.ok(!existsSync(join(project.mediaDir, 'a.png')));
  assert.deepEqual(listAssets(project).map((entry) => entry.name), ['b.png']);
  assert.deepEqual(
    JSON.parse(readFileSync(project.assetsPath, 'utf8')).map((entry: { name: string }) => entry.name),
    ['b.png'],
  );
  throwsCode(() => deleteAsset(project, 'a.png'), 'ASSET_NOT_FOUND');
  throwsCode(() => deleteAsset(project, '../video.ts'), 'INVALID_ASSET_NAME');
});

test('getAssetRefs turns ticked names into prompt input, skipping the unknown', (t) => {
  const cfg = workspace(t);
  const project = createProject(cfg);
  saveAsset(
    project,
    {
      suggestedName: 'logo.png',
      bytes: PNG_BYTES,
      mime: 'image/png',
      source: 'generated',
      description: '蓝色圆形标志',
      width: 1024,
      height: 1024,
    },
    cfg,
  );
  saveAsset(
    project,
    { suggestedName: 'bg.png', bytes: PNG_BYTES, mime: 'image/png', source: 'upload' },
    cfg,
  );
  assert.deepEqual(
    getAssetRefs(project, ['logo.png', 'bg.png', 'ghost.png', '../escape.png']),
    [
      { name: 'logo.png', description: '蓝色圆形标志', width: 1024, height: 1024 },
      { name: 'bg.png', description: '' },
    ],
  );
  assert.deepEqual(getAssetRefs(project, []), []);
});
