/**
 * `llm.test.ts` — the three capabilities, the `MODEL_UNSET` downgrade, and the error mapping.
 *
 * Two kinds of provider are used, neither of which is the internet:
 *
 * - **fixtures** — `LLM_MOCK_DIR` points at `.studio/mock`, so the code / vision / image paths are
 *   exercised with no socket at all (this is also the mode the gate runs in);
 * - **a loopback `node:http` server** on `127.0.0.1:0` — for the paths that *must* talk HTTP: the
 *   request shape, the retry rule, the status → code mapping and the same-origin guard on the image
 *   URL refetch (SSRF). A cross-origin URL is asserted to be refused **without** a second request
 *   ever reaching the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { REPO_ROOT, assertRuntimeConfig, loadConfig } from '../../src/studio/config.ts';
import type { StudioConfig } from '../../src/studio/config.ts';
import {
  LlmError,
  extractCodeFence,
  generateImage,
  generateVideoSource,
  understandImage,
} from '../../src/studio/llm.ts';

/** The fixture directory the commander pre-creates for the gate (§10). */
const MOCK_DIR = join(REPO_ROOT, '.studio', 'mock');

const API_KEY = 'sk-test-not-a-real-key';

/** A config that reads the fixtures; `overrides` knock single fields out. */
function mockConfig(overrides: Partial<StudioConfig> = {}): StudioConfig {
  return Object.freeze({
    ...loadConfig({
      LLM_BASE_URL: 'https://mock.invalid/v1',
      LLM_API_KEY: API_KEY,
      LLM_MODEL: 'mock-code-model',
      LLM_VISION_MODEL: 'mock-vision-model',
      LLM_IMAGE_MODEL: 'mock-image-model',
      LLM_MOCK_DIR: '',
    }),
    mockDir: MOCK_DIR,
    ...overrides,
  });
}

