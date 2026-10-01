/**
 * projects.ts — `.studio/projects/<id>/`: the generated file, the dynamic load, the asset library
 * (`page.md` §5.5).
 *
 * A project is a fixed three levels under the repo root:
 *
 * ```text
 * fframes-node/.studio/projects/p-1730000000000-a1b2c3/
 *   video.ts      the generated file; imports '../../..' + src/index.ts
 *   media/        uploaded and generated images, read by ctx.getImage at render time
 *   assets.json   AssetInfo[] — the manifest listAssets() reconciles against the directory
 *   out/          render artefacts (written by jobs.ts)
 * ```
 *
 * The fixed depth is not cosmetic: it is what makes the canonical import specifier
 * `'../../../src/index.ts'` resolve to the real `src/index.ts` (decision D4).
 *
 * Three things here are load bearing beyond "read and write files":
 *
 * - **Import normalisation.** Models write `'../../src/index.ts'`, `'./src/index.ts'` or `'fframes'`;
 *   {@link normalizeImports} rewrites anything aimed at the fframes public API to the canonical
 *   specifier, idempotently, so a second pass changes nothing.
 * - **Cache busting.** ESM caches by URL, so re-importing a rewritten `video.ts` would hand back the
 *   previous module. `loadProject` appends `?v=<rev>`, a per-project counter that `writeSource`
 *   increments; Node then treats it as a different module and evaluates the new code. Assets do
 *   *not* need this — they are read from disk by `ctx.getImage` at render time (§5.5).
 * - **Containment.** Every id and every asset name goes through a `[A-Za-z0-9._-]` whitelist plus a
 *   `resolve()` prefix check, so neither `../../etc` nor `media/../../..` can name a file outside the
 *   project (§8.4). Uploaded bytes have to match the mime they claim: `\x89PNG\r\n\x1a\n` /
 *   `\xFF\xD8\xFF` / `GIF8`, the one table that lives in `llm.ts` and is used here through
 *   {@link mimeMatchesMagic}, so a declared mime can never disagree with the file behind it.
 *
 * `loadVideo` / `mediaDirFor` come from `'../cli/main.ts'` on purpose: `src/index.ts` deliberately
 * does not re-export it (the module graph deadlock documented at the end of that file), and README's
 * "Using it as a library" sanctions this import path (decision D8).
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRenderSession, UsageError } from '../index.ts';
import type { Video } from '../index.ts';
import { mediaDirFor } from '../cli/main.ts';

import { loadConfig } from './config.ts';
import type { StudioConfig } from './config.ts';
import { extensionForMime, mimeMatchesMagic } from './llm.ts';
import type {
  AssetInfo,
  AssetRef,
  AssetSource,
  LoadedProject,
  Project,
  ProjectErrorCode,
} from './types.ts';
import { PROJECT_ASSETS_FILE, PROJECT_MEDIA_DIR, PROJECT_VIDEO_FILE } from './types.ts';

// §5.5 presents these as part of this module's surface; the single definitions live in `types.ts`.
export type { AssetInfo, Project };

/** Ids and asset names: `[A-Za-z0-9._-]`, no separators, no control characters (§8.4, §8.5). */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** How deep a project sits below the repo root, which is what fixes the canonical specifier. */
const CANONICAL_SPECIFIER = '../../../src/index.ts';

