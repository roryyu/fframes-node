/**
 * llm.ts — one provider, three capabilities (`page.md` §5.3).
 *
 * All three go to the same OpenAI compatible root with the same key, and differ only in which model
 * they name and which endpoint they hit:
 *
 * | capability | model | endpoint | mock fixture |
 * | --- | --- | --- | --- |
 * | `generateVideoSource` | `cfg.model` | `/chat/completions` | `<mockDir>/video.ts` |
 * | `understandImage` | `cfg.visionModel` | `/chat/completions` (multimodal) | `<mockDir>/vision.txt` |
 * | `generateImage` | `cfg.imageModel` | `/images/generations` (`openai`) or the native `multimodal-generation` endpoint (`dashscope`) | `<mockDir>/asset.png` |
 *
 * Three rules the rest of the backend depends on:
 *
 * 1. **The model check comes before the mock branch.** `visionModel` / `imageModel` may be `null`, and
 *    a null model is `MODEL_UNSET` (HTTP 501, the UI disables the button) *even when mock fixtures
 *    would happily answer* — that is the §9 gate S17 path, and it has to be reachable offline.
 * 2. **Never leak the key.** It only ever appears in an `authorization` header; every message that
 *    could echo an upstream body goes through {@link redact} first.
 * 3. **One retry, only for 5xx and timeouts.** A 4xx (401 included) is never retried — retrying a
 *    wrong key just burns the budget.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { StudioConfig } from './config.ts';
import { SYSTEM_PROMPT, VISION_INSTRUCTION, buildUserPrompt } from './prompt.ts';
import type {
  AssetRef,
  CodeResult,
  ImageResult,
  LlmErrorCode,
  Usage,
  VisionResult,
} from './types.ts';

// The result shapes live in `types.ts` so `pipeline.ts` / `server.ts` can share them; re-exported
// here because §5.3 presents them as part of this module's surface.
export type { AssetRef, CodeResult, ImageResult, LlmErrorCode, Usage, VisionResult };

/** How long to wait before the single retry, and how many images we ask for. */
const RETRY_BACKOFF_MS = 500;
const MAX_ATTEMPTS = 2;
/** `max_tokens` for the vision call: one ≤120 character description (§5.3 ②). */
const VISION_MAX_TOKENS = 300;
/**
 * The negative prompt the native (`dashscope`) image call sends. Fixed rather than configurable: it
 * is the "no artefacts" boilerplate the reference integration uses, and a knob for it would only
 * invite a bad value.
 */
const DASHSCOPE_NEGATIVE_PROMPT =
  '低分辨率，低画质，画面过饱和，无细节，过度光滑，构图混乱，文字模糊，文字乱码，文字扭曲';

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * `LlmError` — every failure of this module. `server.ts` maps `code` to a status (501 for
 * `MODEL_UNSET`, 502 for an upstream problem, 504 for a timeout) and sends only `message` plus
 * `code`, never a stack.
 */
export class LlmError extends Error {
  /** The upstream HTTP status, or `null` when the request never got that far. */
  readonly status: number | null;
  readonly code: LlmErrorCode | null;

  constructor(message: string, options: { status?: number | null; code?: LlmErrorCode | null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

// ---------------------------------------------------------------------------
// image magic bytes — one table, shared with `projects.ts`
// ---------------------------------------------------------------------------

/** `png` file header: `\x89PNG\r\n\x1a\n` (§8.5). */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** `jpeg` file header: `\xFF\xD8\xFF`. */
export const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff];
/** `gif` file header: `GIF8` (both `GIF87a` and `GIF89a`). */
export const GIF_SIGNATURE: readonly number[] = [0x47, 0x49, 0x46, 0x38];

/** The image mimes Studio accepts, with the extension each one implies (§5.5, `IMAGE_EXTENSIONS`). */
const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
};

/** True when `bytes` starts with `signature`. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) {
      return false;
    }
  }
  return true;
}

/**
 * The mime a byte string actually is, from its magic bytes — `null` when it is none of png/jpeg/gif.
 *
 * Used for a generated asset (the provider does not label the bytes) and by `projects.saveAsset` to
 * prove that a declared mime is not a lie (§8.5).
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, GIF_SIGNATURE)) {
    return 'image/gif';
  }
  return null;
}

/** The extension a mime implies, `.png` / `.jpg` / `.gif`; `null` for anything else. */
export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSION[mime.trim().toLowerCase()] ?? null;
}

