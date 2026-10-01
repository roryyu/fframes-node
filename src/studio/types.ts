/**
 * Studio — the cross module shapes (`page.md` §5.2–§5.7, §6).
 *
 * Everything the backend modules agree on lives here so that `config.ts`, `llm.ts`, `prompt.ts`,
 * `projects.ts`, `pipeline.ts`, `jobs.ts` and `server.ts` can be read one at a time: `types.ts`
 * imports nothing but types, which keeps the module graph a DAG
 * (`types` → `config` → `prompt` → `llm` → `projects` → `pipeline` → `jobs` → `server`).
 *
 * Two rules from `page.md` §3 apply to this file:
 *
 * - Only erasable syntax: interfaces, type aliases and unions. No `enum` (a literal `kind` in a
 *   union is the substitute), no `namespace`, no constructor parameter properties, no decorators —
 *   `tsconfig.json` sets `erasableSyntaxOnly`, and Node ≥24 strips the types at run time.
 * - Every import is a *type* import (`import type`), so loading this file never pulls the library
 *   in at run time; `types.ts` is the only Studio module with no runtime dependency at all.
 */

import type {
  InspectFinding,
  RenderReport,
  RenderSession,
  TimelineReport,
  Video,
} from '../index.ts';

/**
 * Library types used by the Studio shapes below. Re-exported so `pipeline.ts` / `jobs.ts` /
 * `server.ts` can pull the whole Studio surface from one place; the ones the interfaces below name
 * are imported as well, because `export … from` binds no local name.
 */
export type {
  InspectFinding,
  InspectOptions,
  InspectResult,
  RenderOptions,
  RenderReport,
  RenderSession,
  Scene,
  Severity,
  TimelineReport,
  Video,
} from '../index.ts';

/** How an asset in `media/` got there (§5.5). */
export type AssetSource = 'upload' | 'generated';

/**
 * `AssetInfo` — one entry of the asset library (§5.5, §6).
 *
 * It is the JSON shape of `/api/upload`, `/api/asset/gen` and `/api/assets`, and the row the
 * material grid renders; `width`/`height` are `null` when the probe failed, which is not an error.
 */
export interface AssetInfo {
  /** File name inside `media/`, always `[A-Za-z0-9._-]` plus the extension derived from `mime`. */
  readonly name: string;
  /** The *declared* mime, which `saveAsset` proved against the file's magic bytes. */
  readonly mime: string;
  /** Size on disk in bytes. */
  readonly bytes: number;
  readonly source: AssetSource;
  /** The vision model description, or `null` when nothing described it (no vision model, or the
   * upload came without `understand`). */
  readonly description: string | null;
  /** Pixel width from `ffprobe`, `null` when it could not be probed. */
  readonly width: number | null;
  /** Pixel height from `ffprobe`, `null` when it could not be probed. */
  readonly height: number | null;
  /** `Date.now()` at save time. */
  readonly createdAt: number;
}

/**
 * `AssetRef` — an asset as the generation prompt sees it (§5.3, §5.4 `buildUserPrompt`).
 *
 * The model only needs the name it has to pass to `ctx.getImage`, a description and, when known,
 * the dimensions so it can lay the image out without distorting it.
 */
export interface AssetRef {
  /** `logo.png` — exactly what `ctx.getImage('<name>')` takes. */
  readonly name: string;
  /** What the picture shows; `''` when nothing described it. */
  readonly description: string;
  readonly width?: number;
  readonly height?: number;
}

/** `Project` — one `.studio/projects/<id>/` directory (§5.5). */
export interface Project {
  /** `p-<ms>-<6 random chars>`, restricted to `[A-Za-z0-9._-]`. */
  readonly id: string;
  /** The project directory. */
  readonly dir: string;
  /** `<dir>/video.ts` — the only file the ESM cache busting applies to. */
  readonly videoPath: string;
  /** `<dir>/media` — what `mediaDirFor` hands to the session, so `ctx.getImage` resolves. */
  readonly mediaDir: string;
  /** `<dir>/assets.json` — the `AssetInfo[]` manifest. */
  readonly assetsPath: string;
}

/** What `loadProject` returns: the module's `Video` and a session bound to its `media/`. */
export interface LoadedProject {
  readonly video: Video;
  readonly session: RenderSession;
}

