/**
 * `pipeline.test.ts` — the orchestration layer against a real video (`page.md` §5.6).
 *
 * Two fixtures, on purpose:
 *
 * - **`examples/hello-world`** for `timeline` / `inspect` / `framePng` / `frameSvg`. It is the golden
 *   sample of `prompt.ts` and a real 30 fps, 1920x1080, two scene video, so the reports and the PNG
 *   are the ones a user would actually get. The PNG check is byte level: the first eight bytes of a
 *   real rasterization must be the PNG signature, which is what `<img src="/api/frame?…">` depends on.
 * - **a throwaway project** for `validate`, because validating `hello-world` would rasterize ~35
 *   sampled frames again. The synthetic video is 32x18 and one second long, so the five short circuit
 *   steps are cheap — which is what lets this file also pin the *failure* paths: an unimportable
 *   module (`stage: 'import'`) and a video whose every frame is `Svgr.empty()`.
 *
 * The empty-frame case is the interesting one: §5.6 says `probe-frame` must tell an empty document
 * from a real failure, and a `Svgr.empty()` frame is a legal `renderFrame` return that resvg refuses
 * to rasterize. It has to stay `ok: true` with a warning — otherwise every legitimate fade-from-black
 * video would be rejected.
 *
 * The projects live inside the repository (`.studio/test-*`, gitignored, removed by `t.after`)
 * because the canonical import specifier `'../../../src/index.ts'` only resolves three levels below
 * the repo root (§5.5, decision D4).
 */

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { REPO_ROOT, loadConfig } from '../../src/studio/config.ts';
import type { StudioConfig } from '../../src/studio/config.ts';
import { buildSession, framePng, frameSvg, inspect, timeline, validate } from '../../src/studio/pipeline.ts';
import { createProject, readSource, writeSource } from '../../src/studio/projects.ts';
import type { Project } from '../../src/studio/types.ts';

/** `\x89PNG\r\n\x1a\n` — the eight bytes that make a response a PNG and not an error page. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The canonical specifier the generated files must end up with (§5.5). */
const CANONICAL = "../../../src/index.ts";

/** The golden sample, addressed as a `Project` without creating one on disk. */
function helloWorldProject(): Project {
  const videoPath = join(REPO_ROOT, 'examples', 'hello-world', 'video.ts');
  const dir = dirname(videoPath);
  return {
    id: 'p-test-hello-world',
    dir,
    videoPath,
    mediaDir: join(dir, 'media'),
    assetsPath: join(dir, 'assets.json'),
  };
}

/** A config whose `projectsRoot` is a throwaway directory inside `.studio/`. */
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

/**
 * A 32x18, 1 s video written with the *wrong* import depth, the way a model emits it, so every test
 * that uses this also exercises `projects.normalizeImports` on the way in.
 */
function videoSource(renderFrame: string): string {
  return [
    "import { AudioMap, Svgr, seconds, svgr } from '../../src/index.ts';",
    "import type { FFramesContext, Frame, Video } from '../../src/index.ts';",
    '',
    'class StudioPipelineVideo implements Video {',
    '  readonly fps = 30;',
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
    '    return [];',
    '  }',
    '',
    '  renderFrame(_frame: Frame, _ctx: FFramesContext): Svgr {',
    `    ${renderFrame}`,
    '  }',
    '}',
    '',
    'export default new StudioPipelineVideo();',
    '',
  ].join('\n');
}

const PAINTED = videoSource(
  'return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18">' +
    '<rect width="32" height="18" x="0" y="0" fill="#123456" /></svg>`;',
);

/** Every frame is `Svgr.empty()`: legal for `renderFrame`, refused by the rasterizer. */
const EMPTY = videoSource('return Svgr.empty();');

/** `renderFrame` throws: this one really is an error, and validation must say so. */
const THROWS = videoSource('throw new Error("boom from renderFrame");');