/** Whether the declared mime and the magic bytes agree — the anti-forgery check of §8.5. */
export function mimeMatchesMagic(mime: string, bytes: Uint8Array): boolean {
  return sniffImageMime(bytes) === mime.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// fences
// ---------------------------------------------------------------------------

/**
 * `extractCodeFence` — the completion as source code.
 *
 * A `ts`/`typescript` fence wins over any other fence, then the first fence of any language; when
 * the completion has no fence at all it *is* the source. Returns a trimmed string, so the caller
 * writes exactly what it gets.
 */
export function extractCodeFence(text: string): string {
  const trimmed = text.trim();
  const fences = /```[ \t]*([A-Za-z0-9_+.-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let first: string | null = null;
  for (let match = fences.exec(trimmed); match !== null; match = fences.exec(trimmed)) {
    const language = (match[1] ?? '').toLowerCase();
    const body = match[2] ?? '';
    if (language === 'ts' || language === 'typescript') {
      return body.trim();
    }
    if (first === null) {
      first = body;
    }
  }
  if (first !== null) {
    return first.trim();
  }
  // A single fence on one line (`\`\`\`ts export default …\`\`\``) has no newline for the scan above.
  const whole = /^```[ \t]*[A-Za-z0-9_+.-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (whole !== null) {
    return (whole[1] ?? '').trim();
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// ① text → video.ts
// ---------------------------------------------------------------------------

/**
 * `generateVideoSource` — the user's sentence (plus the assets they ticked) becomes `video.ts`.
 *
 * ```ts
 * const result = await generateVideoSource({ prompt, references }, cfg);
 * writeSource(project, result.source);   // imports normalised on the way in
 * ```
 */
export async function generateVideoSource(
  input: { prompt: string; references?: readonly AssetRef[] },
  cfg: StudioConfig,
): Promise<CodeResult> {
  if (cfg.model === '') {
    throw new LlmError('LLM_MODEL is not configured, so no video.ts can be generated', {
      code: 'MODEL_UNSET',
    });
  }
  if (cfg.mockDir !== null) {
    const raw = await readMockText(cfg, 'video.ts');
    return { source: extractCodeFence(raw), raw, model: cfg.model };
  }
  const body = await postJson(
    cfg,
    `${cfg.llmBaseUrl}/chat/completions`,
    {
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input.prompt, input.references) },
      ],
      temperature: 0.2,
      stream: false,
    },
    cfg.llmTimeoutMs,
  );
  const raw = completionText(body);
  if (raw === null || raw.trim() === '') {
    throw new LlmError('the provider returned no message content', { code: 'EMPTY_RESPONSE' });
  }
  const usage = usageOf(body);
  return {
    source: extractCodeFence(raw),
    raw,
    model: cfg.model,
    ...(usage === null ? {} : { usage }),
  };
}

// ---------------------------------------------------------------------------
// ② image → description
// ---------------------------------------------------------------------------

/**
 * `understandImage` — one image, one description, for the asset grid and for the generation prompt.
 *
 * Only the data URI of that one image is sent; nothing else from disk (§8.8).
 */
export async function understandImage(
  input: { dataUrl: string; instruction?: string },
  cfg: StudioConfig,
): Promise<VisionResult> {
  if (cfg.visionModel === null) {
    throw new LlmError('LLM_VISION_MODEL is not configured, so uploads can not be described', {
      code: 'MODEL_UNSET',
    });
  }
  if (cfg.mockDir !== null) {
    const description = (await readMockText(cfg, 'vision.txt')).trim();
    return { description, model: cfg.visionModel };
  }
  const instruction =
    input.instruction !== undefined && input.instruction.trim() !== ''
      ? input.instruction
      : VISION_INSTRUCTION;
  const body = await postJson(
    cfg,
    `${cfg.llmBaseUrl}/chat/completions`,
    {
      model: cfg.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: input.dataUrl } },
          ],
        },
      ],
      max_tokens: VISION_MAX_TOKENS,
      stream: false,
    },
    cfg.llmTimeoutMs,
  );
  const description = completionText(body);
  if (description === null || description.trim() === '') {
    throw new LlmError('the provider returned no message content', { code: 'EMPTY_RESPONSE' });
  }
  const usage = usageOf(body);
  return {
    description: description.trim(),
    model: cfg.visionModel,
    ...(usage === null ? {} : { usage }),
  };
}

// ---------------------------------------------------------------------------
// ③ text → image
// ---------------------------------------------------------------------------

/**
 * `generateImage` — a described asset, as bytes.
 *
 * Two provider protocols, chosen by `cfg.imageProtocol`:
 *
 * - `openai` (default): `POST /images/generations`, `b64_json` preferred, a same origin `url`
 *   refetched. See {@link generateImageOpenAi}.
 * - `dashscope`: Aliyun Bailian `qwen-image` through its native multimodal-generation endpoint,
 *   which answers with a cross origin image URL. See {@link generateImageDashscope}.
 *
 * Both go through {@link postJson}, so the key handling, the single retry and the error mapping are
 * shared; the `MODEL_UNSET` check and the mock branch stay here, above the split, so they behave
 * identically whichever protocol is configured.
 */
export async function generateImage(
  input: { prompt: string; size?: string },
  cfg: StudioConfig,
): Promise<ImageResult> {
  if (cfg.imageModel === null) {
    throw new LlmError('LLM_IMAGE_MODEL is not configured, so assets can not be generated', {
      code: 'MODEL_UNSET',
    });
  }
  if (cfg.mockDir !== null) {
    const bytes = await readMockBytes(cfg, 'asset.png');
    return { bytes, mime: sniffImageMime(bytes) ?? 'image/png', model: cfg.imageModel };
  }
  return cfg.imageProtocol === 'dashscope'
    ? generateImageDashscope(input, cfg, cfg.imageModel)
    : generateImageOpenAi(input, cfg, cfg.imageModel);
}

/**
 * The OpenAI `/images/generations` path.
 *
 * `b64_json` is what we ask for and what we prefer. Some providers ignore `response_format` and
 * answer with a signed URL instead; those are refetched **only when the URL is on the same origin as
 * `llmBaseUrl`**, because an attacker-chosen URL would otherwise turn the studio into an SSRF proxy
 * for the local network (§8.6, decision D12).
 */
async function generateImageOpenAi(
  input: { prompt: string; size?: string },
  cfg: StudioConfig,
  model: string,
): Promise<ImageResult> {
  const body = await postJson(
    cfg,
    `${cfg.llmBaseUrl}/images/generations`,
    {
      model,
      prompt: input.prompt,
      size: input.size ?? cfg.imageSize,
      n: 1,
      response_format: 'b64_json',
    },
    cfg.imageTimeoutMs,
  );
  const image = firstImage(body);
  if (typeof image?.b64_json === 'string' && image.b64_json.trim() !== '') {
    const bytes = decodeBase64(image.b64_json);
    return { bytes, mime: sniffImageMime(bytes) ?? 'image/png', model };
  }
  if (typeof image?.url === 'string' && image.url.trim() !== '') {
    const bytes = await fetchSameOriginImage(image.url, cfg);
    return { bytes, mime: sniffImageMime(bytes) ?? 'image/png', model };
  }
  throw new LlmError(
    'the provider returned neither b64_json nor url: it needs to support response_format=b64_json',
    { code: 'IMAGE_RESPONSE_UNSUPPORTED' },
  );
}

/**
 * The Aliyun Bailian `qwen-image` path (`LLM_IMAGE_PROTOCOL=dashscope`).
 *
 * `qwen-image` is **not** served by the OpenAI compatible `/images/generations`; it is a native
 * multimodal-generation model. The request carries `input.messages` plus a top level `parameters`
 * block — its `size` is written `1024*1024` (a `*`, not an `x`) — and the answer is a **cross
 * origin** image URL at `output.choices[0].message.content[0].image`, valid for ~24h. That URL is on
 * the provider's object storage, never on the chat origin, so it is refetched through
 * {@link fetchProviderImage}: the same-origin guard is relaxed to "not an internal address", which
 * still refuses a URL that would point the studio at the local network (§8.6, D12).
 */
async function generateImageDashscope(
  input: { prompt: string; size?: string },
  cfg: StudioConfig,
  model: string,
): Promise<ImageResult> {
  const body = await postJson(
    cfg,
    dashscopeImageUrl(cfg),
    {
      model,
      input: { messages: [{ role: 'user', content: [{ text: input.prompt }] }] },
      parameters: {
        size: toStarSize(input.size ?? cfg.imageSize),
        n: 1,
        negative_prompt: DASHSCOPE_NEGATIVE_PROMPT,
        watermark: false,
        prompt_extend: false,
      },
    },
    cfg.imageTimeoutMs,
  );
  const url = firstDashscopeImage(body);
  if (url === null) {
    throw new LlmError(
      'the provider returned no image URL at output.choices[0].message.content[0].image',
      { code: 'IMAGE_RESPONSE_UNSUPPORTED' },
    );
  }
  const bytes = await fetchProviderImage(url, cfg);
  return { bytes, mime: sniffImageMime(bytes) ?? 'image/png', model };
}

/**
 * The native multimodal-generation endpoint. `cfg.imageUrl` (`LLM_IMAGE_URL`) wins; otherwise it is
 * derived from `llmBaseUrl`'s origin, because an Aliyun MaaS gateway that serves
 * `…/compatible-mode/v1` for chat serves `…/api/v1/services/aigc/multimodal-generation/generation`
 * for image generation on the same host.
 */
function dashscopeImageUrl(cfg: StudioConfig): string {
  if (cfg.imageUrl !== null && cfg.imageUrl.trim() !== '') {
    return cfg.imageUrl.trim();
  }
  let origin: string;
  try {
    origin = new URL(cfg.llmBaseUrl).origin;
  } catch {
    throw new LlmError(
      'LLM_IMAGE_PROTOCOL=dashscope needs a valid LLM_BASE_URL (or an explicit LLM_IMAGE_URL) to derive the native image endpoint from',
      { code: 'BAD_REQUEST' },
    );
  }
  return `${origin}/api/v1/services/aigc/multimodal-generation/generation`;
}

/** `1024x1024` → `1024*1024`: the native API separates the size with `*`, not `x` (or `×`). */
function toStarSize(size: string): string {
  return size.trim().toLowerCase().replace(/[x×]/g, '*');
}


// ---------------------------------------------------------------------------
// the shared HTTP path
// ---------------------------------------------------------------------------

/** `authorization` — the only place `llmApiKey` is ever used. */
function authHeaders(cfg: StudioConfig): Record<string, string> {
  return cfg.llmApiKey === '' ? {} : { authorization: `Bearer ${cfg.llmApiKey}` };
}

/** Strips the key and anything shaped like one out of a message that may echo an upstream body. */
function redact(message: string, cfg: StudioConfig): string {
  let safe = message;
  if (cfg.llmApiKey !== '') {
    safe = safe.split(cfg.llmApiKey).join('***');
  }
  return safe.replace(/sk-[A-Za-z0-9._-]{6,}/g, '***');
}

/** A short, safe excerpt of an upstream error body. */
async function upstreamMessage(response: Response, cfg: StudioConfig): Promise<string> {
  let raw = '';
  try {
    raw = (await response.text()).slice(0, 400);
  } catch {
    raw = '';
  }
  let detail = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === 'string') {
      detail = error;
    } else if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') {
        detail = message;
      }
    }
  } catch {
    // Not JSON: the raw excerpt is the message.
  }
  return redact(`upstream responded ${response.status}: ${detail.trim()}`, cfg);
}

/** The `code` an upstream status maps to (§5.3 "通用错误映射"). */
function codeForStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) {
    return 'UNAUTHORIZED';
  }
  if (status === 429) {
    return 'RATE_LIMITED';
  }
  if (status >= 500) {
    return 'UPSTREAM';
  }
  return 'BAD_REQUEST';
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`; a manual abort rejects with `AbortError`. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * `POST` a JSON body and return the parsed answer, with **one** retry for 5xx and timeouts.
 *
 * A 4xx is returned to the caller as an `LlmError` immediately: 401 means the key is wrong and 429
 * means "slow down", and neither gets better by being asked again immediately.
 */
async function postJson(
  cfg: StudioConfig,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(cfg) };
  let lastError: LlmError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        lastError = new LlmError(`${url} timed out after ${timeoutMs}ms`, { code: 'TIMEOUT' });
        if (attempt + 1 < MAX_ATTEMPTS) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        throw lastError;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new LlmError(redact(`request to ${url} failed: ${detail}`, cfg), { code: 'NETWORK' });
    }

    if (response.status >= 500 && attempt + 1 < MAX_ATTEMPTS) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    if (!response.ok) {
      throw new LlmError(await upstreamMessage(response, cfg), {
        status: response.status,
        code: codeForStatus(response.status),
      });
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError(`${url} returned a body that is not JSON`, {
        status: response.status,
        code: 'UPSTREAM',
      });
    }
  }
  throw lastError ?? new LlmError(`${url} failed`, { code: 'UPSTREAM' });
}

