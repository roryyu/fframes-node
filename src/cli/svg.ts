/**
 * `svg` — print a frame as SVG after conversion.
 *
 * Port of `fn svg` in `.source/fframes/fframes/src/renderer/cli.rs:785-809`.
 *
 * Rust's `previewer.svg(frame)` returns the tree *after* the text has been laid out and the styles
 * resolved, which is a real conversion step (`usvgr::Tree` → string). This port has no layout
 * engine (`text_fit` / `text_break_lines` are out of scope, contract §1), so what it prints is
 * the markup `renderFrame` produced with the scenes already concatenated — the same bytes the
 * renderer rasterizes. That difference is recorded in DELIVERY.md and PORTING.md.
 */

import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

import { renderFrameSvg } from '../render/resvg-backend.ts';
import type { RenderSession } from '../render/resvg-backend.ts';
import type { CliIo } from './args.ts';
import { printReport } from './args.ts';
import { ensureParent } from './render.ts';

export const SVG_SPECS = [
  { name: 'at', kind: 'string', help: 'The frame to print, e.g. Intro@1.5s.' },
  { name: 'output', kind: 'string', short: 'o', help: 'Write to a file instead of stdout.' },
] as const;

/** The SVG of one frame, plus the frame it came from. */
export function frameSvg(session: RenderSession, frame: number): string {
  return renderFrameSvg(session, frame);
}

/** The `svg` command. */
export function svgCommand(
  session: RenderSession,
  options: {
    readonly spec: string;
    readonly frame: number;
    readonly output?: string | null;
    readonly json: boolean;
    readonly io: CliIo;
  },
): number {
  const svg = frameSvg(session, options.frame);
  const output = options.output ?? null;

  if (output !== null && output !== '') {
    ensureParent(output);
    writeFileSync(output, svg);
    printReport(
      options.io,
      options.json,
      {
        frame: options.frame,
        second: options.frame / session.video.fps,
        output,
        bytes: Buffer.byteLength(svg),
      },
      () => output,
    );
    return 0;
  }

  printReport(
    options.io,
    options.json,
    { frame: options.frame, second: options.frame / session.video.fps, svg },
    () => svg,
  );
  return 0;
}
