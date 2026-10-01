/**
 * `frame` — render single frames to PNG and report what was found in them.
 *
 * Port of `fn frame` in `.source/fframes/fframes/src/renderer/cli.rs:618-666`.
 *
 * The Rust command also writes the converted SVG next to every PNG (`--svg`); this port keeps
 * `--svg` and adds the per frame findings of `inspect/diagnostics.ts`, so one `frame` call shows
 * both the pixels and the problems with them — which is what the command is for.
 *
 * File names are `frame-<globalIndex>.png` (contract §3) where Rust uses
 * `snapshot::snapshot_name(&spec)`, i.e. a name derived from the spec itself: two specs that
 * resolve to the same frame would collide, and a spec like `Intro@1.2s` is not a file name.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Buffer } from 'node:buffer';

import { inspectFrame } from '../inspect/diagnostics.ts';
import type { RawFinding } from '../inspect/diagnostics.ts';
import { renderFramePng, renderFrameSvg } from '../render/resvg-backend.ts';
import type { RenderSession } from '../render/resvg-backend.ts';
import type { ArgSpec, CliIo } from './args.ts';
import { helpText, printReport, TIME_SPECS_HELP } from './args.ts';

export const FRAME_SPECS: readonly ArgSpec[] = [
  { name: 'at', kind: 'string', help: 'Frames to render, comma or space separated time specs.' },
  { name: 'output', kind: 'string', short: 'o', help: 'Directory for the PNGs, . by default.' },
  { name: 'svg', kind: 'boolean', help: 'Also write the converted SVG next to every PNG.' },
];

/**
 * One rendered frame, the `FrameResult` of `cli.rs:609-616` with the contract's field names.
 *
 * `path` is empty and `bytes` is 0 when `renderFrame` threw: the finding is the report for that
 * spec, and no file was written.
 */
export interface FrameReport {
  readonly spec: string;
  readonly index: number;
  readonly second: number;
  readonly path: string;
  readonly bytes: number;
  readonly svg: string | null;
  readonly scenes: string[];
  readonly findings: readonly RawFinding[];
}

/** The file name of a frame: `frame-<globalIndex>.png`. */
export function frameFileName(globalIndex: number): string {
  return `frame-${globalIndex}.png`;
}

/** The file name of the SVG of a frame. */
export function frameSvgFileName(globalIndex: number): string {
  return `frame-${globalIndex}.svg`;
}

/**
 * Renders the frames named by `specs` into `dir`.
 *
 * ```ts
 * await renderFrames(session, { dir: 'out', specs: ['Intro@1.2s', '50%'] });
 * ```
 */
export async function renderFrames(
  session: RenderSession,
  input: {
    readonly specs: readonly { spec: string; frame: number }[];
    readonly dir: string;
    readonly svg?: boolean;
    readonly check?: boolean;
  },
): Promise<FrameReport[]> {
  mkdirSync(input.dir, { recursive: true });
  const reports: FrameReport[] = [];

  for (const { spec, frame } of input.specs) {
    // A frame whose `renderFrame` throws is exactly what this command is for: report it and keep
    // going, the way `render_frame_guarded` turns a panic into a finding instead of aborting.
    let png: Buffer;
    let svgPath: string | null = null;
    let inspection: { findings: readonly RawFinding[]; scenes: string[] };

    try {
      png = renderFramePng(session, frame);
    } catch (error) {
      reports.push({
        spec,
        index: frame,
        second: frame / session.video.fps,
        path: '',
        bytes: 0,
        svg: null,
        scenes: session.context.scenesAt(frame).map((entry) => entry.name),
        findings: [
          {
            severity: 'error',
            kind: 'render-error',
            message: error instanceof Error ? error.message : String(error),
            key: 'render-error',
          },
        ],
      });
      continue;
    }

    const path = join(input.dir, frameFileName(frame));
    writeFileSync(path, png);

    if (input.svg === true) {
      svgPath = join(input.dir, frameSvgFileName(frame));
      writeFileSync(svgPath, renderFrameSvg(session, frame));
    }

    // The findings of the frame that was just written, so the report matches the PNGs. This is a
    // second `renderFrame` for the frame: one to rasterize, one to inspect. `frame` is a debugging
    // command over a handful of frames, so the duplication is cheaper than threading the SVG
    // through both consumers.
    inspection =
      input.check === false
        ? { findings: [], scenes: session.context.scenesAt(frame).map((entry) => entry.name) }
        : inspectFrame(session, frame, { fontFiles: session.context.fontFiles });

    reports.push({
      spec,
      index: frame,
      second: frame / session.video.fps,
      path,
      bytes: png.length,
      svg: svgPath,
      scenes: inspection.scenes,
      findings: inspection.findings,
    });
  }

  return reports;
}

/** The human report of `cli.rs:646-664`: one line per frame, then its diagnostics indented. */
export function framesText(reports: readonly FrameReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    const label = report.scenes.length === 0 ? '' : ` [${report.scenes.join(' + ')}]`;
    // A frame that threw has no file, so the arrow is only printed when there is one.
    const target = report.path === '' ? '' : ` -> ${report.path}`;
    lines.push(`${report.spec} frame ${report.index} ${report.second.toFixed(2)}s${label}${target}`);
    for (const finding of report.findings) {
      lines.push(`  ${finding.severity}: ${finding.message}`);
    }
  }
  return lines.join('\n');
}

/** The `--json` document, with the paths absolute enough to be opened. */
export function framesJson(reports: readonly FrameReport[]): unknown[] {
  return reports.map((report) => ({
    spec: report.spec,
    index: report.index,
    second: report.second,
    path: report.path,
    bytes: report.bytes,
    svg: report.svg,
    scenes: report.scenes,
    findings: report.findings.map((finding) => ({
      severity: finding.severity,
      kind: finding.kind,
      message: finding.message,
    })),
  }));
}

/** The `frame` command: render, report, return 0. */
export async function frameCommand(
  session: RenderSession,
  options: {
    readonly specs: readonly { spec: string; frame: number }[];
    readonly dir: string;
    readonly svg?: boolean;
    readonly json: boolean;
    readonly io: CliIo;
  },
): Promise<number> {
  // `renderFrames` creates the directory itself, recursively.
  const reports = await renderFrames(session, {
    specs: options.specs,
    dir: options.dir,
    svg: options.svg,
  });
  printReport(options.io, options.json, framesJson(reports), () => framesText(reports));

  // A frame whose `renderFrame` threw is reported as a finding, not as a failure: the command did
  // what it was asked, and the findings are how the caller learns which frame broke. `inspect` is
  // the command that gates on severity, and it sets exit code 2 itself.
  return 0;
}

/**
 * The `frame` help text: its own options plus the time spec table, which this command needs more
 * than any other because its arguments *are* time specs. `main.ts` produces the same text from its
 * own `commandHelp` table, so this is for a caller that wants the help without the whole CLI.
 */
export function frameHelp(): string {
  return helpText('<spec...> [-o dir] [--svg]', FRAME_SPECS, TIME_SPECS_HELP);
}