/** The same-origin, size-capped refetch of a provider supplied image URL (§8.6). */
async function fetchSameOriginImage(rawUrl: string, cfg: StudioConfig): Promise<Uint8Array> {
  const unsupported = (detail: string) =>
    new LlmError(`refusing to fetch the generated image URL (${detail}); this provider needs to support response_format=b64_json`, {
      code: 'IMAGE_URL_UNSUPPORTED',
    });

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw unsupported('it is not a URL');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw unsupported(`protocol ${target.protocol} is not http(s)`);
  }
  let base: URL;
  try {
    base = new URL(cfg.llmBaseUrl);
  } catch {
    throw unsupported('LLM_BASE_URL is not a URL, so no origin can be compared');
  }
  if (target.origin !== base.origin) {
    throw unsupported(`its origin ${target.origin} is not ${base.origin}`);
  }

  let response: Response;
  try {
    response = await fetch(target.href, {
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(cfg.imageTimeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LlmError(redact(`fetching the image from ${target.origin} failed: ${detail}`, cfg), {
      code: 'NETWORK',
    });
  }
  if (!response.ok) {
    throw new LlmError(await upstreamMessage(response, cfg), {
      status: response.status,
      code: codeForStatus(response.status),
    });
  }
  return readCapped(response, cfg.maxUploadBytes);
}

/**
 * Refetch a provider supplied image URL that may be on a **public** origin.
 *
 * This is {@link fetchSameOriginImage} with the guard relaxed from "same origin" to "not internal",
 * for the native `dashscope` path: `qwen-image` answers with a signed URL on the provider's object
 * storage, which is never on the chat origin, so a same-origin rule would refuse every real image.
 * The SSRF risk the guard exists for (§8.6, D12) is a URL that points the studio at the local
 * network, so that is exactly what is still refused: a same-origin URL is allowed (which also keeps
 * the loopback test provider working), any loopback / private / link-local host is rejected, and
 * everything else on http(s) is fetched under the size cap. The key is sent **only** to a same
 * origin host, never to a third-party object store.
 */
async function fetchProviderImage(rawUrl: string, cfg: StudioConfig): Promise<Uint8Array> {
  const unsupported = (detail: string) =>
    new LlmError(`refusing to fetch the generated image URL (${detail})`, {
      code: 'IMAGE_URL_UNSUPPORTED',
    });

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw unsupported('it is not a URL');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw unsupported(`protocol ${target.protocol} is not http(s)`);
  }
  let sameOrigin = false;
  try {
    sameOrigin = target.origin === new URL(cfg.llmBaseUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin && isPrivateHost(target.hostname)) {
    throw unsupported(`its host ${target.hostname} is an internal address`);
  }

  let response: Response;
  try {
    response = await fetch(target.href, {
      headers: sameOrigin ? authHeaders(cfg) : {},
      signal: AbortSignal.timeout(cfg.imageTimeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LlmError(redact(`fetching the image from ${target.origin} failed: ${detail}`, cfg), {
      code: 'NETWORK',
    });
  }
  if (!response.ok) {
    throw new LlmError(await upstreamMessage(response, cfg), {
      status: response.status,
      code: codeForStatus(response.status),
    });
  }
  return readCapped(response, cfg.maxUploadBytes);
}

/**
 * Whether a URL host is an internal address: `localhost` and the `.local` / `.internal` names, the
 * IPv4 loopback / private / link-local / this-network ranges, and the IPv6 loopback / unspecified /
 * unique-local / link-local prefixes. A provider's public object storage host is none of these, so
 * this is the invariant that keeps a provider supplied URL from aiming the studio at the LAN.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === '' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  // IPv6: `::` / `::1` (loopback, unspecified), `fc00::/7` (unique local), `fe80::/10` (link local).
  if (
    host === '::' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  ) {
    return true;
  }
  // IPv4: 0/8, 10/8, 127/8 (loopback), 169.254/16 (link local), 172.16/12, 192.168/16 (private).
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
  }
  return false;
}

/** Reads a body but gives up as soon as it passes `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const stream = response.body;
  if (stream === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new LlmError(`the generated image is larger than ${limit} bytes`, {
        code: 'IMAGE_TOO_LARGE',
      });
    }
    return bytes;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const part = value ?? new Uint8Array(0);
    total += part.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new LlmError(`the generated image is larger than ${limit} bytes`, {
        code: 'IMAGE_TOO_LARGE',
      });
    }
    chunks.push(part);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// response shapes
// ---------------------------------------------------------------------------

/** `choices[0].message.content`, as a string; `null` when the shape is not what we asked for. */
function completionText(body: unknown): string | null {
  const choices = (body as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const content = (choices[0] as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  // Some gateways send content as a list of parts.
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      const text = (part as { text?: unknown } | null)?.text;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
    return parts.join('');
  }
  return null;
}

/** `data[0]` of an `/images/generations` answer. */
function firstImage(
  body: unknown,
): { b64_json?: unknown; url?: unknown } | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const first = data[0];
  if (typeof first !== 'object' || first === null) {
    return null;
  }
  return first as { b64_json?: unknown; url?: unknown };
}

/**
 * The image URL out of a native `dashscope` multimodal-generation answer.
 *
 * The canonical shape is `output.choices[0].message.content[0].image`. Tolerated variations, so a
 * gateway that answers slightly differently still works: the `output` wrapper absent (the choices at
 * the top level), `content` a bare string, or a part that carries the URL as `text` instead of
 * `image`. Returns `null` when no URL is found, which the caller turns into `IMAGE_RESPONSE_UNSUPPORTED`.
 */
function firstDashscopeImage(body: unknown): string | null {
  const root = (body as { output?: unknown } | null)?.output ?? body;
  const choices = (root as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const content = (choices[0] as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content === 'string') {
    return content.trim() === '' ? null : content.trim();
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    const image = (part as { image?: unknown } | null)?.image;
    if (typeof image === 'string' && image.trim() !== '') {
      return image.trim();
    }
  }
  for (const part of content) {
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && /^https?:\/\//i.test(text.trim())) {
      return text.trim();
    }
  }
  return null;
}

/** `usage` in the OpenAI shape; `null` when the provider reported none. */
function usageOf(body: unknown): Usage | null {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }
  const source = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  const promptTokens = numberOrUndefined(source.prompt_tokens);
  const completionTokens = numberOrUndefined(source.completion_tokens);
  const totalTokens = numberOrUndefined(source.total_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return null;
  }
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Strict-ish base64: a provider that sends something else is an error, not an empty image. */
function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new LlmError('b64_json is not base64', { code: 'EMPTY_RESPONSE' });
  }
  return new Uint8Array(Buffer.from(compact, 'base64'));
}

// ---------------------------------------------------------------------------
// mock mode (§9)
// ---------------------------------------------------------------------------

function mockPath(cfg: StudioConfig, file: string): string {
  return join(cfg.mockDir ?? '', file);
}

async function readMockText(cfg: StudioConfig, file: string): Promise<string> {
  const path = mockPath(cfg, file);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LlmError(`LLM_MOCK_DIR=${path} has no readable ${file} (${detail})`, {
      code: 'MOCK_FIXTURE_MISSING',
    });
  }
}

async function readMockBytes(cfg: StudioConfig, file: string): Promise<Uint8Array> {
  const path = mockPath(cfg, file);
  try {
    const bytes = await readFile(path);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LlmError(`LLM_MOCK_DIR=${path} has no readable ${file} (${detail})`, {
      code: 'MOCK_FIXTURE_MISSING',
    });
  }
}
