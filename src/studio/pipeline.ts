/**
 * pipeline.ts — the orchestration layer (`page.md` §5.6).
 *
 * Everything the studio shows or produces goes through one of the functions here, and every one of
 * them is a **thin, honest wrapper over the public library API** (§5.1). No rendering logic is
 * rewritten: `createRenderSession`, `renderFrameSvg`, `renderFramePng`, `renderVideo`,
 * `timelineReport` and `inspectVideo` do the work exactly as they do for the CLI, which is the whole
 * point of the design — the studio is a different front end, not a different renderer.
 *
 * ## Why the import is inlined here
 *
 * §5.6 asks `validate` to short circuit through **five** steps and to report which one failed:
 * `import` → `session` → `inspect` → `probe-frame` → `ok`. `projects.loadProject` does the first two
 * in a single call, so it cannot tell "the module would not import" from "the session could not be
 * built" — and those are the two different `stage` values a user needs to see. This module therefore
 * owns the *staged* build ({@link importVideo} + {@link sessionFor}), and {@link buildSession} is the
 * composition of the two, so there is exactly **one** staged implementation in the studio rather than
 * two that can drift.
 *
 * `mediaDirFor` is imported from `'../cli/main.ts'` and not from `'../index.ts'`: `src/index.ts`
 * deliberately does not re-export `main.ts` (the module graph deadlock documented at the end of that
 * file, and decision D8 of `page.md`). `mediaDirFor(videoPath)` is what puts the project's `media/`
 * into the session, so a generated `video.ts` can reference an uploaded asset with
 * `ctx.getImage('logo.png')` and no extra wiring.
 *
 * `loadVideo` is *not* what performs the import, and that is a technical necessity rather than a
 * preference. ESM keys its registry by URL, so a re-imported `video.ts` would hand back the previous
 * module and `POST /api/validate` would keep re-checking whatever was generated first. The bust needs
 * `?v=<rev>`, and `loadVideo` takes a *filesystem path* — which `pathToFileURL` percent-encodes, so a
 * `?` in it would become `%3F` and stop being a query. `projects.loadProject` faces the same
 * constraint and solves it the same way; it simply does not need the stage split, so the two live
 * side by side and share the revision counter.
 *
 * ## The empty frame is not an error
 *
 * §5.6: "`renderFrame` 首帧可能是 `Svgr.empty()` 合法值但 rasterize 拒绝". `Svgr.empty()` is the empty
 * string, and `rasterize` rejects an empty document. `inspect` already classifies that as an
 * `empty-frame` **warning** (`src/inspect/diagnostics.ts`), so the probe frame applies the same
 * rule with the same test: an empty document only becomes a finding, while a real throw from
 * `renderFrame` or a malformed document still fails validation with `stage: 'probe-frame'`.
 */

import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  UsageError,
  createRenderSession,
  inspectVideo,
  renderFramePng,
  renderFrameSvg,
  renderVideo,
  timelineReport,
} from '../index.ts';
import type {
  FrameRange,
  InspectFinding,
  InspectResult,
  RenderReport,
  RenderSession,
  TimelineReport,
  Video,
} from '../index.ts';
import { mediaDirFor } from '../cli/main.ts';

import type { StudioConfig } from './config.ts';
import { sourceRevision, videoFromDefault } from './projects.ts';
import type { InspectOptions, Project, ValidationResult, ValidationStage } from './types.ts';

// §5.6 presents the reports as this module's surface; the single definitions live in `types.ts` /
// `../index.ts`, so they are re-exported rather than redeclared.
export type { InspectFinding, InspectResult, RenderReport, RenderSession, TimelineReport };

/** The probe rasterizes the middle frame, clamped into the video. */
function midFrame(session: RenderSession): number {
  const last = Math.max(0, session.durationInFrames - 1);
  return Math.min(last, Math.max(0, Math.trunc(session.durationInFrames / 2)));
}

/** An error as a message: the API contract sends `error`, never a stack (§5.8). */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === '' ? 'unknown error' : message;
}

/**
 * Whether a `renderFramePng` failure is the "empty document" case rather than a real failure.
 *
 * Same test the CLI inspect uses (`src/inspect/diagnostics.ts`): `rasterize` throws
 * `… can not render an empty SVG document` for `svg.length === 0`, and that is a warning. Anything
 * else — a throw from `renderFrame`, malformed markup, a missing font that resvg rejects — is real.
 */
function isEmptyDocumentError(message: string): boolean {
  return message.includes('empty SVG document');
}

// ---------------------------------------------------------------------------
// building a session
// ---------------------------------------------------------------------------