/** Writes `source` into a fresh project. `workspace`'s `t.after` removes the directory again. */
function projectWith(cfg: StudioConfig, source: string): Project {
  const project = createProject(cfg);
  writeSource(project, source);
  return project;
}

// ---------------------------------------------------------------------------
// the reporting commands
// ---------------------------------------------------------------------------

test('timeline reports the real shape of the golden sample', async () => {
  const session = await buildSession(helloWorldProject(), loadConfig());
  const report = timeline(session);

  assert.ok(report.fps > 0, `fps must be positive, got ${report.fps}`);
  assert.ok(report.durationFrames > 0, `durationFrames must be positive, got ${report.durationFrames}`);
  assert.equal(report.fps, 30);
  assert.equal(report.width, 1920);
  assert.equal(report.height, 1080);
  // Two 15 s scenes at 30 fps.
  assert.equal(report.durationFrames, 900);
  assert.equal(report.durationSeconds, 30);
  assert.equal(report.scenes.length, 2);
  assert.deepEqual(
    report.scenes.map((scene) => scene.name),
    ['SceneOne', 'SceneTwo'],
  );
  assert.equal(report.scenes[0]?.startFrame, 0);
  assert.equal(report.scenes[1]?.endFrame, 900);
  assert.ok(Array.isArray(report.audio.tracks), 'audio.tracks is a list, even when empty');
});

test('inspect walks the golden sample and returns the public result shape', async () => {
  const session = await buildSession(helloWorldProject(), loadConfig());
  const result = inspect(session);

  assert.ok(Array.isArray(result.findings), 'findings is always a list');
  assert.ok(result.checkedFrames > 0, `checkedFrames must be positive, got ${result.checkedFrames}`);
  assert.equal(typeof result.exitCode, 'number');
  for (const finding of result.findings) {
    assert.ok(
      ['info', 'warning', 'error'].includes(finding.severity),
      `unexpected severity ${finding.severity}`,
    );
    assert.equal(typeof finding.kind, 'string');
    assert.equal(typeof finding.message, 'string');
  }
});

test('framePng rasterizes a real frame and frameSvg returns the markup', async () => {
  const session = await buildSession(helloWorldProject(), loadConfig());
  const png = framePng(session, '0');

  assert.ok(png.byteLength > 8, `a rasterized frame is bigger than a header, got ${png.byteLength}`);
  assert.deepEqual([...png.subarray(0, 8)], PNG_MAGIC, 'the first 8 bytes must be the PNG signature');
  // A PNG ends with an IEND chunk, which is what `render().asPng()` always writes.
  assert.equal(png.subarray(png.byteLength - 8, png.byteLength - 4).toString('latin1'), 'IEND');

  const svg = frameSvg(session, '0');
  assert.ok(svg.includes('<svg'), 'frameSvg returns the document itself');
  assert.ok(svg.includes('</svg>'), 'frameSvg returns a complete document');
});