/** The three file names inside a project directory. */
export const PROJECT_VIDEO_FILE = 'video.ts';
export const PROJECT_MEDIA_DIR = 'media';
export const PROJECT_ASSETS_FILE = 'assets.json';

// ---------------------------------------------------------------------------
// llm.ts (§5.3)
// ---------------------------------------------------------------------------

/**
 * Token accounting as the OpenAI compatible shape reports it. Every field is optional because
 * providers disagree: some omit `usage` entirely, and mock mode has none at all.
 */
export interface Usage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

/** `CodeResult` — the generated `video.ts`. */
export interface CodeResult {
  /** `raw` with the code fence removed: this is what gets written to `video.ts`. */
  readonly source: string;
  /** The completion as it came back, fence included (the ⑤ console shows it). */
  readonly raw: string;
  readonly model: string;
  readonly usage?: Usage;
}

/** `VisionResult` — one image turned into one description. */
export interface VisionResult {
  readonly description: string;
  readonly model: string;
  readonly usage?: Usage;
}

/** `ImageResult` — the bytes of a generated asset, ready for `saveAsset`. */
export interface ImageResult {
  readonly bytes: Uint8Array;
  /** Derived from the magic bytes, not from what the provider claims. */
  readonly mime: string;
  readonly model: string;
}

/**
 * `LlmErrorCode` — the machine readable half of an `LlmError`; `server.ts` maps it to a status
 * (`MODEL_UNSET` → 501, everything upstream → 502) and to the `code` field of the JSON body.
 *
 * | code | meaning | HTTP |
 * | --- | --- | --- |
 * | `MODEL_UNSET` | the capability's model is not configured | 501 |
 * | `BAD_REQUEST` | our own payload was rejected (4xx that is not auth/rate) | 400 |
 * | `UNAUTHORIZED` | 401/403 from the provider — the key is wrong | 502 |
 * | `RATE_LIMITED` | 429 | 502 |
 * | `UPSTREAM` | another non 2xx | 502 |
 * | `TIMEOUT` | `AbortSignal.timeout` fired (retried once) | 504 |
 * | `NETWORK` | the socket failed | 502 |
 * | `EMPTY_RESPONSE` | 2xx without `choices`/`message.content`/`data` | 502 |
 * | `IMAGE_URL_UNSUPPORTED` | the provider only returned a cross origin `url` (SSRF guard) | 502 |
 * | `IMAGE_RESPONSE_UNSUPPORTED` | neither `b64_json` nor a usable `url` | 502 |
 * | `IMAGE_TOO_LARGE` | the refetched image passed `maxUploadBytes` | 413 |
 * | `MOCK_FIXTURE_MISSING` | `LLM_MOCK_DIR` is set but the fixture file is absent | 500 |
 */
export type LlmErrorCode =
  | 'MODEL_UNSET'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'EMPTY_RESPONSE'
  | 'IMAGE_URL_UNSUPPORTED'
  | 'IMAGE_RESPONSE_UNSUPPORTED'
  | 'IMAGE_TOO_LARGE'
  | 'MOCK_FIXTURE_MISSING';

/**
 * `ProjectErrorCode` — the same idea for `projects.ts`, for the requests that never reach an LLM.
 *
 * | code | meaning | HTTP |
 * | --- | --- | --- |
 * | `INVALID_PROJECT_ID` | the id is not `[A-Za-z0-9._-]` or escapes `projectsRoot` | 400 |
 * | `PROJECT_NOT_FOUND` | no such project directory | 404 |
 * | `PROJECT_LIMIT` | `maxProjects` reached | 400 |
 * | `INVALID_ASSET_NAME` | the name escapes `media/` or is not a legal file name | 400 |
 * | `UNSUPPORTED_IMAGE_TYPE` | the mime is not png/jpeg/gif | 415 |
 * | `ASSET_MAGIC_MISMATCH` | the magic bytes contradict the declared mime | 400 |
 * | `ASSET_TOO_LARGE` | `maxUploadBytes` exceeded | 413 |
 * | `ASSET_NOT_FOUND` | no such asset in the manifest | 404 |
 */
