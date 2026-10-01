/**
 * Studio configuration (`page.md` §5.2) — `process.env` in, one frozen object out.
 *
 * There is exactly **one provider**: one `llmBaseUrl` + one `llmApiKey`, with **three models
 * configured separately** under it (`model` is the required one, `visionModel` / `imageModel` may be
 * `null`, which disables that capability with a 501 instead of failing the whole server).
 *
 * ```sh
 * cp .env.example .env      # then: node --env-file=.env src/studio/server.ts
 * ```
 *
 * `process.env` is read **once per call** and never cached at module load, so tests can build a
 * config from a synthetic environment (`loadConfig({ … })`) and the server can read the real one at
 * startup. No dotenv: `.env` reaches the process through `node --env-file`.
 *
 * `repoRoot` and `projectsRoot` are derived from `import.meta.url` (never a hard coded home
 * directory), and `mockDir` is resolved against `repoRoot`, so `LLM_MOCK_DIR=.studio/mock` works no
 * matter which directory the server was started from.
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConfigSummary } from './types.ts';

/**
 * `StudioConfig` — every knob of the Studio backend. All fields are `readonly` and the object is
 * frozen by {@link loadConfig}, so a module can not mutate shared configuration.
 */
export interface StudioConfig {
  /**
   * `STUDIO_HOST`, `127.0.0.1` by default. **Only bind the loopback interface**: the generated
   * `video.ts` is imported and executed (§8.2), and `/media` serves whatever is on disk.
   */
  readonly host: string;
  /** `STUDIO_PORT`, `8787` by default. */
  readonly port: number;
  /** `LLM_BASE_URL` — the OpenAI compatible root including `/v1`, trailing slashes trimmed. */
  readonly llmBaseUrl: string;
  /**
   * `LLM_API_KEY` — shared by all three capabilities, sent only as an `authorization` header by
   * `llm.ts`. Missing is a startup error unless `mockDir` is set (`page.md` §5.2, §8.3).
   */
  readonly llmApiKey: string;
  /** `LLM_MODEL` — text → `video.ts`. Required for the core path. */
  readonly model: string;
  /** `LLM_VISION_MODEL` — image understanding; `null` means the capability is disabled. */
  readonly visionModel: string | null;
  /** `LLM_IMAGE_MODEL` — text → image asset; `null` means the capability is disabled. */
  readonly imageModel: string | null;
  /** `LLM_IMAGE_SIZE`, `1024x1024` by default; the ⑥ panel's size dropdown may override it. */
  readonly imageSize: string;
  /**
   * `LLM_IMAGE_PROTOCOL` — how `generateImage` talks to the image model, `openai` by default:
   *
   * - `openai`: `POST <base>/images/generations` with `response_format=b64_json`, the answer is
   *   `data[0].b64_json` (or a same origin `data[0].url`).
   * - `dashscope`: Aliyun Bailian `qwen-image`, which does **not** serve `/images/generations`. It
   *   goes to `POST <base>/chat/completions` with a top level `parameters` block (`size` uses `*`,
   *   e.g. `1024*1024`) and answers with a cross origin image URL at
   *   `output.choices[0].message.content[0].image`.
   *
   * An unknown value falls back to `openai`, so a typo never disables the capability.
   */
  readonly imageProtocol: 'openai' | 'dashscope';
  /**
   * `LLM_IMAGE_URL` — an explicit image endpoint that overrides the derived one. Only meaningful
   * for `dashscope`: when `null`, the native multimodal-generation URL is derived from
   * `llmBaseUrl`'s origin (`…/api/v1/services/aigc/multimodal-generation/generation`), which is how
   * an Aliyun MaaS gateway that serves `compatible-mode/v1` for chat also serves image generation.
   * Set it when a provider's native path differs.
   */
  readonly imageUrl: string | null;
  /** `LLM_TIMEOUT_MS`, `120000` — code generation and image understanding. */
  readonly llmTimeoutMs: number;
  /** `LLM_IMAGE_TIMEOUT_MS`, `180000` — image generation is usually slower. */
  readonly imageTimeoutMs: number;
  /** `<repoRoot>/.studio/projects`, absolute. Fixed three levels below the repo so that a
   * generated `video.ts` can import `'../../../src/index.ts'` (§5.5, decision D4). */
  readonly projectsRoot: string;
  /** The `fframes-node` root, absolute — the anchor for import normalisation and `mockDir`. */
  readonly repoRoot: string;
  /**
   * `LLM_MOCK_DIR` — when set, `llm.ts` serves `video.ts` / `vision.txt` / `asset.png` from here and
   * makes no network request at all (the gate runs this way, §9). `null` when unset or empty.
   */
  readonly mockDir: string | null;
  /** `STUDIO_MAX_PROJECTS`, `50` — `createProject` refuses past this. */
  readonly maxProjects: number;
  /** `STUDIO_MAX_UPLOAD_BYTES`, 8 MiB — the ceiling for one uploaded or generated image. */
  readonly maxUploadBytes: number;
}