test('a frame spec understands the TimeSpec syntax, and a bad one is refused', async () => {
  const session = await buildSession(helloWorldProject(), loadConfig());
  assert.deepEqual([...framePng(session, '30').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual([...framePng(session, '50%').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(frameSvg(session, 'SceneOne').includes('<svg'), 'a scene name is a valid spec');
  // Two distinct refusals, both surfaced verbatim from `TimelineIndex` (§5.6/§5.8): malformed syntax
  // (`#nope` — a `#` index that is not a number) is "can not parse", while a well-formed token that
  // simply names no scene of a video that *has* scenes is "no scene …".
  assert.throws(() => framePng(session, '#nope'), /can not parse/);
  assert.throws(() => framePng(session, 'nonsense!!'), /no scene/);
  assert.throws(() => framePng(session, '99999'), /outside the video/);
});

// ---------------------------------------------------------------------------
// validate (§5.6's five short circuiting steps)
// ---------------------------------------------------------------------------

test('validate accepts a good video and reports the probe size', async (t) => {
  const cfg = workspace(t);
  const project = projectWith(cfg, PAINTED);
  const result = await validate(project, cfg);

  assert.equal(result.ok, true, `expected ok, got stage ${result.stage}: ${result.error ?? ''}`);
  assert.equal(result.stage, 'ok');
  assert.equal(result.error, null);
  assert.ok(result.timeline !== null, 'a built session means there is a timeline');
  assert.equal(result.timeline?.durationFrames, 30);
  assert.ok(result.probeFramePngBytes > 0, `probeFramePngBytes must be > 0, got ${result.probeFramePngBytes}`);
  assert.equal(result.timeline?.scenes.length, 0, 'a video without scenes has no scenes');
});

test('validate reports stage "import" for a file that does not evaluate', async (t) => {
  const cfg = workspace(t);
  const project = projectWith(cfg, 'export default { this is not typescript ((( ');

  const result = await validate(project, cfg);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'import');
  assert.ok(result.error !== null && result.error !== '', 'a failure always carries a message');
  assert.equal(result.timeline, null, 'no session, so no timeline');
  assert.deepEqual(result.findings, []);
  assert.equal(result.probeFramePngBytes, 0);
});

test('validate reports stage "import" when the default export is not a Video', async (t) => {
  const cfg = workspace(t);
  // A module that evaluates but exports nothing usable: `loadVideo` refuses it.
  const project = projectWith(cfg, "export const notDefault = 'hello';\n");

  const result = await validate(project, cfg);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'import');
  assert.match(result.error ?? '', /default export/);
});

test('a renderFrame that throws fails at stage "probe-frame"', async (t) => {
  const cfg = workspace(t);
  const project = projectWith(cfg, THROWS);

  const result = await validate(project, cfg);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'probe-frame');
  assert.match(result.error ?? '', /boom from renderFrame/);
  // The timeline is already known, and inspect has already said `render-error` about every frame.
  assert.ok(result.timeline !== null, 'a session was built, so the timeline is reported');
  assert.ok(
    result.findings.some((finding) => finding.kind === 'render-error'),
    `expected a render-error finding, got ${JSON.stringify(result.findings)}`,
  );
  assert.equal(result.probeFramePngBytes, 0);
});

test('an all-empty video is a warning, not a failure (Svgr.empty is legal)', async (t) => {
  const cfg = workspace(t);
  const project = projectWith(cfg, EMPTY);

  const result = await validate(project, cfg);
  assert.equal(result.ok, true, `an empty frame must not fail validation: ${result.error ?? ''}`);
  assert.equal(result.stage, 'ok');
  assert.equal(result.error, null);
  assert.equal(result.probeFramePngBytes, 0, 'nothing was rasterized');
  assert.ok(
    result.findings.some((finding) => finding.kind === 'empty-frame' && finding.severity === 'warning'),
    `expected an empty-frame warning, got ${JSON.stringify(result.findings)}`,
  );
  for (const finding of result.findings) {
    assert.notEqual(finding.severity, 'error', `no finding may be fatal: ${finding.message}`);
  }
});

test('the file validate read is the normalised one, and a second load is the same video', async (t) => {
  const cfg = workspace(t);
  const project = projectWith(cfg, PAINTED);
  const result = await validate(project, cfg);
  assert.equal(result.ok, true);

  // The source that reached disk is the canonical one, which is why the dynamic import resolved at
  // all (§5.5). `validate` itself rewrote nothing.
  const onDisk = readSource(project);
  assert.ok(onDisk.includes(`from '${CANONICAL}'`), `expected the canonical specifier in:\n${onDisk}`);
  assert.ok(!onDisk.includes("from '../../src/index.ts'"), 'the shallow specifier is gone');

  // Loading again is stable: the `?v=<rev>` bust is idempotent for an unchanged file (§5.5).
  const first = await buildSession(project, cfg);
  const second = await buildSession(project, cfg);
  assert.equal(second.durationInFrames, first.durationInFrames);
  assert.equal(second.durationInFrames, 30);
});
