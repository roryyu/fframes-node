#!/usr/bin/env node
/**
 * server.ts — the studio's `node:http` front door (`page.md` §5.8).
 *
 * ```sh
 * cp .env.example .env     # LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 * npm run studio           # → http://127.0.0.1:8787
 * ```
 *
 * `node:http` plus a hand written `URL` + `switch` router: no Express, no router dependency, no
 * build step — the same "zero new runtime dependencies" red line the rest of `fframes-node` keeps
 * (§3.3). The front end is three files in `public/`, served as they are.
 *
 * The layering is the one of §2: this file only speaks HTTP. It parses, routes, serves bytes, and
 * turns an exception into `{ error, code? }` with a sensible status. Every decision it makes is a
 * *call* into the module that owns it —
 *
 * | route | calls |
 * | --- | --- |
 * | `/api/generate` | `llm.generateVideoSource` → `projects.writeSource` → `pipeline.validate` |
 * | `/api/upload`, `/api/asset/gen` | `llm.understandImage` / `llm.generateImage` → `projects.saveAsset` |
 * | `/api/validate`, `/api/timeline`, `/api/inspect`, `/api/frame`, `/api/svg` | `pipeline.*` |
 * | `/api/render*` | `jobs.submitRender` + `jobs.subscribe` (SSE) → `pipeline.render` |
 * | `/media/*` | `projects.resolveProject` + `fs` (with `Range`) |
 *
 * ## The four rules this file exists to enforce
 *
 * 1. **Never leak a credential.** `/api/config` answers from `capabilitySummary`, which is built
 *    from `hasKey: boolean` and the model *names* — the key and `llmBaseUrl` are not in the type, so
 *    they cannot be serialised by accident (§8.3).
 * 2. **Never leak a stack.** Every error response is `{ error: <message>, code? }`; a thrown
 *    `Error`'s `stack` never reaches the socket (§5.8).
 * 3. **Never escape a directory.** `projectId`, asset names and the `/media` sub-path are whitelisted
 *    *and* re-checked with `resolve()` + prefix, so `../`, an absolute path or an encoded separator
 *    is a 4xx and not a file read (§8.4).
 * 4. **Only the loopback.** `STUDIO_HOST` defaults to `127.0.0.1` and the startup log says so,
 *    because evaluating a generated `video.ts` *is* code execution (§8.2).
 *
 * ## Deviations from the letter of §5.8, and why
 *
 * - **Upload body limit.** §5.8 says `readJson`'s cap is relaxed to `maxUploadBytes` on the upload
 *   endpoints. Taken literally that endpoint can never succeed: base64 inflates by 4/3, so an image
 *   of exactly `maxUploadBytes` needs `⌈4·max/3⌉` characters of JSON. The cap here is therefore
 *   `⌈4·max/3⌉ + 64 KiB` (JSON envelope slack), and §8.5's two stage check is implemented on top of
 *   it: a cheap length screen on the base64 *string* before decoding, then the exact byte check.
 * - **`UNSUPPORTED_IMAGE_TYPE` answers 415**, per the table in `types.ts` (`ProjectErrorCode`), rather
 *   than 400.
 * - **Too many event streams answers 503** with `code: 'TOO_MANY_STREAMS'`. §8.7 requires a cap on
 *   concurrent SSE connections; the status list in §5.8 covers *API* failures, and this is a capacity
 *   condition rather than a malformed request.
 */

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TimeSpecResolveError, UsageError } from '../index.ts';

import { assertRuntimeConfig, capabilitySummary, loadConfig } from './config.ts';
import type { StudioConfig } from './config.ts';
import { getJob, submitRender, subscribe } from './jobs.ts';
import type { JobDependencies } from './jobs.ts';
import { LlmError, generateImage, generateVideoSource, understandImage } from './llm.ts';
import { buildSession, framePng, frameSvg, inspect, timeline, validate } from './pipeline.ts';
import { EXAMPLES } from './prompt.ts';
import {
  ProjectError,
  createProject,
  deleteAsset,
  getAssetRefs,
  listAssets,
  listProjects,
  readSource,
  resolveProject,
  saveAsset,
  writeSource,
} from './projects.ts';
import type {
  ApiErrorBody,
  AssetInfo,
  JobEvent,
  LlmErrorCode,
  ProjectErrorCode,
  Project,
  ValidationResult,
} from './types.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** `src/studio/public`, three files, served as they are on disk (§7). */
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'public');