export type ProjectErrorCode =
  | 'INVALID_PROJECT_ID'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_LIMIT'
  | 'INVALID_ASSET_NAME'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'ASSET_MAGIC_MISMATCH'
  | 'ASSET_TOO_LARGE'
  | 'ASSET_NOT_FOUND';

// ---------------------------------------------------------------------------
// prompt.ts / server.ts request bodies (§5.8, §6)
// ---------------------------------------------------------------------------

/** `POST /api/generate` body (§5.8). */
export interface GenerateRequest {
  readonly prompt: string;
  /** Optional: the project is created lazily when this is absent (§7.2). */
  readonly projectId?: string;
  /** Asset names ticked as "reference material"; their descriptions ride along (§5.4). */
  readonly references?: readonly string[];
}

/** `GET /api/config` response — capability flags only, never the key (§5.8, §8.3). */
export interface ConfigSummary {
  /** Whether `LLM_API_KEY` is set. The key itself is never serialised. */
  readonly hasKey: boolean;
  /** The configured `LLM_MODEL`, so the ① panel can show what writes the code. */
  readonly model: string;
  /** `LLM_VISION_MODEL !== null` → `/api/upload{understand:true}` is available. */
  readonly vision: boolean;
  /** `LLM_IMAGE_MODEL !== null` → `/api/asset/gen` is available. */
  readonly image: boolean;
  readonly imageSize: string;
  /** Whether `llm.ts` is serving fixtures instead of talking to the provider. */
  readonly mock: boolean;
}

/** Every failed API response body: a message, and a code when there is one to match on (§5.8). */
export interface ApiErrorBody {
  readonly error: string;
  readonly code?: string;
}

/** A ⑤ console entry. */
export interface ConsoleEntry {
  /** Milliseconds since the epoch, for the timestamp the panel prints. */
  readonly at: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
}

/** One chip of the ① panel, fed by `prompt.ts`'s `EXAMPLES` (§7.1). */
export interface ExampleChip {
  readonly name: string;
  readonly prompt: string;
}

// ---------------------------------------------------------------------------
// pipeline.ts (§5.6)
// ---------------------------------------------------------------------------

/** Where a validation stopped; `ok` means it got all the way through. */
export type ValidationStage = 'import' | 'session' | 'probe-frame' | 'inspect' | 'ok';

/**
 * `ValidationResult` — the answer of `/api/generate` and `/api/validate`, and the whole content of
 * the ③ validation box (§5.6, §6).
 *
 * The steps short circuit: the first one that fails sets `stage` and leaves the rest empty, so
 * `ok === false` always comes with a stage and a message instead of an empty frame.
 */
export interface ValidationResult {
  readonly ok: boolean;
  readonly stage: ValidationStage;
  /** The `import` / session / rasterize error, already trimmed to a message (never a stack). */
  readonly error: string | null;
  /** Present as soon as the session exists, i.e. from `stage: 'inspect'` on. */
  readonly timeline: TimelineReport | null;
  /** Missing fonts, missing media, empty frames. Warnings, never fatal on their own. */
  readonly findings: readonly InspectFinding[];
  /** Size of the probe frame PNG; `0` means `renderFramePng` produced nothing usable. */
  readonly probeFramePngBytes: number;
}

// ---------------------------------------------------------------------------
// jobs.ts (§5.7)
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

/** Frames rendered so far and how many the job has to render. */
export interface JobProgress {
  readonly done: number;
  readonly total: number;
}

/** `RenderJob` — one entry of the single slot render queue. */
export interface RenderJob {
  readonly id: string;
  readonly projectId: string;
  readonly status: JobStatus;
  readonly progress: JobProgress;
  /** Set when `status === 'done'`. */
  readonly report?: RenderReport;
  /** Set when `status === 'error'`; a message, never a stack. */
  readonly error?: string;
  /** `/media/<projectId>/out/<jobId>.mp4`, set on success. */
  readonly outputUrl?: string;
}

/**
 * `JobEvent` — what the SSE stream sends as its `event:` name plus its `data:` payload
 * (§5.7, §6). A union of literals rather than an enum, per §3.1.
 */
export type JobEvent =
  | { readonly type: 'progress'; readonly done: number; readonly total: number }
  | { readonly type: 'done'; readonly report: RenderReport; readonly outputUrl: string }
  | { readonly type: 'error'; readonly message: string };