/**
 * `importVideo` — step 1 of §5.6: the project's `video.ts` is evaluated and its default export
 * checked. Throws `UsageError` for a bad default export, and wraps a syntax / resolution failure in
 * one too, so `validate` can report a single `import` stage for both.
 *
 * Evaluating the file is the documented RCE surface of the studio (§8.2): `renderFrame` is arbitrary
 * JavaScript. Binding the server to loopback and staying single user is the v1 mitigation.
 *
 * The `?v=<rev>` query is what makes a second `validate` see the *new* file: ESM keys its registry by
 * URL, so an unchanged query would return the module evaluated the first time. `sourceRevision` is the
 * per-project counter `projects.writeSource` bumps (§5.5, decision D5).
 */
export async function importVideo(p: Project, cfg: StudioConfig): Promise<Video> {
  const repoRoot = resolve(cfg.repoRoot);
  const videoPath = resolve(p.videoPath);
  if (videoPath !== repoRoot && !videoPath.startsWith(repoRoot + sep)) {
    throw new UsageError(`"${p.videoPath}" is outside ${repoRoot}`);
  }
  if (!existsSync(videoPath)) {
    throw new UsageError(`"${p.videoPath}" does not exist: generate or write a video.ts first`);
  }
  let imported: unknown;
  try {
    imported = await import(`${pathToFileURL(videoPath).href}?v=${sourceRevision(p)}`);
  } catch (error) {
    throw new UsageError(`can not load "${p.videoPath}": ${messageOf(error)}`);
  }
  return videoFromDefault((imported as { default?: unknown }).default, p.videoPath);
}

/**
 * `sessionFor` — step 2 of §5.6: `createRenderSession` with the project's `media/` wired in as
 * `PipelineOptions.mediaDir`, so `ctx.getImage` resolves against `.studio/projects/<id>/media/`.
 */
export function sessionFor(video: Video, p: Project): RenderSession {
  return createRenderSession(video, {
    fps: video.fps,
    width: video.width,
    height: video.height,
    mediaDir: mediaDirFor(p.videoPath),
  });
}

/**
 * `buildSession` — `import` + `session`, the session every other function in this module takes.
 *
 * ```ts
 * const session = await buildSession(project, cfg);
 * timeline(session); // → TimelineReport
 * ```
 */
export async function buildSession(p: Project, cfg: StudioConfig): Promise<RenderSession> {
  const video = await importVideo(p, cfg);
  return sessionFor(video, p);
}

// ---------------------------------------------------------------------------
// the reporting commands
// ---------------------------------------------------------------------------

/** `timeline(session)` — `timelineReport` verbatim: fps, size, duration, scenes, audio. */
export function timeline(session: RenderSession): TimelineReport {
  return timelineReport(session);
}

/**
 * `inspect` — `inspectVideo` over `rangeSpec`, or over the whole video when there is no spec.
 *
 * A malformed or out of range spec throws `TimeSpecResolveError`, which `server.ts` turns into a
 * 400 — the same message the CLI prints.
 */
export function inspect(
  session: RenderSession,
  rangeSpec?: string,
  options: InspectOptions = {},
): InspectResult {
  const range = resolveRange(session, rangeSpec);
  return inspectVideo(session, { ...options, range });
}

/** A spec resolves against the session's index; blank/absent means "everything". */
function resolveRange(session: RenderSession, rangeSpec?: string): FrameRange {
  if (rangeSpec === undefined || rangeSpec.trim() === '') {
    return session.index.fullRange();
  }
  return session.index.resolveRange(rangeSpec);
}

/** `framePng` — one frame as PNG bytes, for the ③ scrub `<img src>` (§5.8 `/api/frame`). */
export function framePng(session: RenderSession, spec: string): Buffer {
  return renderFramePng(session, frameOf(session, spec));
}

/** `frameSvg` — one frame as SVG source, for the "view the markup" affordance. */
export function frameSvg(session: RenderSession, spec: string): string {
  return renderFrameSvg(session, frameOf(session, spec));
}