/** `readJson`'s cap for every endpoint that is not an upload (§5.8). */
const JSON_BODY_LIMIT = 1024 * 1024;

/** Concurrent `text/event-stream` responses; §8.7 asks for a bound so a leak can not pile up. */
const MAX_SSE_STREAMS = 8;

/** A comment frame every this many ms, so an idle render's stream is not reaped by a proxy. */
const SSE_HEARTBEAT_MS = 15_000;

/** File names: `[A-Za-z0-9._-]`, no separator, no control character (§8.4, §8.5). */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** What `/media/<id>/<group>/<name>` may serve: §5.8 lists exactly these. */
const MEDIA_GROUPS: Readonly<Record<string, ReadonlySet<string>>> = {
  out: new Set(['.mp4', '.wav']),
  media: new Set(['.png', '.jpg', '.jpeg', '.gif']),
};

/** `content-type` per extension. Anything unknown is served as a download. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// errors → statuses (§5.8, §8)
// ---------------------------------------------------------------------------

/** A failure with the HTTP status it should become. */
class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** The `LlmError` → status table (`types.ts` documents it; §5.3 "通用错误映射"). */
const LLM_STATUS: Readonly<Record<LlmErrorCode, number>> = {
  MODEL_UNSET: 501,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 502,
  RATE_LIMITED: 502,
  UPSTREAM: 502,
  TIMEOUT: 504,
  NETWORK: 502,
  EMPTY_RESPONSE: 502,
  IMAGE_URL_UNSUPPORTED: 502,
  IMAGE_RESPONSE_UNSUPPORTED: 502,
  IMAGE_TOO_LARGE: 413,
  MOCK_FIXTURE_MISSING: 500,
};

/** The `ProjectError` → status table (same source). */
const PROJECT_STATUS: Readonly<Record<ProjectErrorCode, number>> = {
  INVALID_PROJECT_ID: 400,
  PROJECT_NOT_FOUND: 404,
  PROJECT_LIMIT: 400,
  INVALID_ASSET_NAME: 400,
  UNSUPPORTED_IMAGE_TYPE: 415,
  ASSET_MAGIC_MISMATCH: 400,
  ASSET_TOO_LARGE: 413,
  ASSET_NOT_FOUND: 404,
};

/** A message, never a stack: this string is what the browser sees (§5.8). */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === '' ? 'unknown error' : message;
}

/**
 * Maps any thrown value to a status and a body.
 *
 * The three typed errors carry their own meaning: `LlmError` knows whether the *capability* was
 * unconfigured (501) or the provider failed (502), `ProjectError` knows which containment or asset
 * rule was broken, and a `TimeSpecResolveError` is a bad query string (400) — the same 400 the CLI
 * would exit with. Anything unrecognised is a 500 with its message and nothing else.
 */
function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof LlmError) {
    const code = error.code;
    const status = code === undefined || code === null ? 502 : (LLM_STATUS[code] ?? 502);
    return new HttpError(status, messageOf(error), code ?? undefined);
  }
  if (error instanceof ProjectError) {
    return new HttpError(PROJECT_STATUS[error.code] ?? 400, messageOf(error), error.code);
  }
  if (error instanceof TimeSpecResolveError) {
    return new HttpError(400, messageOf(error), 'BAD_TIME_SPEC');
  }
  if (error instanceof UsageError) {
    return new HttpError(400, messageOf(error), 'BAD_USAGE');
  }
  return new HttpError(500, messageOf(error), 'INTERNAL');
}

// ---------------------------------------------------------------------------
// response helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  sendBuffer(res, status, Buffer.from(body, 'utf8'), type);
}

