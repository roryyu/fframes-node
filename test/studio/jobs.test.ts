/**
 * `jobs.test.ts` — the single slot render queue (`page.md` §5.7).
 *
 * The subject is the **queue**, not the encoder: one job at a time, the `queued → running → done`
 * state machine, the `progress` / `done` / `error` event order, and the artefact path and URL. So
 * `buildSession` and `render` are injected. The fake `render` reports progress frame by frame and
 * writes a placeholder file at the path it was handed, which is enough to check that the job named
 * the artefact `out/<jobId>.mp4` and published `/media/<projectId>/out/<jobId>.mp4` — while keeping the
 * test to milliseconds and off ffmpeg. The real encode path is what the gate's S10/S11 exercise.
 *
 * The serialisation assertion is a real one, not a timing coincidence: the fake render records how
 * many renders were in flight at every entry and the status of every other job at that moment, so
 * "two jobs were never `running` at once" is checked against the queue's own bookkeeping.
 *
 * The projects live inside the repository (`.studio/test-*`, gitignored, removed by `t.after`)
 * because the canonical import specifier `'../../../src/index.ts'` only resolves three levels below
 * the repo root (§5.5, decision D4).
 */

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { AudioMap, createRenderSession, seconds, svgr } from '../../src/index.ts';
import type { FFramesContext, Frame, RenderSession, Svgr, Video } from '../../src/index.ts';
import { REPO_ROOT, loadConfig } from '../../src/studio/config.ts';
import type { StudioConfig } from '../../src/studio/config.ts';
import { getJob, submitRender, subscribe } from '../../src/studio/jobs.ts';
import type { JobDependencies, JobEvent } from '../../src/studio/jobs.ts';
import { PROJECT_OUT_DIR, createProject } from '../../src/studio/projects.ts';
import type { Project, RenderJob, RenderReport } from '../../src/studio/types.ts';

/** Frames the fake render "encodes", so the 10 frame throttle has something to throttle. */
const FRAMES = 25;

/** A config whose `projectsRoot` is a throwaway directory inside `.studio/`, plus a project in it. */
function workspace(t: TestContext): { cfg: StudioConfig; project: Project } {
  const projectsRoot = join(REPO_ROOT, '.studio', `test-${randomBytes(4).toString('hex')}`);
  t.after(() => rmSync(projectsRoot, { recursive: true, force: true }));
  const cfg = Object.freeze({
    ...loadConfig({
      LLM_BASE_URL: 'https://mock.invalid/v1',
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_MODEL: 'mock-code-model',
      LLM_MOCK_DIR: '',
    }),
    repoRoot: REPO_ROOT,
    projectsRoot,
  });
  return { cfg, project: createProject(cfg) };
}

/** A 32x18, 1 s video, built in memory: the queue never needs it on disk. */
function fakeVideo(): Video {
  return {
    fps: 30,
    width: 32,
    height: 18,
    duration: () => seconds(1),
    audio: () => AudioMap.none(),
    defineScenes: () => null,
    fonts: () => [],
    renderFrame: (_frame: Frame, _ctx: FFramesContext): Svgr =>
      svgr`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"><rect width="32" height="18" fill="#123456" /></svg>`,
  };
}

function fakeSession(): Promise<RenderSession> {
  const video = fakeVideo();
  return Promise.resolve(
    createRenderSession(video, { fps: video.fps, width: video.width, height: video.height }),
  );
}

/** A `RenderReport` shaped exactly like `cli/render.ts`'s, for `frames: {start, end}`. */
function fakeReport(output: string): RenderReport {
  return {
    output,
    frames: { start: 0, end: FRAMES },
    startSeconds: 0,
    endSeconds: FRAMES / 30,
    seconds: FRAMES / 30,
    width: 32,
    height: 18,
    fps: 30,
    audio: false,
    missingAudioFiles: [],
    elapsedSeconds: 0.01,
  };
}

/** What the fake render saw, so the test can assert on the queue instead of on wall clock time. */
interface Observation {
  readonly jobId: string;
  /** Every job's status at the moment this render started. */
  readonly statusesAtEntry: Readonly<Record<string, string>>;
  /** How many renders were in flight when this one started. */
  readonly inFlightAtEntry: number;
}

interface Harness {
  readonly deps: JobDependencies;
  readonly observations: Observation[];
  readonly outputs: string[];
}

/**
 * A queue whose `render` is fake: it reports `FRAMES` progress steps with a small await between them
 * (so a second job *would* overlap if the queue let it), writes a placeholder at the path it was
 * given, and returns a report. `known` is the set of job ids the test is watching, so the status
 * snapshot at entry covers the jobs that are queued behind this one.
 */