/** The one place a configuration problem is reported, so `server.ts` can print it and exit. */
export class ConfigError extends Error {
  readonly code: string;

  constructor(message: string, code: string = 'CONFIG_INVALID') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/**
 * The `fframes-node` root: `src/studio/config.ts` → `../..`.
 *
 * `import.meta.url` rather than `process.cwd()`, because the two disagree the moment someone runs
 * `node /abs/path/src/studio/server.ts` from elsewhere.
 */
export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where projects live, relative to {@link REPO_ROOT}: `.studio/projects`. */
export const PROJECTS_DIR_REPO_RELATIVE = '.studio/projects';

/** `process.env`-shaped input, so tests can pass a literal object. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Reads a string variable; blank counts as unset, and the result is trimmed. */
function text(env: EnvLike, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Reads an integer variable, falling back when it is missing, blank or not a usable integer.
 *
 * A typo in `.env` must not take the whole tool down at startup — the documented default is always
 * a safe value, and `/api/config` shows the effective settings.
 */
function int(env: EnvLike, name: string, fallback: number, min: number, max: number): number {
  const raw = text(env, name, '');
  if (raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

/** An optional string: `''`/blank becomes `null`, which is how a disabled capability reads. */
function optional(env: EnvLike, name: string): string | null {
  const value = text(env, name, '');
  return value === '' ? null : value;
}

/**
 * `LLM_IMAGE_PROTOCOL` → `openai` | `dashscope`, defaulting to `openai`.
 *
 * Only the exact (case insensitive) value `dashscope` selects the Aliyun Bailian native path;
 * anything else — including a typo — keeps the OpenAI `/images/generations` behaviour, so a bad
 * value can never silently disable image generation.
 */
function readImageProtocol(env: EnvLike): 'openai' | 'dashscope' {
  return text(env, 'LLM_IMAGE_PROTOCOL', 'openai').toLowerCase() === 'dashscope'
    ? 'dashscope'
    : 'openai';
}

/**
 * Normalises the provider root: whitespace trimmed and **trailing slashes removed**, so
 * `` `${cfg.llmBaseUrl}/chat/completions` `` is well formed whether the user wrote
 * `https://api.openai.com/v1` or `https://api.openai.com/v1/`.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  while (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return url;
}

/** Resolves `LLM_MOCK_DIR`: absolute paths are kept, relative ones hang off {@link REPO_ROOT}. */
export function resolveMockDir(raw: string | null, repoRoot: string = REPO_ROOT): string | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const value = raw.trim();
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

/**
 * Builds the frozen configuration from an environment.
 *
 * ```ts
 * const cfg = loadConfig();                                   // the real process env
 * const offline = loadConfig({ LLM_MOCK_DIR: '.studio/mock', … }); // a fixture run
 * ```
 *
 * Nothing here throws: a missing key or model is reported by {@link assertRuntimeConfig}, which the
 * server calls once at startup — that keeps `loadConfig` usable for partial environments.
 */
export function loadConfig(env: EnvLike = process.env): StudioConfig {
  const repoRoot = REPO_ROOT;
  const config: StudioConfig = {
    host: text(env, 'STUDIO_HOST', '127.0.0.1'),
    port: int(env, 'STUDIO_PORT', 8787, 1, 65535),
    llmBaseUrl: normalizeBaseUrl(text(env, 'LLM_BASE_URL', '')),
    llmApiKey: text(env, 'LLM_API_KEY', ''),
    model: text(env, 'LLM_MODEL', ''),
    visionModel: optional(env, 'LLM_VISION_MODEL'),
    imageModel: optional(env, 'LLM_IMAGE_MODEL'),
    imageSize: text(env, 'LLM_IMAGE_SIZE', '1024x1024'),
    imageProtocol: readImageProtocol(env),
    imageUrl: optional(env, 'LLM_IMAGE_URL'),
    llmTimeoutMs: int(env, 'LLM_TIMEOUT_MS', 120_000, 1, 3_600_000),
    imageTimeoutMs: int(env, 'LLM_IMAGE_TIMEOUT_MS', 180_000, 1, 3_600_000),
    projectsRoot: resolve(repoRoot, PROJECTS_DIR_REPO_RELATIVE),
    repoRoot,
    mockDir: resolveMockDir(optional(env, 'LLM_MOCK_DIR'), repoRoot),
    maxProjects: int(env, 'STUDIO_MAX_PROJECTS', 50, 1, 100_000),
    maxUploadBytes: int(env, 'STUDIO_MAX_UPLOAD_BYTES', 8 * 1024 * 1024, 1, 512 * 1024 * 1024),
  };
  return Object.freeze(config);
}

/**
 * The startup check (`page.md` §5.2: "缺失时非 mock 模式启动即报错，不静默").
 *
 * - Not in mock mode: `LLM_MODEL` and `LLM_API_KEY` are both required, and `LLM_BASE_URL` has to be
 *   a parseable absolute `http(s)` URL — otherwise every request would fail at the socket.
 * - In mock mode: nothing is required, `llm.ts` never opens a socket, and `visionModel` /
 *   `imageModel` stay free to be `null` so the gate can exercise the 501 path.
 *
 * Throws {@link ConfigError}; returns the config unchanged so it can be used inline.
 */
export function assertRuntimeConfig(cfg: StudioConfig): StudioConfig {
  if (cfg.mockDir !== null) {
    return cfg;
  }
  if (cfg.model === '') {
    throw new ConfigError(
      'LLM_MODEL is required: it is the model that writes video.ts (or set LLM_MOCK_DIR to run offline).',
      'MODEL_UNSET',
    );
  }
  if (cfg.llmApiKey === '') {
    throw new ConfigError(
      'LLM_API_KEY is required for LLM_BASE_URL requests (or set LLM_MOCK_DIR to run offline).',
      'API_KEY_UNSET',
    );
  }
  if (cfg.llmBaseUrl === '') {
    throw new ConfigError('LLM_BASE_URL is required: the OpenAI compatible root, e.g. https://api.openai.com/v1', 'BASE_URL_UNSET');
  }
  let parsed: URL;
  try {
    parsed = new URL(cfg.llmBaseUrl);
  } catch {
    throw new ConfigError(`LLM_BASE_URL is not a URL: "${cfg.llmBaseUrl}"`, 'BASE_URL_UNSET');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`LLM_BASE_URL must be http(s), got "${parsed.protocol}"`, 'BASE_URL_UNSET');
  }
  return cfg;
}

/**
 * The `/api/config` body (§5.8, §8.3): capability flags and the model *name*, never the key and
 * never `llmBaseUrl`. Building it here means the one place that would have to leak a credential is
 * this function, and it does not.
 */
export function capabilitySummary(cfg: StudioConfig): ConfigSummary {
  return {
    hasKey: cfg.llmApiKey !== '',
    model: cfg.model,
    vision: cfg.visionModel !== null,
    image: cfg.imageModel !== null,
    imageSize: cfg.imageSize,
    mock: cfg.mockDir !== null,
  };
}