function sendError(res: ServerResponse, error: unknown): void {
  const mapped = toHttpError(error);
  if (res.headersSent) {
    // The SSE or media path already started a body; there is nothing safe to add to it.
    res.end();
    return;
  }
  const body: ApiErrorBody = {
    error: mapped.message,
    ...(mapped.code === undefined ? {} : { code: mapped.code }),
  };
  sendJson(res, mapped.status, body);
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

/**
 * `readJson` — the body as an object, refusing to buffer more than `limit` bytes.
 *
 * The limit is checked *while* reading rather than after, so a 500 MB body is abandoned at 1 MB
 * instead of being held in memory first. The rest of the stream is drained so the client sees the
 * 413 rather than a reset socket.
 */
async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) {
      req.resume();
      throw new HttpError(413, `the request body is larger than the ${limit} byte limit`, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'the request body is not JSON', 'BAD_JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'the request body must be a JSON object', 'BAD_JSON');
  }
  return parsed as Record<string, unknown>;
}

/** The upload endpoints' cap: `⌈4·max/3⌉` of base64 plus room for the JSON envelope. */
function uploadBodyLimit(cfg: StudioConfig): number {
  return Math.ceil((cfg.maxUploadBytes * 4) / 3) + 64 * 1024;
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function reqString(body: Record<string, unknown>, key: string): string {
  const value = optString(body, key);
  if (value === undefined) {
    throw new HttpError(400, `"${key}" is required and must be a non-empty string`, 'BAD_REQUEST');
  }
  return value;
}

function optNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function optBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  return body[key] === true ? true : body[key] === false ? false : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** The `projectId` a query or body must carry, or a 400. */
function requiredProjectId(cfg: StudioConfig, value: string | null | undefined): Project {
  if (value === null || value === undefined || value.trim() === '') {
    throw new HttpError(400, 'projectId is required', 'BAD_REQUEST');
  }
  return resolveProject(cfg, value);
}

/**
 * The lazy project of §7.2: an absent `projectId` means "make me one", so the very first upload or
 * generation already has a home and the response hands the id back.
 */
function projectOrCreate(cfg: StudioConfig, value: string | null | undefined): Project {
  if (value === null || value === undefined || value.trim() === '') {
    return createProject(cfg);
  }
  return resolveProject(cfg, value);
}

// ---------------------------------------------------------------------------
// static files and /media
// ---------------------------------------------------------------------------

/** Throws unless `candidate` is `root` itself or something under it (§8.4). */
function assertInside(root: string, candidate: string): void {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new HttpError(400, `"${candidate}" escapes ${base}`, 'PATH_ESCAPE');
  }
}

/** `GET /` and `GET /static/*` — the three files of `public/`, as they are. */
function serveStatic(res: ServerResponse, segments: readonly string[]): void {
  const name = segments.length === 0 ? 'index.html' : segments.join('/');
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw new HttpError(400, `"${name}" is not a file name`, 'BAD_REQUEST');
  }
  const filePath = resolve(PUBLIC_DIR, name);
  assertInside(PUBLIC_DIR, filePath);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new HttpError(
      404,
      `the studio front end is not installed: src/studio/public/${name} is missing`,
      'NOT_FOUND',
    );
  }
  const body = createReadStream(filePath);
  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': statSync(filePath).size,
    // The page is edited while the server runs; a cached app.js is a confusing bug report.
    'cache-control': 'no-cache',
  });
  body.pipe(res);
}

/**
 * `GET /media/<id>/<group>/<name>` — render artefacts and asset thumbnails, with `Range`.
 *
 * `Range` is not a nicety here: `<video controls>` in the ④ panel can not seek without a 206, and a
 * 5 second mp4 is exactly the kind of file a browser wants to seek in. The response therefore always
 * advertises `accept-ranges: bytes`, answers a satisfiable range with 206 + `content-range`, and
 * answers an unsatisfiable one with 416 + a `content-range` of `bytes *` + `/<size>` (whole file).
 *
 * The path is checked three times over: `id` goes through `resolveProject` (whitelist + `resolve()`
 * prefix), the name goes through the `[A-Za-z0-9._-]` whitelist, and the joined path is prefix
 * checked against the group directory. `out/` and `media/` are the only two groups (§5.8).
 */