function harness(cfg: StudioConfig, known: () => readonly string[], fail = false): Harness {
  const observations: Observation[] = [];
  const outputs: string[] = [];
  let inFlight = 0;
  return {
    observations,
    outputs,
    deps: {
      cfg,
      buildSession: fakeSession,
      render: async (_session, options) => {
        const jobId = basename(options.output, '.mp4');
        inFlight += 1;
        try {
          observations.push({
            jobId,
            statusesAtEntry: Object.fromEntries(
              known().map((id) => [id, getJob(id)?.status ?? 'unknown']),
            ),
            inFlightAtEntry: inFlight,
          });
          for (let done = 1; done <= FRAMES; done += 1) {
            options.onProgress?.({ done, total: FRAMES, frame: done - 1 });
            await sleep(1);
          }
          if (fail) {
            throw new Error('ffmpeg died: the fake encoder refuses this job');
          }
          writeFileSync(options.output, 'not really an mp4');
          outputs.push(options.output);
          return fakeReport(options.output);
        } finally {
          inFlight -= 1;
        }
      },
    },
  };
}

/** Waits for a job to reach a terminal state, so a test never leaves work running. */
async function terminal(jobId: string, timeoutMs = 20_000): Promise<RenderJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getJob(jobId);
    assert.ok(job !== undefined, `job "${jobId}" disappeared from the queue`);
    if (job.status === 'done' || job.status === 'error') {
      return job;
    }
    assert.ok(Date.now() < deadline, `job "${jobId}" was still ${job.status} after ${timeoutMs}ms`);
    await sleep(5);
  }
}

// ---------------------------------------------------------------------------
// the queue
// ---------------------------------------------------------------------------

test('two jobs are never rendering at the same time', async (t) => {
  const { cfg, project } = workspace(t);
  const known: string[] = [];
  const fake = harness(cfg, () => known);

  const first = submitRender(fake.deps, { projectId: project.id, draft: true });
  known.push(first.id);
  const second = submitRender(fake.deps, { projectId: project.id, draft: true });
  known.push(second.id);

  // Both return immediately and both are `queued`: the caller needs the id before anything ran.
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.notEqual(first.id, second.id);
  assert.equal(first.projectId, project.id);
  assert.deepEqual(first.progress, { done: 0, total: 0 });

  const [firstDone, secondDone] = await Promise.all([terminal(first.id), terminal(second.id)]);
  assert.equal(firstDone.status, 'done');
  assert.equal(secondDone.status, 'done');

  // The invariant: at most one render in flight, and the second job was still queued when the first
  // one started. This is the whole point of the single slot.
  assert.equal(fake.observations.length, 2, 'both jobs rendered');
  assert.equal(Math.max(...fake.observations.map((entry) => entry.inFlightAtEntry)), 1);
  assert.equal(fake.observations[0]?.statusesAtEntry[first.id], 'running');
  assert.equal(fake.observations[0]?.statusesAtEntry[second.id], 'queued');
  assert.equal(fake.observations[1]?.statusesAtEntry[second.id], 'running');
  for (const entry of fake.observations) {
    assert.equal(entry.statusesAtEntry[entry.jobId], 'running', 'a job is running while it renders');
  }
  // FIFO: the first submission is the first render.
  assert.deepEqual(
    fake.observations.map((entry) => entry.jobId),
    [first.id, second.id],
  );
});