/** `from '<spec>'` — covers `import … from`, `import type … from` and `export … from`. */
const FROM_SPECIFIER = /(\bfrom\s*)(['"])([^'"\n]+)\2/g;

/** A side effect import, `import '<spec>';` — no `from`, so the pattern above misses it. */
const BARE_IMPORT_SPECIFIER = /(\bimport\s+)(['"])([^'"\n]+)\2/g;

/** Directory `jobs.ts` writes render artefacts into. */
export const PROJECT_OUT_DIR = 'out';

/** Per-project write counter, keyed by absolute `videoPath`; the ESM cache key for the project. */
const revisions = new Map<string, number>();

/** A storage problem, with the `code` `server.ts` maps to a status (§5.8, the table in `types.ts`). */
export class ProjectError extends Error {
  readonly code: ProjectErrorCode;

  constructor(message: string, code: ProjectErrorCode) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// ids and paths
// ---------------------------------------------------------------------------

/**
 * `p-<epoch ms>-<6 hex>`, which sorts newest first and passes the whitelist.
 *
 * The 6 hex suffix is a fixed-width lowercase hex number, so a descending *string* sort of ids is a
 * descending numeric sort of the suffix. Two projects created inside the same millisecond would
 * otherwise tie on the ms prefix and be ordered by a random suffix — which breaks `listProjects`'
 * "newest id first" guarantee (a test creating two projects back-to-back is flaky about half the
 * time). The suffix is therefore only random for the *first* id of a given millisecond; every
 * further id in that same millisecond increments it, so creation order is always recoverable from
 * the id alone. The random start keeps ids unique across processes/restarts, and is masked to half
 * the range to leave ample headroom for the increments.
 */
let lastIdMs = 0;
let lastIdSuffix = 0;
function newProjectId(): string {
  const now = Date.now();
  if (now === lastIdMs) {
    lastIdSuffix += 1;
  } else {
    lastIdMs = now;
    lastIdSuffix = randomBytes(3).readUIntBE(0, 3) % 0x800000;
  }
  return `p-${now}-${lastIdSuffix.toString(16).padStart(6, '0')}`;
}

/** Whether `name` may be used as a directory name or a file name. */
function isSafeName(name: string): boolean {
  if (name.length === 0 || name.length > 128 || !SAFE_NAME.test(name)) {
    return false;
  }
  // Reject `.` and any dot-dot sequence (`..`, `..evil`, `a..b`) as defence in depth: a legitimate
  // project id (`p-<ts>-<rand6>`) or asset name never needs `..`, and refusing it outright means a
  // name that merely shares the root as a string prefix can never reach the containment check.
  return name !== '.' && !name.includes('..');
}

/** Throws unless `candidate` resolves to `root` itself or something under it. */
function assertInside(root: string, candidate: string, code: ProjectErrorCode = 'INVALID_PROJECT_ID'): void {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ProjectError(`"${candidate}" escapes ${base}`, code);
  }
}

function projectOf(projectsRoot: string, id: string): Project {
  const dir = resolve(projectsRoot, id);
  return {
    id,
    dir,
    videoPath: join(dir, PROJECT_VIDEO_FILE),
    mediaDir: join(dir, PROJECT_MEDIA_DIR),
    assetsPath: join(dir, PROJECT_ASSETS_FILE),
  };
}

// ---------------------------------------------------------------------------
// import normalisation (§5.5)
// ---------------------------------------------------------------------------

/**
 * Whether a specifier is aimed at the fframes public API.
 *
 * Covers the shapes models actually emit: a relative path to `src/index.ts` from any depth (including
 * an absolute one), `./src/index.ts`, the package name `fframes`, and `fframes/index.ts`.
 */
function isFframesSpecifier(specifier: string): boolean {
  const value = specifier.trim();
  if (value === CANONICAL_SPECIFIER) {
    return false; // Already canonical: leave it alone, which is what makes this idempotent.
  }
  if (value === 'fframes' || value === 'fframes/index.ts' || value === 'fframes/src/index.ts') {
    return true;
  }
  return value.endsWith('src/index.ts');
}

/**
 * `normalizeImports` — every import aimed at the public API becomes `'../../../src/index.ts'`.
 *
 * ```ts
 * normalizeImports("import { svgr } from '../../src/index.ts';");
 * // import { svgr } from '../../../src/index.ts';
 * ```
 *
 * Idempotent: running it on its own output is a no-op, and unrelated specifiers (a sibling helper,
 * `node:path`) are never touched. `cfg` is accepted for call sites that already hold one; the
 * canonical depth is fixed by the layout (decision D4) rather than by configuration.
 */
export function normalizeImports(source: string, cfg?: StudioConfig): string {
  // `cfg` is part of the call signature, but the canonical specifier is a constant: the project
  // layout fixes the depth (decision D4), so no configuration can change it.
  const rewrite = (match: string, prefix: string, quote: string, specifier: string): string =>
    isFframesSpecifier(specifier) ? `${prefix}${quote}${CANONICAL_SPECIFIER}${quote}` : match;
  return source
    .replace(FROM_SPECIFIER, (_match, prefix: string, quote: string, specifier: string) =>
      rewrite(_match, prefix, quote, specifier),
    )
    .replace(BARE_IMPORT_SPECIFIER, (_match, prefix: string, quote: string, specifier: string) =>
      rewrite(_match, prefix, quote, specifier),
    );
}

// ---------------------------------------------------------------------------
// the project lifecycle
// ---------------------------------------------------------------------------

/**
 * `createProject` — a new project directory, refused once `cfg.maxProjects` exist (§5.5).
 *
 * Creates `media/` and `out/` plus an empty manifest, so every later write is a plain file write
 * with no mkdir dance and `/api/assets` has something to read.
 */
export function createProject(cfg: StudioConfig): Project {
  const existing = listProjects(cfg).length;
  if (existing >= cfg.maxProjects) {
    throw new ProjectError(
      `there are already ${existing} projects (max ${cfg.maxProjects}); delete some under .studio/projects first`,
      'PROJECT_LIMIT',
    );
  }
  mkdirSync(cfg.projectsRoot, { recursive: true });
  const project = projectOf(cfg.projectsRoot, newProjectId());
  assertInside(cfg.projectsRoot, project.dir);
  mkdirSync(project.mediaDir, { recursive: true });
  mkdirSync(join(project.dir, PROJECT_OUT_DIR), { recursive: true });
  writeFileSync(project.assetsPath, '[]\n', 'utf8');
  return project;
}

/** Every project directory, newest first. */
export function listProjects(cfg: StudioConfig): Project[] {
  const root = cfg.projectsRoot;
  if (!existsSync(root)) {
    return [];
  }
  const projects: Project[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && isSafeName(entry.name)) {
      projects.push(projectOf(root, entry.name));
    }
  }
  // Ids start with the epoch millis, so a descending id order is a descending creation order.
  return projects.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
}

/**
 * `resolveProject` — an id to a project, or a refusal.
 *
 * `INVALID_PROJECT_ID` for anything that is not a `[A-Za-z0-9._-]` name or that resolves outside
 * `projectsRoot` (`../`, `..`, absolute paths, encoded separators); `PROJECT_NOT_FOUND` when the
 * whitelist passed but no such directory exists.
 */
export function resolveProject(cfg: StudioConfig, id: string): Project {
  if (!isSafeName(id)) {
    throw new ProjectError(`"${id}" is not a project id`, 'INVALID_PROJECT_ID');
  }
  const project = projectOf(cfg.projectsRoot, id);
  assertInside(cfg.projectsRoot, project.dir);
  if (!existsSync(project.dir) || !statSync(project.dir).isDirectory()) {
    throw new ProjectError(`project "${id}" does not exist`, 'PROJECT_NOT_FOUND');
  }
  return project;
}

/** The current cache-busting revision of a project; `0` until the first write. */
export function sourceRevision(p: Project): number {
  return revisions.get(p.videoPath) ?? 0;
}

function bumpRevision(p: Project): number {
  const next = sourceRevision(p) + 1;
  revisions.set(p.videoPath, next);
  return next;
}

/** Writes `video.ts` with its imports normalised, and invalidates the module cache for it. */
export function writeSource(p: Project, source: string): void {
  const normalized = normalizeImports(source);
  mkdirSync(dirname(p.videoPath), { recursive: true });
  // Write then rename: a concurrent `loadProject` can not observe a half written file.
  const temporary = `${p.videoPath}.tmp`;
  writeFileSync(temporary, normalized, 'utf8');
  renameSync(temporary, p.videoPath);
  bumpRevision(p);
}

/** Reads `video.ts` exactly as it was written. */
export function readSource(p: Project): string {
  return readFileSync(p.videoPath, 'utf8');
}

/**
 * The structural shape `loadVideo` checks, mirrored here because the cache key needs a bare import
 * (`?v=<rev>`, which `loadVideo`'s `pathToFileURL(...).href` can not carry). Exported so
 * `pipeline.ts` shares this one copy instead of a second that can drift (§5.1 "禁止重写").
 */
export function looksLikeVideo(value: unknown): value is Video {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Video>;
  return (
    typeof candidate.fps === 'number' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.duration === 'function' &&
    typeof candidate.audio === 'function' &&
    typeof candidate.renderFrame === 'function'
  );
}

/** Accepts a `Video` or a factory returning one, the two shapes `loadVideo` accepts. */
export async function videoFromDefault(exported: unknown, videoPath: string): Promise<Video> {
  if (looksLikeVideo(exported)) {
    return exported;
  }
  if (typeof exported === 'function') {
    const produced: unknown = await (exported as () => Video | Promise<Video>)();
    if (looksLikeVideo(produced)) {
      return produced;
    }
    throw new UsageError(`the factory in "${videoPath}" returned ${typeof produced}, expected a Video`);
  }
  if (exported === undefined) {
    throw new UsageError(`"${videoPath}" has no default export`);
  }
  throw new UsageError(`the default export of "${videoPath}" is ${typeof exported}, expected a Video or a factory`);
}

/**
 * `loadProject` — import the project and build a render session for it.
 *
 * The import URL carries `?v=<rev>`, which is the whole point: ESM keys its registry by URL, so the
 * query makes every write a distinct module and `loadProject` really does re-evaluate the new code.
 * The registry then grows by one entry per write — acceptable for a local tool, bounded by
 * `maxProjects`, and the reason §11 tells long running servers to restart (§5.5, decision D5).
 *
 * `mediaDirFor(videoPath)` is what puts `media/` into `ctx.getImage`, so a generated `video.ts` can
 * reference an uploaded asset with no extra wiring (§5.1, decision D10).
 */
export async function loadProject(p: Project, cfg: StudioConfig): Promise<LoadedProject> {
  assertInside(cfg.repoRoot, p.videoPath);
  if (!existsSync(p.videoPath)) {
    throw new UsageError(`"${p.videoPath}" does not exist: generate or write a video.ts first`);
  }
  const href = `${pathToFileURL(p.videoPath).href}?v=${sourceRevision(p)}`;
  const imported: unknown = await import(href);
  const video = await videoFromDefault((imported as { default?: unknown }).default, p.videoPath);
  const mediaDir = mediaDirFor(p.videoPath);
  const session = createRenderSession(video, {
    fps: video.fps,
    width: video.width,
    height: video.height,
    mediaDir,
  });
  return { video, session };
}

// ---------------------------------------------------------------------------
// the asset library: media/ + assets.json (§5.5, §8.5)
// ---------------------------------------------------------------------------

/** What `saveAsset` takes; `AssetInfo` is what it returns. */
export interface AssetSaveInput {
  /** The client supplied name, sanitised (see {@link sanitizeBaseName}). */
  readonly suggestedName: string;
  readonly bytes: Uint8Array;
  /** The declared mime; it has to agree with the magic bytes. */
  readonly mime: string;
  readonly source: AssetSource;
  readonly description?: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * `resolveAssetPath` — the absolute path of `media/<name>`, after the whitelist and a containment
 * check. The `/media` handler serves whatever this returns and nothing else.
 */
export function resolveAssetPath(p: Project, name: string): string {
  if (name !== name.replace(/\\/g, '/') || !isSafeName(name)) {
    throw new ProjectError(`"${name}" is not an asset name`, 'INVALID_ASSET_NAME');
  }
  const target = resolve(p.mediaDir, name);
  assertInside(p.mediaDir, target, 'INVALID_ASSET_NAME');
  return target;
}

/**
 * The file name stem for an upload: `[A-Za-z0-9._-]` only, no leading or trailing dot.
 *
 * A path separator or a `.` / `..` name is **refused** rather than stripped — a client that sends
 * `../../x` is not naming a file, and the gate wants a 4xx for it (§8.5). A name that is merely
 * illegal (`???`, a space, `münchen.png`) is sanitised, and its trailing image extension is dropped
 * because the mime decides the extension. An empty result falls back to `asset-<timestamp>`.
 */
function sanitizeBaseName(suggested: string, now: number): string {
  if (suggested !== suggested.replace(/\\/g, '/') || suggested.includes('/')) {
    throw new ProjectError(
      `"${suggested}" is not an asset name: no path separators`,
      'INVALID_ASSET_NAME',
    );
  }
  if (suggested === '.' || suggested === '..') {
    throw new ProjectError(`"${suggested}" is not an asset name`, 'INVALID_ASSET_NAME');
  }
  const cleaned = suggested.replace(/[^A-Za-z0-9._-]/g, '');
  const base = cleaned
    .replace(/\.(png|jpe?g|gif|webp|bmp|avif|tiff?)$/i, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return base === '' ? `asset-${now}` : base;
}

/** A free name in `media/`: `logo.png`, then `logo-1.png`, `logo-2.png`, … */
function uniqueAssetName(p: Project, base: string, extension: string): string {
  let candidate = `${base}${extension}`;
  let counter = 0;
  while (existsSync(resolve(p.mediaDir, candidate))) {
    counter += 1;
    candidate = `${base}-${counter}${extension}`;
  }
  return candidate;
}

/** `ffprobe` for the pixel size; `null` when it can not be read, which is not an error (§5.5). */
function probeImageSize(filePath: string): { width: number; height: number } | null {
  try {
    const stdout = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        filePath,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed: unknown = JSON.parse(stdout);
    const streams = (parsed as { streams?: unknown }).streams;
    if (!Array.isArray(streams) || streams.length === 0) {
      return null;
    }
    const stream = streams[0] as { width?: unknown; height?: unknown };
    const width = typeof stream.width === 'number' ? stream.width : Number(stream.width);
    const height = typeof stream.height === 'number' ? stream.height : Number(stream.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

function isAssetInfo(value: unknown): value is AssetInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<AssetInfo>;
  return (
    typeof entry.name === 'string' &&
    typeof entry.mime === 'string' &&
    typeof entry.bytes === 'number' &&
    (entry.source === 'upload' || entry.source === 'generated')
  );
}

/** The manifest as stored; a missing or corrupt file is an empty library, never an exception. */
function readManifest(p: Project): AssetInfo[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(p.assetsPath, 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isAssetInfo);
  } catch {
    return [];
  }
}

function writeManifest(p: Project, entries: readonly AssetInfo[]): void {
  mkdirSync(dirname(p.assetsPath), { recursive: true });
  writeFileSync(p.assetsPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/**
 * `saveAsset` — one image into `media/`, with its metadata in `assets.json`.
 *
 * The checks, in order: the name is sanitised (a separator is refused), the mime has to be one of
 * png/jpeg/gif, the size has to fit `maxUploadBytes`, and the magic bytes have to agree with the
 * declared mime — that last one is what stops "rename anything to logo.png" (§8.5). A duplicate name
 * gets a `-1` / `-2` suffix rather than overwriting. `cfg` defaults to the process environment, so
 * `POST /api/upload` can pass the server's own config and a script can call this alone.
 */
export function saveAsset(
  p: Project,
  input: AssetSaveInput,
  cfg: StudioConfig = loadConfig(),
): AssetInfo {
  const now = Date.now();
  const extension = extensionForMime(input.mime);
  if (extension === null) {
    throw new ProjectError(
      `${input.mime} is not a supported image type; use image/png, image/jpeg or image/gif`,
      'UNSUPPORTED_IMAGE_TYPE',
    );
  }
  const base = sanitizeBaseName(input.suggestedName, now);
  const bytes = input.bytes;
  if (bytes.byteLength > cfg.maxUploadBytes) {
    throw new ProjectError(
      `the asset is ${bytes.byteLength} bytes, over the ${cfg.maxUploadBytes} byte limit`,
      'ASSET_TOO_LARGE',
    );
  }
  if (!mimeMatchesMagic(input.mime, bytes)) {
    throw new ProjectError(
      `the bytes do not start with a ${input.mime} file header`,
      'ASSET_MAGIC_MISMATCH',
    );
  }

  const name = uniqueAssetName(p, base, extension);
  const target = resolveAssetPath(p, name);
  mkdirSync(p.mediaDir, { recursive: true });
  writeFileSync(target, bytes);

  const probed = probeImageSize(target);
  const asset: AssetInfo = {
    name,
    mime: input.mime.trim().toLowerCase(),
    bytes: bytes.byteLength,
    source: input.source,
    description: input.description ?? null,
    width: input.width ?? probed?.width ?? null,
    height: input.height ?? probed?.height ?? null,
    createdAt: now,
  };
  const manifest = readManifest(p).filter((entry) => entry.name !== asset.name);
  manifest.push(asset);
  writeManifest(p, manifest);
  return asset;
}

/**
 * `listAssets` — the manifest, reconciled against the directory: an entry whose file is gone is
 * dropped, because the files are the truth (§5.5).
 */
export function listAssets(p: Project): AssetInfo[] {
  const assets: AssetInfo[] = [];
  for (const entry of readManifest(p)) {
    if (!isSafeName(entry.name)) {
      continue;
    }
    try {
      if (existsSync(resolveAssetPath(p, entry.name))) {
        assets.push(entry);
      }
    } catch {
      continue;
    }
  }
  return assets.sort((left, right) => left.createdAt - right.createdAt);
}

/** Removes one asset: the file and its manifest entry. */
export function deleteAsset(p: Project, name: string): void {
  const target = resolveAssetPath(p, name);
  const manifest = readManifest(p);
  const known = manifest.some((entry) => entry.name === name);
  if (!existsSync(target) && !known) {
    throw new ProjectError(`asset "${name}" does not exist`, 'ASSET_NOT_FOUND');
  }
  if (existsSync(target)) {
    try {
      unlinkSync(target);
    } catch {
      throw new ProjectError(`asset "${name}" could not be removed`, 'ASSET_NOT_FOUND');
    }
  }
  writeManifest(p, manifest.filter((entry) => entry.name !== name));
}

/**
 * `getAssetRefs` — the ticked assets as the generation prompt needs them: name, description and (when
 * known) size. Unknown or unsafe names are skipped rather than guessed, so the prompt can never
 * mention a file the project does not have (§5.4).
 */
export function getAssetRefs(p: Project, names: readonly string[]): AssetRef[] {
  const byName = new Map(listAssets(p).map((asset) => [asset.name, asset]));
  const refs: AssetRef[] = [];
  for (const name of names) {
    if (!isSafeName(name)) {
      continue;
    }
    const asset = byName.get(name);
    if (asset === undefined) {
      continue;
    }
    const sized = asset.width !== null && asset.height !== null;
    refs.push({
      name: asset.name,
      description: asset.description ?? '',
      ...(sized ? { width: asset.width as number, height: asset.height as number } : {}),
    });
  }
  return refs;
}