/** A frame spec resolves through `TimelineIndex`, so `50%`, `3.2s`, `Intro@1.5s` all work. */
function frameOf(session: RenderSession, spec: string): number {
  if (spec.trim() === '') {
    return 0;
  }
  return session.index.resolveFrame(spec);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** How far along a render is, in the terms §5.7's `progress` event needs. */
export interface RenderProgress {
  /** Frames encoded so far, counted from the start of the range. */
  readonly done: number;
  /** Frames in the range. */
  readonly total: number;
  /** The absolute global frame just encoded, `range.start + done - 1`. */
  readonly frame: number;
}

/** What `render` takes; the `renderVideo` options of §5.1 minus `floatAudio`/`mixer`. */
export interface RenderOptions {
  /** `TimeSpec` range, e.g. `Intro@1.2s..3s`. Absent or blank means the whole video. */
  readonly range?: string;
  /** Where the mp4 goes — `jobs.ts` always points this inside the project's `out/`. */
  readonly output: string;
  /** Half resolution (unless `scale`) plus the fastest preset. */
  readonly draft?: boolean;
  /** Resolution multiplier, wins over `draft`. */
  readonly scale?: number;
  /** x264 quality. */
  readonly crf?: number;
  /** libx264 preset. */
  readonly preset?: string;
  /**
   * Progress, one call per frame.
   *
   * The range is resolved *here*, so the consumer is told `done` relative to the range and not to
   * the video: `renderVideo` reports absolute frames, and a range starting at frame 300 would
   * otherwise announce "300/350" for the first frame.
   */
  readonly onProgress?: (progress: RenderProgress) => void;
}

/**
 * `render` — `renderVideo` with a resolved range, forwarding progress in range-relative terms.
 *
 * `session` is passed in rather than a project so the caller owns the session's lifetime; `jobs.ts`
 * builds it once and reuses it for the whole queue.
 */
export async function render(
  session: RenderSession,
  options: RenderOptions,
): Promise<RenderReport> {
  const range = resolveRange(session, options.range);
  const total = Math.max(0, range.end - range.start);
  const onProgress = options.onProgress;
  return renderVideo(session, {
    range,
    output: options.output,
    draft: options.draft,
    scale: options.scale,
    crf: options.crf,
    preset: options.preset,
    onProgress:
      onProgress === undefined
        ? undefined
        : (frame, frames) => {
            // `renderVideo` reports the absolute frame of the frame just written; `written` is
            // 1-based, so the count inside the range is `frame - range.start`.
            const done = Math.min(total, Math.max(0, frame - range.start));
            onProgress({ done, total: Math.max(total, frames), frame });
          },
  });
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/** The `stage`/`error` pair for a step that failed, with everything after it left empty. */
function stopped(
  stage: ValidationStage,
  error: string,
  timeline: TimelineReport | null,
  findings: readonly InspectFinding[],
): ValidationResult {
  return { ok: false, stage, error, timeline, findings, probeFramePngBytes: 0 };
}

/**
 * `validate` — the five short circuiting steps of §5.6, and the answer behind both
 * `/api/generate` and `/api/validate`.
 *
 * ```ts
 * const validation = await validate(project, cfg);
 * if (!validation.ok) console.log(validation.stage, validation.error);
 * ```
 *
 * The steps, and what each one is for:
 *
 * 1. `import` — does the file even evaluate and export a `Video`?
 * 2. `session` — does the duration / scene / audio map resolve?
 * 3. `inspect` — missing fonts, missing media, empty frames. Warnings, never fatal on their own,
 *    and `session.audioResolveError` is folded in as a finding rather than an error (§5.6).
 * 4. `probe-frame` — one real rasterization of a middle frame, which is what catches a `renderFrame`
 *    that throws and a document resvg refuses. An *empty* document is a warning, not a failure.
 * 5. `ok`.
 *
 * It never throws: a failure is a `ValidationResult` with a `stage`, because the answer is shown in
 * the ③ panel rather than as a 500.
 */
export async function validate(p: Project, cfg: StudioConfig): Promise<ValidationResult> {
  let video: Video;
  try {
    video = await importVideo(p, cfg);
  } catch (error) {
    return stopped('import', messageOf(error), null, []);
  }

  let session: RenderSession;
  try {
    session = sessionFor(video, p);
  } catch (error) {
    return stopped('session', messageOf(error), null, []);
  }

  const report = timelineReport(session);
  const findings: InspectFinding[] = [];

  // A track whose `Eof` names a file the media directory does not have leaves the duration
  // unresolved. The CLI keeps rendering and lets `inspect` say so; same here, as a warning.
  if (session.audioResolveError !== null) {
    findings.push({
      frame: 0,
      severity: 'warning',
      kind: 'missing-media',
      message: session.audioResolveError,
    });
  }

  try {
    const inspected = inspectVideo(session, { range: session.index.fullRange() });
    findings.push(...inspected.findings);
  } catch (error) {
    return stopped('inspect', messageOf(error), report, findings);
  }

  const frame = midFrame(session);
  let probeFramePngBytes = 0;
  try {
    probeFramePngBytes = renderFramePng(session, frame).byteLength;
  } catch (error) {
    const message = messageOf(error);
    if (isEmptyDocumentError(message)) {
      // `Svgr.empty()` is a legal return value; the frame simply has nothing in it. `inspect`
      // reports the same thing as an `empty-frame` warning, so validation stays `ok`.
      findings.push({
        frame,
        severity: 'warning',
        kind: 'empty-frame',
        message: `frame ${frame} rendered nothing (the SVG document is empty)`,
      });
    } else {
      return stopped('probe-frame', message, report, findings);
    }
  }

  return { ok: true, stage: 'ok', error: null, timeline: report, findings, probeFramePngBytes };
}