test('a finished job reports the state machine and its artefact', async (t) => {
  const { cfg, project } = workspace(t);
  const fake = harness(cfg, () => []);
  const job = submitRender(fake.deps, { projectId: project.id, draft: true });
  const done = await terminal(job.id);

  assert.equal(done.id, job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.error, undefined);
  assert.ok(done.report !== undefined, 'a done job carries its report');
  assert.equal(done.outputUrl, `/media/${project.id}/${PROJECT_OUT_DIR}/${job.id}.mp4`);
  // The snapshot the SSE route and `GET /api/render/:jobId` serve is frozen.
  assert.throws(() => {
    (done as { status: string }).status = 'error';
  });

  const artefact = join(project.dir, PROJECT_OUT_DIR, `${job.id}.mp4`);
  assert.equal(done.report?.output, artefact, 'the artefact is out/<jobId>.mp4');
  assert.equal(existsSync(artefact), true, 'the render wrote its file where the URL points');
  assert.deepEqual(fake.outputs, [artefact]);
  // Progress ended at the frame count the report describes.
  assert.equal(done.progress.done, FRAMES);
  assert.equal(done.progress.total, FRAMES);
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

test('a subscriber sees throttled progress and then done', async (t) => {
  const { cfg, project } = workspace(t);
  const fake = harness(cfg, () => []);
  const job = submitRender(fake.deps, { projectId: project.id });

  // Subscribed right after submitRender, i.e. before the first progress callback can run.
  const events: JobEvent[] = [];
  const unsubscribe = subscribe(job.id, (event) => events.push(event), { replayCurrent: true });
  await terminal(job.id);
  unsubscribe();

  const types = events.map((event) => event.type);
  assert.ok(types.includes('progress'), `expected a progress event, got ${types.join(',')}`);
  assert.equal(types[types.length - 1], 'done', 'done is the last event of a successful render');
  assert.ok(
    types.indexOf('done') === types.length - 1 && types.indexOf('progress') < types.indexOf('done'),
    `progress must precede done, got ${types.join(',')}`,
  );

  // Throttled to every 10 frames plus the last one: 25 frames → 10, 20, 25.
  const progress = events.filter((event): event is Extract<JobEvent, { type: 'progress' }> =>
    event.type === 'progress',
  );
  assert.deepEqual(
    progress.map((event) => event.done),
    [10, 20, 25],
  );
  for (const event of progress) {
    assert.equal(event.total, FRAMES);
  }

  const finished = events.find((event): event is Extract<JobEvent, { type: 'done' }> => event.type === 'done');
  assert.ok(finished !== undefined);
  assert.equal(finished.outputUrl, `/media/${project.id}/${PROJECT_OUT_DIR}/${job.id}.mp4`);
  assert.equal(finished.report.frames.end, FRAMES);

  // A second subscriber to the same finished job still works: `subscribe` is not one-shot, and the
  // job snapshot outlives every listener.
  const alsoDone: JobEvent[] = [];
  const stop = subscribe(job.id, (event) => alsoDone.push(event), { replayCurrent: true });
  assert.deepEqual(
    alsoDone.map((event) => event.type),
    ['done'],
    'a late subscriber is replayed the ending',
  );
  stop();
  assert.equal(getJob(job.id)?.status, 'done', 'the snapshot outlives the listeners');
});

test('a late subscriber is replayed the ending instead of hanging', async (t) => {
  const { cfg, project } = workspace(t);
  const fake = harness(cfg, () => []);
  const job = submitRender(fake.deps, { projectId: project.id });
  await terminal(job.id);

  // This is the EventSource that connects after the render finished, and the reconnect after a
  // dropped connection: it must see `done` immediately, not wait for an event that already passed.
  const replayed: JobEvent[] = [];
  const unsubscribe = subscribe(job.id, (event) => replayed.push(event), { replayCurrent: true });
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]?.type, 'done');
  unsubscribe();

  // Without the opt in, a subscription to a finished job is silent.
  const silent: JobEvent[] = [];
  const stop = subscribe(job.id, (event) => silent.push(event));
  assert.deepEqual(silent, []);
  stop();
});

test('a render that fails is an error event with a message and no stack', async (t) => {
  const { cfg, project } = workspace(t);
  const fake = harness(cfg, () => [], true);
  const job = submitRender(fake.deps, { projectId: project.id });

  const events: JobEvent[] = [];
  subscribe(job.id, (event) => events.push(event), { replayCurrent: true });
  const failed = await terminal(job.id);

  assert.equal(failed.status, 'error');
  assert.equal(failed.report, undefined);
  assert.equal(failed.outputUrl, undefined);
  assert.ok(failed.error !== undefined, 'an error job says why');
  assert.match(failed.error, /ffmpeg died/);
  assert.ok(!/\n\s+at /.test(failed.error), `a message, not a stack: ${failed.error}`);

  const last = events[events.length - 1];
  assert.equal(last?.type, 'error');
  assert.equal(
    (last as Extract<JobEvent, { type: 'error' }>).message,
    failed.error,
    'the event carries the same message as the snapshot',
  );
  // Nothing was written, so no half finished artefact is advertised.
  assert.equal(existsSync(join(project.dir, PROJECT_OUT_DIR, `${job.id}.mp4`)), false);
  assert.deepEqual(fake.outputs, []);
});

test('an unknown job id is unknown, not an error', () => {
  assert.equal(getJob('job-does-not-exist'), undefined);
});

test('submitRender refuses a project that does not exist', async (t) => {
  const { cfg } = workspace(t);
  const fake = harness(cfg, () => []);
  assert.throws(
    () => submitRender(fake.deps, { projectId: 'p-not-a-project' }),
    /does not exist/,
  );
  assert.throws(() => submitRender(fake.deps, { projectId: '../../etc' }), /not a project id/);
});
