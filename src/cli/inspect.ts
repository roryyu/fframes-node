/**
 * `inspect` — check the video for problems without watching it.
 *
 * Port of `fn inspect` in `.source/fframes/fframes/src/renderer/cli.rs:894-1001`; the checks
 * themselves live in `inspect/diagnostics.ts`.
 *
 * The Rust flags are `--every 0.25s`, `--all-frames`, `--info` and `--fail-on`. The contract's
 * flags are `--every-frame`, `--distance <frames>`, `--exit-code` and `--json`, and this port
 * follows the contract: the sampling distance is a **frame count** rather than a duration, which
 * is unambiguous at any fps.
 *
 * The exit code is the point of the command: `2` when a finding reached `--exit-code`, so a render
 * pipeline can gate on it. `--exit-code` also accepts `warning` and `info`, where Rust's
 * `--fail-on` has `Never` instead of `info` (`cli.rs:181-185`) — `info` is the useful third step
 * here, and "never" is what you get by leaving the findings out of the comparison.
 *
 * `--no-empty-check` is this port's addition: the `empty-frame` check rasterizes every sampled
 * frame, so a long video is noticeably slower with it on. It is a check, not a rendering step, so
 * turning it off does not change what is reported beyond that one kind.
 */

import { inspectVideoDetailed } from '../inspect/diagnostics.ts';
import type { ExitSeverity, MergedFinding } from '../inspect/diagnostics.ts';
import type { RenderSession } from '../render/resvg-backend.ts';
import type { FrameRange } from '../core/time-spec.ts';
import type { ArgSpec, CliIo } from './args.ts';
import { printReport } from './args.ts';

export const INSPECT_SPECS: readonly ArgSpec[] = [
  { name: 'frame-range', kind: 'string', help: 'Range to check, all of it by default.' },
  { name: 'every-frame', kind: 'boolean', help: 'Check every single frame.' },
  { name: 'distance', kind: 'number', help: 'Frames between checks, 30 by default.' },
  { name: 'exit-code', kind: 'string', help: 'Severity that fails: error, warning or info.' },
  { name: 'info', kind: 'boolean', help: 'Report informational findings too.' },
  { name: 'no-empty-check', kind: 'boolean', help: 'Skip the fully transparent frame check.' },
];

/**
 * Parses `--exit-code`, falling back to the Rust default (`error`).
 *
 * An unrecognized value is `error` rather than an error of its own: the flag decides how loudly the
 * run fails, and failing *more* quietly on a typo would be the worse default. `--json` still shows
 * every finding, so a mistyped value is visible in the report.
 */
export function parseExitSeverity(value: string | undefined): ExitSeverity {
  if (value === 'warning') {
    return 'warning';
  }
  if (value === 'info') {
    return 'info';
  }
  return 'error';
}

/** The `--json` document of `InspectResult` (`cli.rs:888-892`) with the merged fields. */
export interface InspectJsonReport {
  readonly checkedFrames: number;
  readonly exitCode: number;
  readonly findings: MergedFinding[];
}

/**
 * The human report of `cli.rs:972-994`: how many frames were checked, then one line per finding
 * with its severity, time span, frame span, how many frames saw it, the scenes and the message.
 */
export function inspectText(checkedFrames: number, findings: readonly MergedFinding[]): string {
  let text = `checked ${checkedFrames} frames: `;
  text += findings.length === 0 ? 'no problems found' : `${findings.length} findings`;

  for (const finding of findings) {
    const scenes = finding.scenes.length === 0 ? '' : ` [${finding.scenes.join(' + ')}]`;
    text +=
      `\n${finding.severity} ${finding.firstSeconds.toFixed(2)}s..${finding.lastSeconds.toFixed(2)}s ` +
      `(frames ${finding.firstFrame}..${finding.lastFrame}, seen in ${finding.seenIn})${scenes}: ` +
      `${finding.message}`;
  }
  return text;
}

/**
 * The `inspect` command.
 *
 * Returns the exit code instead of setting it, so `run` in `main.ts` decides what to do with it and
 * a caller can read the number without a process. `runCli` writes it to `process.exitCode` last,
 * which also lets the report reach stdout first.
 */
export function inspectCommand(
  session: RenderSession,
  options: {
    readonly range: FrameRange;
    readonly everyFrame?: boolean;
    readonly distance?: number;
    readonly exitSeverity?: ExitSeverity;
    readonly info?: boolean;
    readonly checkEmpty?: boolean;
    readonly json: boolean;
    readonly io: CliIo;
  },
): number {
  const result = inspectVideoDetailed(session, {
    range: options.range,
    everyFrame: options.everyFrame,
    distance: options.distance,
    exitSeverity: options.exitSeverity,
    info: options.info,
    checkEmpty: options.checkEmpty,
  });

  printReport(
    options.io,
    options.json,
    {
      checkedFrames: result.checkedFrames,
      exitCode: result.exitCode,
      findings: result.findings,
    },
    () => inspectText(result.checkedFrames, result.findings),
  );

  return result.exitCode;
}