function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: StudioConfig,
  segments: readonly string[],
): void {
  const id = segments[0];
  const group = segments[1];
  const name = segments[2];
  if (id === undefined || group === undefined || name === undefined || segments.length !== 3) {
    throw new HttpError(404, 'not found: expected /media/<projectId>/out/<file> or /media/<projectId>/media/<file>', 'NOT_FOUND');
  }
  // `Object.hasOwn`, not `MEDIA_GROUPS[group] !== undefined`: `group` comes from the URL, so a value
  // like `toString`/`constructor`/`valueOf` would otherwise resolve off `Object.prototype` to a
  // truthy function and the `.has(...)` below would throw a `TypeError` — a 500 leaking an internal
  // message where §5.8 wants a plain 404 (§8.4). Only own keys are servable groups.
  const allowed = Object.hasOwn(MEDIA_GROUPS, group) ? MEDIA_GROUPS[group] : undefined;
  if (allowed === undefined || !allowed.has(extname(name).toLowerCase())) {
    throw new HttpError(404, `not found: ${group}/${name} is not servable`, 'NOT_FOUND');
  }
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new HttpError(400, `"${name}" is not a file name`, 'BAD_REQUEST');
  }

  const project = resolveProject(cfg, id);
  const base = group === 'out' ? join(project.dir, 'out') : project.mediaDir;
  const filePath = resolve(base, name);
  assertInside(base, filePath);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new HttpError(404, `not found: ${name} is not in this project`, 'NOT_FOUND');
  }

  const size = statSync(filePath).size;
  const type = contentTypeFor(filePath);
  const rangeHeader = req.headers.range;
  res.setHeader('accept-ranges', 'bytes');

  if (rangeHeader === undefined) {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'no-store' });
    createReadStream(filePath).pipe(res);
    return;
  }

  const range = parseRange(rangeHeader, size);
  if (range === null) {
    res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-type': CONTENT_TYPES['.json'] });
    res.end(JSON.stringify({ error: `the range "${rangeHeader}" is not satisfiable`, code: 'BAD_RANGE' }));
    return;
  }
  res.writeHead(206, {
    'content-type': type,
    'content-length': range.end - range.start + 1,
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
    'cache-control': 'no-store',
  });
  createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
}

/** `bytes=<start>-<end>`, `bytes=<start>-` and `bytes=-<suffix>`; `null` when unsatisfiable. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || size === 0) {
    return null;
  }
  const rawStart = (match[1] ?? '').trim();
  const rawEnd = (match[2] ?? '').trim();
  if (rawStart === '' && rawEnd === '') {
    return null;
  }
  let start: number;
  let end: number;
  if (rawStart === '') {
    // A suffix range: the last N bytes.
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }
    end = Math.min(end, size - 1);
  }
  if (start > end || start >= size || start < 0) {
    return null;
  }
  return { start, end };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** Open `text/event-stream` responses, for the §8.7 cap. */
let openStreams = 0;

/** The `data:` payload of each event type (§6: `progress` → `{done,total}`, etc.). */
function ssePayload(event: JobEvent): string {
  switch (event.type) {
    case 'progress':
      return JSON.stringify({ done: event.done, total: event.total });
    case 'done':
      return JSON.stringify({ report: event.report, outputUrl: event.outputUrl });
    case 'error':
      return JSON.stringify({ message: event.message });
  }
}

/**
 * `GET /api/render/<jobId>/stream` — the SSE transport for one job.
 *
 * The stream is closed as soon as a terminal event (`done` / `error`) has been written: a finished
 * job has nothing left to say, and holding the socket would be the leak §8.7 asks to avoid. A client
 * that reconnects (the browser's `EventSource` may, and `retry:` makes it polite about it) gets the
 * ending replayed immediately, because `subscribe` replays a finished job's terminal event.
 *
 * The unsubscribe and the heartbeat timer are created *after* `subscribe` returns, because
 * `subscribe(…, { replayCurrent: true })` calls the listener synchronously when the job is already
 * finished — hence the nullable locals and the `closed` latch.
 */
