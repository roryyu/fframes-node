/**
 * jobs.ts — the single slot render queue and the SSE broadcast behind it (`page.md` §5.7).
 *
 * Rendering is CPU bound and the frame loop is serial by construction (one `renderFramePng` per
 * frame, fed into one ffmpeg), so "two renders at once" does not make anything faster — it makes the
 * ③ preview stutter and the progress bars lie. The queue is therefore deliberately **one slot deep**:
 * `submitRender` returns immediately with a `queued` job, and exactly one job is ever `running`.
 *
 * ```text
 * submitRender → [queued] ──(slot free)──▶ [running] ──▶ [done] | [error]
 *                      └──────────────────────(queued until the slot frees)
 * ```
 *
 * Three things this module owns, and nothing else:
 *
 * - **the queue** — FIFO over job ids, one active job, `queued → running → done | error`;
 * - **the artefact path** — `<project>/out/<jobId>.mp4`, and the `/media/...` URL that serves it;
 * - **the event fan-out** — `progress` (throttled to every 10 frames, matching the CLI's
 *   `PROGRESS_EVERY`), `done`, `error`, broadcast to every {@link subscribe} listener.
 *
 * It owns no rendering logic: {@link buildSession} and {@link render} are injected, defaulting to
 * `pipeline.ts`. That is what lets the *serialisation* be tested without an ffmpeg round trip per
 * frame; the real encode path is what the gate's S10/S11 exercise. All state is in memory and a
 * restart drops it, while the mp4 stays on disk (§11).
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { StudioConfig } from './config.ts';
import { buildSession, render } from './pipeline.ts';
import type { RenderOptions, RenderProgress, RenderSession } from './pipeline.ts';
import { PROJECT_OUT_DIR, resolveProject } from './projects.ts';
import type {
  JobEvent,
  JobProgress,
  JobStatus,
  Project,
  RenderJob,
  RenderReport,
} from './types.ts';

// §5.7 presents these as part of this module's surface; the definitions live in `types.ts`.
export type { JobEvent, JobProgress, JobStatus, RenderJob };

/**
 * Progress is broadcast every 10 frames, not every frame.
 *
 * A 5 second 30 fps render is 150 frames; 150 SSE writes per job is noise, and the CLI makes the same
 * trade (`PROGRESS_EVERY` there is 10). The last frame of a range is always broadcast too, so a
 * short render that never reaches a multiple of 10 still completes its progress bar.
 */
export const PROGRESS_EVERY = 10;

// ---------------------------------------------------------------------------
// the request that is being served
// ---------------------------------------------------------------------------

/** What `submitRender` is asked to render; mirrors `POST /api/render` (§5.8). */
export interface RenderRequest {
  readonly projectId: string;
  /** `TimeSpec` range, e.g. `Intro@1.2s..3s`; absent means the whole video. */
  readonly range?: string;
  /** Half resolution and the fastest preset — the UI defaults this on. */
  readonly draft?: boolean;
  readonly scale?: number;
  readonly crf?: number;
  readonly preset?: string;
}

/** How the queue reaches the outside world; only `cfg` is required. */
export interface JobDependencies {
  readonly cfg: StudioConfig;
  /** Defaults to `pipeline.buildSession`; overridable so the queue can be tested in isolation. */
  readonly buildSession?: (p: Project, cfg: StudioConfig) => Promise<RenderSession>;
  /** Defaults to `pipeline.render`; receives the resolved `out/<jobId>.mp4` path. */
  readonly render?: (session: RenderSession, options: RenderOptions) => Promise<RenderReport>;
}

/** The mutable record behind the `readonly` {@link RenderJob} snapshot. */
interface JobRecord {
  readonly id: string;
  readonly projectId: string;
  /** Kept so a job that was still queued can be started later without a second map. */
  readonly request: RenderRequest;
  status: JobStatus;
  progress: JobProgress;
  report?: RenderReport;
  error?: string;
  outputUrl?: string;
}

/** A listener of a job's events; the SSE handler of `server.ts` is the real one. */
export type JobListener = (event: JobEvent) => void;