/** Asserts `promise` rejects with an `LlmError` carrying `code` (and `status`, when given). */
async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LlmError, `expected an LlmError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) {
      assert.equal(error.status, status);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// a loopback OpenAI compatible provider
// ---------------------------------------------------------------------------

interface ProviderReply {
  readonly status: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly contentType?: string;
}

/** One recorded request, so a test can assert "this was never refetched". */
interface Hit {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

interface Provider {
  readonly base: string;
  readonly hits: Hit[];
  close(): Promise<void>;
}

/** Starts the loopback provider on an ephemeral port and returns its `/v1` base. */
async function startProvider(
  handler: (hit: Hit) => ProviderReply,
): Promise<Provider> {
  const hits: Hit[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const hit: Hit = {
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      };
      hits.push(hit);
      const reply = handler(hit);
      response.writeHead(reply.status, {
        'content-type': reply.contentType ?? 'application/json',
      });
      response.end(reply.bytes ?? Buffer.from(reply.text ?? JSON.stringify(reply.json ?? {}), 'utf8'));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A config pointed at the loopback provider instead of at fixtures. */
function liveConfig(base: string, overrides: Partial<StudioConfig> = {}): StudioConfig {
  return Object.freeze({
    ...loadConfig({
      LLM_BASE_URL: base,
      LLM_API_KEY: API_KEY,
      LLM_MODEL: 'live-code-model',
      LLM_VISION_MODEL: 'live-vision-model',
      LLM_IMAGE_MODEL: 'live-image-model',
      LLM_MOCK_DIR: '',
    }),
    llmTimeoutMs: 5_000,
    imageTimeoutMs: 5_000,
    ...overrides,
  });
}

/** A one pixel PNG header, enough for `sniffImageMime` to say `image/png`. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

// ---------------------------------------------------------------------------
// mock mode: the three fixtures (§9)
// ---------------------------------------------------------------------------

test('mock mode: generateVideoSource serves <mockDir>/video.ts verbatim', async () => {
  const cfg = mockConfig();
  const result = await generateVideoSource({ prompt: '做一个 5 秒的开场' }, cfg);
  const fixture = readFileSync(join(MOCK_DIR, 'video.ts'), 'utf8');
  assert.equal(result.raw, fixture, 'raw is the fixture as it is on disk');
  assert.equal(result.source, extractCodeFence(fixture));
  assert.ok(result.source.includes('class MockStudioVideo implements Video'));
  assert.equal(result.model, 'mock-code-model');
  assert.equal(result.usage, undefined, 'mock mode has no usage');
  // Import normalisation is `projects.writeSource`'s job, not this module's: the fixture's own
  // depth has to survive the trip so the gate can prove the normaliser works (S6).
  assert.ok(result.source.includes("'../../src/index.ts'"));
});

test('mock mode: understandImage serves <mockDir>/vision.txt', async () => {
  const result = await understandImage({ dataUrl: 'data:image/png;base64,AAAA' }, mockConfig());
  assert.equal(result.description, readFileSync(join(MOCK_DIR, 'vision.txt'), 'utf8').trim());
  assert.equal(result.model, 'mock-vision-model');
  assert.ok(result.description.length > 0);
});

test('mock mode: generateImage serves <mockDir>/asset.png as png bytes', async () => {
  const result = await generateImage({ prompt: '蓝色圆形标志' }, mockConfig());
  const fixture = readFileSync(join(MOCK_DIR, 'asset.png'));
  assert.deepEqual(Buffer.from(result.bytes), fixture);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.model, 'mock-image-model');
});

test('a missing fixture is reported, not silently faked', async () => {
  const cfg = mockConfig({ mockDir: join(REPO_ROOT, '.studio', 'no-such-mock-dir') });
  await rejectsWithCode(generateVideoSource({ prompt: 'x' }, cfg), 'MOCK_FIXTURE_MISSING');
  await rejectsWithCode(understandImage({ dataUrl: 'data:image/png;base64,AA' }, cfg), 'MOCK_FIXTURE_MISSING');
  await rejectsWithCode(generateImage({ prompt: 'x' }, cfg), 'MOCK_FIXTURE_MISSING');
});

// ---------------------------------------------------------------------------
// MODEL_UNSET (§5.2, gate S17) — checked before the mock branch
// ---------------------------------------------------------------------------

test('MODEL_UNSET wins over mock fixtures', async () => {
  const noVision = mockConfig({ visionModel: null });
  const noImage = mockConfig({ imageModel: null });
  const noCode = mockConfig({ model: '' });
  // Each of these has a readable fixture behind it, so a fixture-satisfying path would answer 200.
  await rejectsWithCode(understandImage({ dataUrl: 'data:image/png;base64,AA' }, noVision), 'MODEL_UNSET');
  await rejectsWithCode(generateImage({ prompt: 'x' }, noImage), 'MODEL_UNSET');
  await rejectsWithCode(generateVideoSource({ prompt: 'x' }, noCode), 'MODEL_UNSET');
  // And with all three models present the same calls still work, which is what makes this a
  // downgrade rather than a break.
  assert.equal((await understandImage({ dataUrl: 'x' }, mockConfig())).model, 'mock-vision-model');
  assert.equal((await generateImage({ prompt: 'x' }, mockConfig())).model, 'mock-image-model');
});

test('a non-mock config without a key is refused at startup', () => {
  const cfg = loadConfig({ LLM_BASE_URL: 'https://api.invalid/v1', LLM_MODEL: 'm' });
  assert.throws(() => assertRuntimeConfig(cfg), /LLM_API_KEY is required/);
  const noModel = loadConfig({ LLM_BASE_URL: 'https://api.invalid/v1', LLM_API_KEY: 'k' });
  assert.throws(() => assertRuntimeConfig(noModel), /LLM_MODEL is required/);
  const badUrl = loadConfig({ LLM_BASE_URL: 'not a url', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
  assert.throws(() => assertRuntimeConfig(badUrl), /LLM_BASE_URL/);
  // Mock mode needs nothing at all.
  const ok = loadConfig({ LLM_MOCK_DIR: '.studio/mock' });
  assert.equal(assertRuntimeConfig(ok), ok);
});

// ---------------------------------------------------------------------------
// the request shape and the error mapping, over loopback
// ---------------------------------------------------------------------------

test('generateVideoSource sends the system prompt, the user prompt and the key as a header', async () => {
  const provider = await startProvider(() => ({
    status: 200,
    json: {
      choices: [{ message: { content: '```ts\nconst a = 1;\n```' } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    },
  }));
  try {
    const result = await generateVideoSource(
      { prompt: '做一个片头', references: [{ name: 'logo.png', description: '蓝色圆形标志' }] },
      liveConfig(provider.base),
    );
    assert.equal(result.source, 'const a = 1;', 'the fence is stripped from source but kept in raw');
    assert.equal(result.raw, '```ts\nconst a = 1;\n```');
    assert.equal(result.model, 'live-code-model');
    assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 3, totalTokens: 14 });

    assert.equal(provider.hits.length, 1);
    const hit = provider.hits[0] as Hit;
    assert.equal(hit.method, 'POST');
    assert.equal(hit.path, '/v1/chat/completions', 'the root is used as given, with one slash');
    assert.equal(hit.authorization, `Bearer ${API_KEY}`);
    assert.equal(hit.body.model, 'live-code-model');
    assert.equal(hit.body.temperature, 0.2);
    assert.equal(hit.body.stream, false);
    const messages = hit.body.messages as { role: string; content: string }[];
    assert.equal(messages[0]?.role, 'system');
    assert.ok((messages[0]?.content ?? '').includes('## 1. Video 契约'));
    assert.equal(messages[1]?.role, 'user');
    assert.ok((messages[1]?.content ?? '').includes('logo.png'), 'the ticked asset is described');
  } finally {
    await provider.close();
  }
});

test('a trailing slash on the base url does not double up', async () => {
  const provider = await startProvider(() => ({
    status: 200,
    json: { choices: [{ message: { content: 'const a = 1;' } }] },
  }));
  try {
    await generateVideoSource({ prompt: 'x' }, liveConfig(`${provider.base}/`));
    assert.equal(provider.hits[0]?.path, '/v1/chat/completions');
  } finally {
    await provider.close();
  }
});

test('a 401 is not retried and is mapped to UNAUTHORIZED', async () => {
  const provider = await startProvider(() => ({
    status: 401,
    json: { error: { message: 'Incorrect API key provided' } },
  }));
  try {
    await rejectsWithCode(
      generateVideoSource({ prompt: 'x' }, liveConfig(provider.base)),
      'UNAUTHORIZED',
      401,
    );
    assert.equal(provider.hits.length, 1, 'a wrong key must not be retried');
  } finally {
    await provider.close();
  }
});

test('a 429 is not retried either', async () => {
  const provider = await startProvider(() => ({ status: 429, json: { error: 'slow down' } }));
  try {
    await rejectsWithCode(generateVideoSource({ prompt: 'x' }, liveConfig(provider.base)), 'RATE_LIMITED', 429);
    assert.equal(provider.hits.length, 1);
  } finally {
    await provider.close();
  }
});

test('a 5xx is retried exactly once', async () => {
  const provider = await startProvider(() => ({ status: 503, json: { error: 'unavailable' } }));
  try {
    await rejectsWithCode(generateVideoSource({ prompt: 'x' }, liveConfig(provider.base)), 'UPSTREAM', 503);
    assert.equal(provider.hits.length, 2, 'one retry, then give up');
  } finally {
    await provider.close();
  }
});

test('the key never reaches an error message', async () => {
  const provider = await startProvider(() => ({
    status: 400,
    json: { error: { message: `bad request; your key ${API_KEY} was rejected` } },
  }));
  try {
    await generateVideoSource({ prompt: 'x' }, liveConfig(provider.base)).then(
      () => assert.fail('expected a rejection'),
      (error: unknown) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.code, 'BAD_REQUEST');
        assert.ok(!error.message.includes(API_KEY), `the key leaked: ${error.message}`);
        assert.ok(error.message.includes('***'), 'the redaction mark should be visible instead');
      },
    );
  } finally {
    await provider.close();
  }
});

test('a 2xx without choices is an EMPTY_RESPONSE, not a silent empty file', async () => {
  const provider = await startProvider(() => ({ status: 200, json: { id: 'x' } }));
  try {
    await rejectsWithCode(generateVideoSource({ prompt: 'x' }, liveConfig(provider.base)), 'EMPTY_RESPONSE');
    await rejectsWithCode(
      understandImage({ dataUrl: 'data:image/png;base64,AA' }, liveConfig(provider.base)),
      'EMPTY_RESPONSE',
    );
  } finally {
    await provider.close();
  }
});

test('understandImage sends one image as one data url', async () => {
  const provider = await startProvider(() => ({
    status: 200,
    json: { choices: [{ message: { content: '  蓝色圆形标志  ' } }] },
  }));
  try {
    const result = await understandImage(
      { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      liveConfig(provider.base),
    );
    assert.equal(result.description, '蓝色圆形标志', 'the description is trimmed');
    const messages = provider.hits[0]?.body.messages as {
      content: { type: string; text?: string; image_url?: { url: string } }[];
    }[];
    const parts = messages[0]?.content ?? [];
    assert.equal(parts.length, 2);
    assert.equal(parts[0]?.type, 'text');
    assert.ok((parts[0]?.text ?? '').length > 0, 'the default instruction is filled in');
    assert.equal(parts[1]?.type, 'image_url');
    assert.equal(parts[1]?.image_url?.url, 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(provider.hits[0]?.body.max_tokens, 300);
  } finally {
    await provider.close();
  }
});

// ---------------------------------------------------------------------------
// image generation and the SSRF guard (§8.6, gate S19)
// ---------------------------------------------------------------------------

test('generateImage prefers b64_json and asks for it', async () => {
  const provider = await startProvider(() => ({
    status: 200,
    json: { data: [{ b64_json: Buffer.from(PNG_BYTES).toString('base64') }] },
  }));
  try {
    const result = await generateImage({ prompt: '蓝色圆形标志' }, liveConfig(provider.base));
    assert.deepEqual(result.bytes, PNG_BYTES);
    assert.equal(result.mime, 'image/png', 'the mime comes from the bytes, not from the provider');
    assert.equal(result.model, 'live-image-model');
    const hit = provider.hits[0] as Hit;
    assert.equal(hit.path, '/v1/images/generations');
    assert.equal(hit.body.response_format, 'b64_json');
    assert.equal(hit.body.n, 1);
    assert.equal(hit.body.prompt, '蓝色圆形标志');
    assert.equal(hit.body.size, '1024x1024', 'the configured default size is used');
    assert.equal(provider.hits.length, 1, 'a b64 answer must not be refetched');
  } finally {
    await provider.close();
  }
});

test('generateImage refuses a cross-origin url without refetching it (SSRF)', async () => {
  const provider = await startProvider(() => ({
    status: 200,
    json: { data: [{ url: 'http://169.254.169.254/latest/meta-data/' }] },
  }));
  try {
    await rejectsWithCode(
      generateImage({ prompt: 'x' }, liveConfig(provider.base)),
      'IMAGE_URL_UNSUPPORTED',
    );
    assert.equal(provider.hits.length, 1, 'the hostile url must never be requested');
  } finally {
    await provider.close();
  }
});

test('generateImage refuses a non-http url too', async () => {
  const provider = await startProvider(() => ({
    status: 200,
    json: { data: [{ url: 'file:///etc/passwd' }] },
  }));
  try {
    await rejectsWithCode(generateImage({ prompt: 'x' }, liveConfig(provider.base)), 'IMAGE_URL_UNSUPPORTED');
    assert.equal(provider.hits.length, 1);
  } finally {
    await provider.close();
  }
});

test('generateImage refetches a same-origin url', async () => {
  const provider = await startProvider((hit) =>
    hit.path.endsWith('/image.png')
      ? { status: 200, bytes: Buffer.from(PNG_BYTES), contentType: 'image/png' }
      : { status: 200, json: { data: [{ url: `${provider.base}/image.png` }] } },
  );
  try {
    const result = await generateImage({ prompt: 'x' }, liveConfig(provider.base));
    assert.deepEqual(result.bytes, PNG_BYTES);
    assert.equal(result.mime, 'image/png');
    assert.equal(provider.hits.length, 2, 'one POST and one same-origin GET');
    assert.equal(provider.hits[1]?.method, 'GET');
  } finally {
    await provider.close();
  }
});

test('an oversized image behind a same-origin url is refused on the way back', async () => {
  const provider = await startProvider((hit) =>
    hit.path.endsWith('/big.png')
      ? { status: 200, bytes: Buffer.alloc(64, 7) }
      : { status: 200, json: { data: [{ url: `${provider.base}/big.png` }] } },
  );
  try {
    await rejectsWithCode(
      generateImage({ prompt: 'x' }, liveConfig(provider.base, { maxUploadBytes: 16 })),
      'IMAGE_TOO_LARGE',
    );
  } finally {
    await provider.close();
  }
});

test('an image answer with neither b64_json nor url names the provider requirement', async () => {
  const provider = await startProvider(() => ({ status: 200, json: { data: [{ revised_prompt: 'x' }] } }));
  try {
    await assert.rejects(generateImage({ prompt: 'x' }, liveConfig(provider.base)), (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.code, 'IMAGE_RESPONSE_UNSUPPORTED');
      assert.ok(error.message.includes('b64_json'), 'the message should tell the operator what to fix');
      return true;
    });
  } finally {
    await provider.close();
  }
});

// ---------------------------------------------------------------------------
// the native dashscope (qwen-image) path — LLM_IMAGE_PROTOCOL=dashscope
// ---------------------------------------------------------------------------

test('dashscope generateImage posts the native shape and refetches the returned url', async () => {
  const provider = await startProvider((hit) =>
    hit.path.endsWith('/gen.png')
      ? { status: 200, bytes: Buffer.from(PNG_BYTES), contentType: 'image/png' }
      : {
          status: 200,
          json: {
            output: { choices: [{ message: { content: [{ image: `${provider.base}/gen.png` }] } }] },
          },
        },
  );
  try {
    const result = await generateImage(
      { prompt: '蓝色圆形标志' },
      liveConfig(provider.base, { imageProtocol: 'dashscope' }),
    );
    assert.deepEqual(result.bytes, PNG_BYTES);
    assert.equal(result.mime, 'image/png');
    assert.equal(result.model, 'live-image-model');

    const post = provider.hits[0] as Hit;
    assert.equal(post.method, 'POST');
    assert.equal(
      post.path,
      '/api/v1/services/aigc/multimodal-generation/generation',
      'the native endpoint is derived from the base url origin',
    );
    assert.equal(post.body.model, 'live-image-model');
    const input = post.body.input as { messages: { content: { text?: string }[] }[] };
    assert.equal(input.messages[0]?.content[0]?.text, '蓝色圆形标志');
    const parameters = post.body.parameters as Record<string, unknown>;
    assert.equal(parameters.size, '1024*1024', 'the x in the configured size becomes a *');
    assert.equal(parameters.n, 1);
    assert.equal(parameters.watermark, false);
    assert.equal(provider.hits.length, 2, 'one native POST and one GET of the returned image url');
    assert.equal(provider.hits[1]?.method, 'GET');
  } finally {
    await provider.close();
  }
});

test('dashscope generateImage honours a size override and an explicit LLM_IMAGE_URL', async () => {
  const provider = await startProvider((hit) =>
    hit.path.endsWith('/gen.png')
      ? { status: 200, bytes: Buffer.from(PNG_BYTES), contentType: 'image/png' }
      : {
          status: 200,
          json: { output: { choices: [{ message: { content: [{ image: `${provider.base}/gen.png` }] } }] } },
        },
  );
  try {
    const cfg = liveConfig(provider.base, {
      imageProtocol: 'dashscope',
      imageUrl: `${provider.base}/custom-image-endpoint`,
    });
    await generateImage({ prompt: 'x', size: '1536X1024' }, cfg);
    const post = provider.hits[0] as Hit;
    assert.equal(post.path, '/v1/custom-image-endpoint', 'LLM_IMAGE_URL overrides the derived endpoint');
    const parameters = post.body.parameters as Record<string, unknown>;
    assert.equal(parameters.size, '1536*1024');
  } finally {
    await provider.close();
  }
});

test('dashscope generateImage refuses an internal-address image url (SSRF)', async () => {
  const provider = await startProvider(() => ({
    status: 200,
    json: {
      output: {
        choices: [{ message: { content: [{ image: 'http://169.254.169.254/latest/meta-data/' }] } }],
      },
    },
  }));
  try {
    await rejectsWithCode(
      generateImage({ prompt: 'x' }, liveConfig(provider.base, { imageProtocol: 'dashscope' })),
      'IMAGE_URL_UNSUPPORTED',
    );
    assert.equal(provider.hits.length, 1, 'the internal url must never be requested');
  } finally {
    await provider.close();
  }
});

test('dashscope generateImage reports IMAGE_RESPONSE_UNSUPPORTED when no url comes back', async () => {
  const provider = await startProvider(() => ({
    status: 200,
    json: { output: { choices: [{ message: { content: [{ text: 'no image here' }] } }] } },
  }));
  try {
    await rejectsWithCode(
      generateImage({ prompt: 'x' }, liveConfig(provider.base, { imageProtocol: 'dashscope' })),
      'IMAGE_RESPONSE_UNSUPPORTED',
    );
  } finally {
    await provider.close();
  }
});

test('extractCodeFence is what the code path relies on', () => {
  assert.equal(extractCodeFence('```ts\nexport default 1;\n```'), 'export default 1;');
  assert.equal(extractCodeFence('export default 1;'), 'export default 1;');
});