function streamJob(res: ServerResponse, jobId: string): void {
  if (getJob(jobId) === undefined) {
    throw new HttpError(404, `no render job "${jobId}"; it may have been dropped by a restart`, 'NOT_FOUND');
  }
  if (openStreams >= MAX_SSE_STREAMS) {
    throw new HttpError(503, `too many render streams open (max ${MAX_SSE_STREAMS})`, 'TOO_MANY_STREAMS');
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx buffers a stream into uselessness without this.
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  openStreams += 1;

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const finish = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }
    if (unsubscribe !== null) {
      unsubscribe();
    }
    openStreams -= 1;
    res.end();
  };

  unsubscribe = subscribe(
    jobId,
    (event) => {
      if (closed) {
        return;
      }
      res.write(`event: ${event.type}\ndata: ${ssePayload(event)}\n\n`);
      if (event.type === 'done' || event.type === 'error') {
        finish();
      }
    },
    { replayCurrent: true },
  );
  heartbeat = setInterval(() => {
    if (!closed) {
      res.write(': keep-alive\n\n');
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();
  // `res` 'close' rather than `req` 'close': a GET request's readable side ends as soon as its headers
  // have been read, while the response's 'close' is what actually means "the client is gone (or we
  // just finished)". The `closed` latch makes the normal `res.end()` path idempotent.
  res.on('close', finish);
}

// ---------------------------------------------------------------------------
// the API
// ---------------------------------------------------------------------------

/** `GET /api/config` — capability flags, the model name, and the example chips. Never the key. */
function apiConfig(cfg: StudioConfig): Record<string, unknown> {
  return { ...capabilitySummary(cfg), examples: EXAMPLES };
}

/** `POST /api/generate` — the core path: prompt (+ reference material) → `video.ts` → validation. */
async function apiGenerate(cfg: StudioConfig, req: IncomingMessage): Promise<unknown> {
  const body = await readJson(req, JSON_BODY_LIMIT);
  const prompt = reqString(body, 'prompt');
  const project = projectOrCreate(cfg, optString(body, 'projectId'));
  // Only names the project really has reach the prompt: `getAssetRefs` drops unknown ones, so the
  // model can not be told to reference a file that does not exist (§5.4).
  const references = getAssetRefs(project, stringList(body['references']));
  const generated = await generateVideoSource({ prompt, references }, cfg);
  writeSource(project, generated.source);
  const validation: ValidationResult = await validate(project, cfg);
  return { projectId: project.id, source: readSource(project), validation };
}

/** `POST /api/upload` — a JSON base64 image into `media/`, optionally described by the vision model. */
async function apiUpload(cfg: StudioConfig, req: IncomingMessage): Promise<unknown> {
  const body = await readJson(req, uploadBodyLimit(cfg));
  const name = reqString(body, 'name');
  const mime = reqString(body, 'mime');
  const dataBase64 = reqString(body, 'dataBase64');
  const understand = optBoolean(body, 'understand') === true;

  // §8.5, step 1: a length screen on the base64 *string*, before anything is decoded. base64 costs
  // 4 characters per 3 bytes, so the screen is at the inflated size, not at `maxUploadBytes`.
  const compact = dataBase64.replace(/\s+/g, '');
  if (compact.length > Math.ceil((cfg.maxUploadBytes * 4) / 3) + 4) {
    throw new HttpError(413, `the upload is over the ${cfg.maxUploadBytes} byte limit`, 'ASSET_TOO_LARGE');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new HttpError(400, 'dataBase64 is not base64', 'BAD_REQUEST');
  }

  // §5.8 + gate S17: asking for an understanding the studio can not perform is a 501, and it is
  // decided *before* a project is created so a refused upload does not leave a directory behind.
  if (understand && cfg.visionModel === null) {
    throw new HttpError(501, 'vision model not configured', 'MODEL_UNSET');
  }

  const project = projectOrCreate(cfg, optString(body, 'projectId'));
  let description: string | undefined;
  let warning: string | null = null;
  if (understand) {
    try {
      const vision = await understandImage({ dataUrl: `data:${mime};base64,${compact}` }, cfg);
      description = vision.description;
    } catch (error) {
      // §7.2: an *upstream* understanding failure does not block the upload; the asset lands with a
      // null description and the ⑤ console reports why. Only the unconfigured case above is fatal.
      warning = messageOf(error);
    }
  }

  // §8.5, step 2 + 3: the exact byte count and the magic bytes are `saveAsset`'s job.
  const asset: AssetInfo = saveAsset(
    project,
    {
      suggestedName: name,
      bytes: new Uint8Array(Buffer.from(compact, 'base64')),
      mime,
      source: 'upload',
      ...(description === undefined ? {} : { description }),
    },
    cfg,
  );
  return { projectId: project.id, asset, ...(warning === null ? {} : { warning }) };
}

/** `POST /api/asset/gen` — a described asset, out of the image model, into `media/`. */
async function apiAssetGen(cfg: StudioConfig, req: IncomingMessage): Promise<unknown> {
  const body = await readJson(req, JSON_BODY_LIMIT);
  const prompt = reqString(body, 'prompt');
  const size = optString(body, 'size');
  const name = optString(body, 'name');
  // 501 before the project exists, same reasoning as `/api/upload`.
  if (cfg.imageModel === null) {
    throw new HttpError(501, 'image model not configured', 'MODEL_UNSET');
  }
  const project = projectOrCreate(cfg, optString(body, 'projectId'));
  const image = await generateImage({ prompt, ...(size === undefined ? {} : { size }) }, cfg);
  const asset: AssetInfo = saveAsset(
    project,
    {
      suggestedName: name ?? `generated-${Date.now()}`,
      bytes: image.bytes,
      // The mime comes from the bytes, not from the provider's claim (`llm.sniffImageMime`).
      mime: image.mime,
      source: 'generated',
    },
    cfg,
  );
  return { projectId: project.id, asset };
}

/** `GET /api/assets` — the manifest, reconciled against the directory. */
function apiAssets(cfg: StudioConfig, url: URL): unknown {
  const project = requiredProjectId(cfg, url.searchParams.get('projectId'));
  return { projectId: project.id, assets: listAssets(project) };
}

/** `DELETE /api/assets/<name>` — the file and its manifest entry. */
function apiDeleteAsset(cfg: StudioConfig, url: URL, name: string): unknown {
  const project = requiredProjectId(cfg, url.searchParams.get('projectId'));
  deleteAsset(project, name);
  return { ok: true };
}

/** `POST /api/validate` — re-check hand edited code: overwrite `video.ts`, then validate. */
async function apiValidate(cfg: StudioConfig, req: IncomingMessage): Promise<unknown> {
  const body = await readJson(req, JSON_BODY_LIMIT);
  const project = requiredProjectId(cfg, optString(body, 'projectId'));
  writeSource(project, reqString(body, 'source'));
  const validation: ValidationResult = await validate(project, cfg);
  return { projectId: project.id, validation };
}

/** `GET /api/timeline` — `TimelineReport` for the ③ panel. */
async function apiTimeline(cfg: StudioConfig, url: URL): Promise<unknown> {
  const project = requiredProjectId(cfg, url.searchParams.get('projectId'));
  const session = await buildSession(project, cfg);
  return timeline(session);
}

/** `GET /api/inspect?range=` — `InspectResult`; a bad spec is a 400, like the CLI. */
async function apiInspect(cfg: StudioConfig, url: URL): Promise<unknown> {
  const project = requiredProjectId(cfg, url.searchParams.get('projectId'));
  const session = await buildSession(project, cfg);
  return inspect(session, url.searchParams.get('range') ?? undefined);
}

/** `GET /api/frame?spec=` — one PNG, straight into `<img src>`. */
async function apiFrame(cfg: StudioConfig, url: URL): Promise<{ png: Buffer }> {
  const project = requiredProjectId(cfg, url.searchParams.get('projectId'));
  const session = await buildSession(project, cfg);
  return { png: framePng(session, url.searchParams.get('spec') ?? '0') };
}

/** `GET /api/svg?spec=` — the same frame as markup, for the "read the SVG" affordance. */
async function apiSvg(cfg: StudioConfig, url: URL): Promise<{ svg: string }> {
  const project = requiredProjectId(cfg, url.searchParams.get('projectId'));
  const session = await buildSession(project, cfg);
  return { svg: frameSvg(session, url.searchParams.get('spec') ?? '0') };
}

/** `POST /api/render` — 202 with a job id; the work happens in the queue and reports over SSE. */
async function apiRender(cfg: StudioConfig, deps: JobDependencies, req: IncomingMessage): Promise<unknown> {
  const body = await readJson(req, JSON_BODY_LIMIT);
  const project = requiredProjectId(cfg, optString(body, 'projectId'));
  const range = optString(body, 'range');
  const draft = optBoolean(body, 'draft');
  const scale = optNumber(body, 'scale');
  const crf = optNumber(body, 'crf');
  const preset = optString(body, 'preset');
  const job = submitRender(deps, {
    projectId: project.id,
    ...(range === undefined ? {} : { range }),
    ...(draft === undefined ? {} : { draft }),
    ...(scale === undefined ? {} : { scale }),
    ...(crf === undefined ? {} : { crf }),
    ...(preset === undefined ? {} : { preset }),
  });
  return { jobId: job.id };
}

/** `GET /api/projects` — the ⑥ panel's project switcher. */
function apiProjects(cfg: StudioConfig): unknown {
  return {
    projects: listProjects(cfg).map((project) => {
      const stat = statSync(project.dir, { throwIfNoEntry: false });
      return {
        id: project.id,
        createdAt: stat === undefined ? 0 : Math.round(stat.birthtimeMs),
        hasVideo: existsSync(project.videoPath),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

/** `URL.pathname` split, percent-decoded; a malformed escape is a 400 rather than a 500. */
function segmentsOf(pathname: string): string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'the path is not valid percent-encoding', 'BAD_PATH');
  }
  return decoded.split('/').filter((segment) => segment !== '');
}

/** Routes one request. The `switch` is the whole router — §5.8, "手写极简路由（URL + switch）". */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: StudioConfig,
  deps: JobDependencies,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${cfg.host}:${cfg.port}`}`);
  const method = req.method ?? 'GET';
  const segments = segmentsOf(url.pathname);
  const head = segments[0];

  if (head === 'media' && method === 'GET') {
    serveMedia(req, res, cfg, segments.slice(1));
    return;
  }
  if (head !== 'api') {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, `${method} is not allowed here`, 'METHOD_NOT_ALLOWED');
    }
    if (head === undefined || head === 'static') {
      serveStatic(res, segments.slice(1));
      return;
    }
    throw new HttpError(404, `not found: ${url.pathname}`, 'NOT_FOUND');
  }

  const route = segments.slice(1);
  switch (`${method} /${route.join('/')}`) {
    case 'GET /config':
      sendJson(res, 200, apiConfig(cfg));
      return;
    case 'POST /generate':
      sendJson(res, 200, await apiGenerate(cfg, req));
      return;
    case 'POST /upload':
      sendJson(res, 200, await apiUpload(cfg, req));
      return;
    case 'POST /asset/gen':
      sendJson(res, 200, await apiAssetGen(cfg, req));
      return;
    case 'GET /assets':
      sendJson(res, 200, apiAssets(cfg, url));
      return;
    case 'POST /validate':
      sendJson(res, 200, await apiValidate(cfg, req));
      return;
    case 'GET /timeline':
      sendJson(res, 200, await apiTimeline(cfg, url));
      return;
    case 'GET /inspect':
      sendJson(res, 200, await apiInspect(cfg, url));
      return;
    case 'POST /render':
      sendJson(res, 202, await apiRender(cfg, deps, req));
      return;
    case 'GET /projects':
      sendJson(res, 200, apiProjects(cfg));
      return;
    default:
      break;
  }

  // The routes with a parameter, which a flat `switch` on a joined string can not express.
  if (method === 'DELETE' && route[0] === 'assets' && route.length === 2) {
    sendJson(res, 200, apiDeleteAsset(cfg, url, route[1] as string));
    return;
  }
  if (method === 'GET' && route[0] === 'frame' && route.length === 1) {
    const { png } = await apiFrame(cfg, url);
    sendBuffer(res, 200, png, 'image/png');
    return;
  }
  if (method === 'GET' && route[0] === 'svg' && route.length === 1) {
    const { svg } = await apiSvg(cfg, url);
    sendText(res, 200, svg, 'text/plain; charset=utf-8');
    return;
  }
  if (method === 'GET' && route[0] === 'render' && route.length === 2) {
    const job = getJob(route[1] as string);
    if (job === undefined) {
      throw new HttpError(404, `no render job "${route[1]}"`, 'NOT_FOUND');
    }
    sendJson(res, 200, job);
    return;
  }
  if (method === 'GET' && route[0] === 'render' && route.length === 3 && route[2] === 'stream') {
    streamJob(res, route[1] as string);
    return;
  }
  throw new HttpError(404, `not found: ${method} ${url.pathname}`, 'NOT_FOUND');
}

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