/** Options for {@link subscribe}. */
export interface SubscribeOptions {
  /**
   * Also replay the *current* state to a new listener: the terminal `done`/`error` of a finished
   * job, or the latest `progress` of one that is still going. This is what makes an `EventSource`
   * that connects late — or reconnects after a dropped connection — see the ending instead of
   * hanging on a stream that has nothing left to send.
   */
  readonly replayCurrent?: boolean;
}

const jobs = new Map<string, JobRecord>();
const listeners = new Map<string, Set<JobListener>>();
/** Job ids waiting for the slot, oldest first. */
const waiting: string[] = [];
/** The one job allowed to be `running`, or `null` when the slot is free. */
let active: string | null = null;

// ---------------------------------------------------------------------------
// snapshots and subscription
// ---------------------------------------------------------------------------

/** `job-<ms>-<6 hex>`: safe as a file name, because the artefact is named after it. */
function newJobId(): string {
  return `job-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

/** The frozen, JSON-ready view of a record — what `getJob` and `/api/render/:jobId` return. */
function snapshot(record: JobRecord): RenderJob {
  return Object.freeze({
    id: record.id,
    projectId: record.projectId,
    status: record.status,
    progress: Object.freeze({ done: record.progress.done, total: record.progress.total }),
    ...(record.report === undefined ? {} : { report: record.report }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.outputUrl === undefined ? {} : { outputUrl: record.outputUrl }),
  });
}

/** One job, or `undefined` when the id is unknown (a restart, or a typo). */
export function getJob(jobId: string): RenderJob | undefined {
  const record = jobs.get(jobId);
  return record === undefined ? undefined : snapshot(record);
}

/**
 * `subscribe` — listen to a job's events; returns the unsubscribe function.
 *
 * Events are delivered synchronously for the replay (see {@link SubscribeOptions.replayCurrent}) and
 * afterwards from the render loop's progress callback. A listener that throws is ignored rather than
 * allowed to abort a render other listeners still care about.
 */
export function subscribe(jobId: string, listener: JobListener, options: SubscribeOptions = {}): () => void {
  let set = listeners.get(jobId);
  if (set === undefined) {
    set = new Set<JobListener>();
    listeners.set(jobId, set);
  }
  set.add(listener);

  const record = jobs.get(jobId);
  if (options.replayCurrent === true && record !== undefined) {
    const replay = terminalEvent(record) ?? currentProgressEvent(record);
    if (replay !== null) {
      try {
        listener(replay);
      } catch {
        // A broken listener is the caller's problem, not a reason to drop the subscription.
      }
    }
  }

  return () => {
    const current = listeners.get(jobId);
    if (current === undefined) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(jobId);
    }
  };
}

/** The `done` or `error` event of a finished job; `null` while it is still going. */
function terminalEvent(record: JobRecord): JobEvent | null {
  if (record.status === 'done' && record.report !== undefined) {
    return { type: 'done', report: record.report, outputUrl: record.outputUrl ?? '' };
  }
  if (record.status === 'error') {
    return { type: 'error', message: record.error ?? 'the render failed' };
  }
  return null;
}

/**
 * The latest `progress` of a live job, for a listener that connected late.
 *
 * A job whose total is still `0` replays nothing: the frame count only becomes known once the render
 * loop reports its first frame, and `{done: 0, total: 0}` is noise rather than progress.
 */
function currentProgressEvent(record: JobRecord): JobEvent | null {
  if (record.progress.total > 0) {
    return { type: 'progress', done: record.progress.done, total: record.progress.total };
  }
  return null;
}

function emit(record: JobRecord, event: JobEvent): void {
  const set = listeners.get(record.id);
  if (set === undefined) {
    return;
  }
  // Iterate a copy: a listener may unsubscribe itself from inside its own callback.
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch {
      // One broken SSE client must not take the render, or the other clients, down.
    }
  }
}

// ---------------------------------------------------------------------------
// enqueue and run
// ---------------------------------------------------------------------------

/**
 * `submitRender` — enqueue a render and return at once.
 *
 * The returned job is `queued` (§5.7: "入队, 返回 job（立即）") because the caller opens
 * `/api/render/<jobId>/stream` next and needs the id before anything has happened. The job takes the
 * slot through {@link startSlotIfFree} as soon as it is free.
 *
 * Throws whatever `resolveProject` throws — 400 for a malformed id, 404 for an unknown project. Those
 * are bad requests, not a failed render, and the request never reaches the queue.
 */
export function submitRender(deps: JobDependencies, request: RenderRequest): RenderJob {
  const project = resolveProject(deps.cfg, request.projectId);
  const record: JobRecord = {
    id: newJobId(),
    projectId: project.id,
    request,
    status: 'queued',
    progress: { done: 0, total: 0 },
  };
  jobs.set(record.id, record);
  waiting.push(record.id);
  // Freeze the `queued` view *before* the slot is taken, and take it on a microtask rather than
  // inline. `startSlotIfFree` flips `record.status` to `running` synchronously, so calling it here
  // would hand the caller a job that is already `running` — contradicting §5.7 ("入队, 返回 job
  // (立即)"). Deferring by one microtask also lets the caller open `/api/render/<id>/stream` and
  // attach its listener before the first `progress` can possibly fire.
  const queued = snapshot(record);
  queueMicrotask(() => startSlotIfFree(deps, project, record));
  return queued;
}

/**
 * The one place the slot is taken. `active` is the single source of truth for "something is
 * rendering", and it is only ever cleared in {@link run}'s `finally`, immediately before the next
 * record is offered the slot — so two jobs can never both be `running`.
 */
function startSlotIfFree(deps: JobDependencies, project: Project, record: JobRecord): void {
  if (active !== null || waiting[0] !== record.id) {
    return; // Somebody else has the slot; this record keeps its place in `waiting`.
  }
  active = record.id;
  record.status = 'running';
  void run(deps, project, record);
}

/** Runs one job to completion, then hands the slot to the next. */
async function run(deps: JobDependencies, project: Project, record: JobRecord): Promise<void> {
  const build = deps.buildSession ?? buildSession;
  const encode = deps.render ?? render;
  try {
    const session = await build(project, deps.cfg);
    const output = join(project.dir, PROJECT_OUT_DIR, `${record.id}.mp4`);
    const onProgress = (progress: RenderProgress): void => {
      record.progress = { done: progress.done, total: progress.total };
      const last = progress.total > 0 && progress.done >= progress.total;
      if (progress.done % PROGRESS_EVERY === 0 || last) {
        emit(record, { type: 'progress', done: progress.done, total: progress.total });
      }
    };
    const report = await encode(session, {
      output,
      range: record.request.range,
      draft: record.request.draft,
      scale: record.request.scale,
      crf: record.request.crf,
      preset: record.request.preset,
      onProgress,
    });
    const frames = Math.max(0, report.frames.end - report.frames.start);
    record.status = 'done';
    record.report = report;
    record.progress = { done: frames, total: frames };
    record.outputUrl = `/media/${record.projectId}/${PROJECT_OUT_DIR}/${record.id}.mp4`;
    emit(record, { type: 'done', report, outputUrl: record.outputUrl });
  } catch (error) {
    record.status = 'error';
    // A message, never a stack: this string becomes `error.message` in the browser (§5.8).
    record.error = error instanceof Error ? error.message : String(error);
    emit(record, { type: 'error', message: record.error });
  } finally {
    release(record);
    offerNext(deps);
  }
}

/** Frees the slot and drops this job's listeners — a finished stream has nothing left to send. */
function release(record: JobRecord): void {
  if (active === record.id) {
    active = null;
  }
  const index = waiting.indexOf(record.id);
  if (index >= 0) {
    waiting.splice(index, 1);
  }
  listeners.delete(record.id);
}

/** Hands the freed slot to the head of the queue, skipping one whose project has since vanished. */
function offerNext(deps: JobDependencies): void {
  while (active === null && waiting.length > 0) {
    const next = jobs.get(waiting[0] as string);
    if (next === undefined) {
      waiting.shift();
      continue;
    }
    let project: Project | undefined;
    try {
      project = resolveProject(deps.cfg, next.projectId);
    } catch {
      // The project was deleted while the job waited: report it instead of dropping it silently.
      next.status = 'error';
      next.error = `project "${next.projectId}" no longer exists`;
      emit(next, { type: 'error', message: next.error });
      release(next);
      continue;
    }
    startSlotIfFree(deps, project, next);
  }
}