/**
 * `isEntryPoint` — whether *this* file is what the process was started with.
 *
 * Node 24 has no `import.meta.main`, so this compares `process.argv[1]` with this module's own path,
 * the same approach `src/cli/main.ts` uses. `realpathSync` is applied to both sides because
 * `argv[1]` is whatever the caller typed, and a symlinked or `/tmp`-shaped path on macOS would
 * otherwise not compare equal — which would silently make `npm run studio` a no-op.
 */
export function isEntryPoint(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (entry === undefined) {
    return false;
  }
  const self = fileURLToPath(import.meta.url);
  if (resolve(entry) === resolve(self)) {
    return true;
  }
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

/**
 * `startServer` — bind the loopback and serve. Returns the `Server`, so a caller (or a test) can
 * close it.
 *
 * `assertRuntimeConfig` runs first and **throws** rather than starting half-configured: without
 * `LLM_MODEL` or `LLM_API_KEY` every generation would fail with a confusing 502, and a silent
 * server is worse than a loud one (§5.2). The entry point below turns that throw into `exit 1`; a
 * programmatic caller sees the `ConfigError` itself. `LLM_MOCK_DIR` is the documented way to start
 * without a key, and it is what the gate uses.
 */
export function startServer(cfg: StudioConfig = loadConfig()): Server {
  const config = assertRuntimeConfig(cfg);
  const deps: JobDependencies = { cfg: config };
  const server = createServer((req, res) => {
    void handle(req, res, config, deps).catch((error: unknown) => sendError(res, error));
  });
  server.on('error', (error: Error) => {
    console.error(`[studio] server error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`[studio] fframes-node Studio → http://${config.host}:${config.port}`);
    if (config.mockDir !== null) {
      console.log(`[studio] LLM mock mode: serving fixtures from ${config.mockDir} (no network calls)`);
    }
    if (config.visionModel === null) {
      console.log('[studio] LLM_VISION_MODEL is not set: uploads can not be described (/api/upload{understand:true} → 501)');
    }
    if (config.imageModel === null) {
      console.log('[studio] LLM_IMAGE_MODEL is not set: asset generation is disabled (/api/asset/gen → 501)');
    }
    console.log('[studio] loopback only — this server executes the video.ts it is given, do not expose it');
  });
  return server;
}

if (isEntryPoint()) {
  try {
    startServer();
  } catch (error) {
    console.error(`[studio] ${messageOf(error)}`);
    process.exit(1);
  }
}
