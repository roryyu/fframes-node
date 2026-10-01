#!/usr/bin/env node
/**
 * The `fframes` command line: one entry point, every command.
 *
 * Port of `Runner::run` in `.source/fframes/fframes/src/renderer/cli.rs:343-433`.
 *
 * ```sh
 * node src/cli/main.ts examples/hello-world/video.ts render -o out.mp4
 * node src/cli/main.ts examples/hello-world/video.ts inspect --every-frame
 * node src/cli/main.ts examples/audio-demo/video.ts audio analyze --json
 * ```
 *
 * ## The argument shape
 *
 * `argv[2]` is the path of a video module, `argv[3]` the command (`render` when absent) and
 * everything after it the flags of that command. The module is loaded with a dynamic `import` of
 * its `file://` URL, and its default export is either a `Video` or a factory returning one (a
 * promise is allowed), which is what lets a video build itself from its own flags.
 *
 * ## The exit codes
 *
 * `0` on success, `1` on a usage or runtime failure (the message goes to stderr, prefixed with
 * `error: `), and `2` when `inspect` found something at `--exit-code` severity. `run` **returns**
 * the code instead of calling `process.exit`, so a caller (and a test) can read it;
 * `runCli` is the wrapper that also sets `process.exitCode`.
 *
 * ## Direct execution, and why `index.ts` does not re-export this file
 *
 * `run` is exported so `examples/hello-world/main.ts` can build an argv and call it. Node 24 has no
 * `import.meta.main`, so the check compares `process.argv[1]` with this file's own path — the
 * approach the contract asks for.
 *
 * The trailing `await runCli()` is what keeps the process alive for a render (ffmpeg is a child
 * process and the frame loop is async). That top-level await is also why `src/index.ts` must not
 * re-export this module: a video module imports `index.ts` for its public API, and `loadVideo`
 * imports the video module, so re-exporting here closes a cycle that leaves `index.ts` permanently
 * unevaluated. `index.ts` carries the full explanation at its end.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRenderSession } from '../render/resvg-backend.ts';
import type { PipelineOptions, RenderSession } from '../render/resvg-backend.ts';
import { MediaDirectory } from '../media/media-dir.ts';
import { TimeSpecResolveError } from '../core/time-spec.ts';
import type { FrameRange } from '../core/time-spec.ts';
import type { Video } from '../core/types.ts';
import {
  globalSpecs,
  helpText,
  parseArgs,
  printError,
  processIo,
  TIME_SPECS_HELP,
  UsageError,
} from './args.ts';
import type { ArgSpec, CliIo, ParsedArgs } from './args.ts';
import { defaultOutputFor, RENDER_SPECS, renderText, renderVideo } from './render.ts';
import { frameCommand, FRAME_SPECS } from './frame.ts';
import { svgCommand, SVG_SPECS } from './svg.ts';
import { timelineCommand } from './timeline.ts';
import { inspectCommand, INSPECT_SPECS, parseExitSeverity } from './inspect.ts';
import {
  audioAnalyzeCommand,
  audioAtCommand,
  audioRenderCommand,
  AUDIO_SPECS,
  defaultAudioOutput,
} from './audio-cmd.ts';

/**
 * The commands of contract §3.
 *
 * Each one is the global options (`--json`, `--scale`, `--media-dir`, `--help`) plus its own, so a
 * flag that every command understands is declared once.
 */
const COMMAND_SPECS = {
  render: RENDER_SPECS,
  frame: FRAME_SPECS,
  svg: SVG_SPECS,
  timeline: [],
  inspect: INSPECT_SPECS,
  audio: AUDIO_SPECS,
} as const satisfies Record<string, readonly ArgSpec[]>;

export type CommandName = keyof typeof COMMAND_SPECS;

const COMMANDS: Record<string, readonly ArgSpec[]> = Object.fromEntries(
  Object.entries(COMMAND_SPECS).map(([name, specs]) => [name, [...globalSpecs(), ...specs]]),
);

/**
 * The usage tail of each command, appended to the command name in `helpText`. Kept next to
 * {@link COMMAND_SUMMARY} so the two tables cannot drift apart.
 */
const commandHelp: Record<CommandName, string> = {
  render: '[RANGE] [-o out.mp4] [--draft]',
  frame: '<spec...> [-o dir] [--svg]',
  svg: '<spec> [-o file.svg]',
  timeline: '',
  inspect: '[RANGE] [--every-frame] [--distance n]',
  audio: 'render [-o out.wav] | analyze | at <spec...>',
};

/** How often `render` reports progress on stderr. */
const PROGRESS_EVERY = 10;

/** What `run` needs beyond `process.argv`. */
export interface CliOptions {
  /** The `CliIo` to report through; `processIo` by default. */
  readonly io?: CliIo;
  /** Working directory the module path is resolved against; `process.cwd()` by default. */
  readonly cwd?: string;
}

/** What each command does, one line each, for {@link USAGE}. */
const COMMAND_SUMMARY: Record<CommandName, string> = {
  render: 'render the video, or a range of it (default)',
  frame: 'render single frames to PNG and report what is wrong with them',
  svg: 'print a frame as SVG',
  timeline: 'scenes, duration and audio tracks',
  inspect: 'check for missing media, fonts and empty frames',
  audio: 'render (WAV), analyze (LUFS, peaks) or at (which track plays when)',
};

/** The usage text: the commands plus the `TIME_SPECS` table of `cli.rs:33-41`. */
export const USAGE = [
  'Usage: fframes <video.ts> [command] [options]',
  '',
  'Commands:',
  ...Object.entries(COMMAND_SUMMARY).map(
    ([name, text]) => `  ${name.padEnd(9)}  ${text}`,
  ),
  '',
  TIME_SPECS_HELP,
].join('\n');

/** A video module's default export: a `Video`, or a factory producing one. */
export type VideoExport = Video | (() => Video | Promise<Video>);

/** Whether an object satisfies the `Video` contract, structurally. */
function isVideo(value: unknown): value is Video {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Video>;
  return (
    typeof candidate.fps === 'number' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.duration === 'function' &&
    typeof candidate.audio === 'function' &&
    typeof candidate.renderFrame === 'function'
  );
}

/**
 * Loads the video module and returns its `Video`.
 *
 * The path is resolved against `cwd` and imported through its `file://` URL, which is what makes
 * a relative path work the same as in `cli::new(&video, …)`.
 */
export async function loadVideo(modulePath: string, cwd: string = process.cwd()): Promise<Video> {
  const absolute = isAbsolute(modulePath) ? modulePath : resolvePath(cwd, modulePath);
  const url = pathToFileURL(absolute).href;

  let imported: unknown;
  try {
    imported = await import(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`can not load "${modulePath}": ${message}`);
  }

  const module = imported as { default?: unknown };
  if (module.default === undefined) {
    throw new UsageError(`"${modulePath}" has no default export`);
  }

  const exported = module.default;
  if (isVideo(exported)) {
    return exported;
  }
  if (typeof exported === 'function') {
    const produced: unknown = await (exported as () => Video | Promise<Video>)();
    if (isVideo(produced)) {
      return produced;
    }
    throw new UsageError(
      `the factory in "${modulePath}" returned ${typeof produced}, expected a Video`,
    );
  }
  throw new UsageError(
    `the default export of "${modulePath}" is ${typeof exported}, expected a Video or a factory`,
  );
}

/**
 * The media directory of a module: `--media-dir`, or a `media` folder next to the module.
 *
 * The Rust examples embed their media with `include_media_dir!`; a Node module has no build step,
 * so the convention is a sibling folder. A `media` folder that does not exist is `null` rather
 * than an error — a video with no media is normal.
 */
export function mediaDirFor(
  modulePath: string,
  cwd: string = process.cwd(),
  override?: string | null,
): MediaDirectory | null {
  if (override !== undefined && override !== null && override !== '') {
    return new MediaDirectory(isAbsolute(override) ? override : resolvePath(cwd, override));
  }
  const absolute = isAbsolute(modulePath) ? modulePath : resolvePath(cwd, modulePath);
  const dir = resolvePath(dirname(absolute), 'media');
  return existsSync(dir) ? new MediaDirectory(dir) : null;
}

/** `--scale`, with `--draft` halving unless a scale was given (`cli.rs:568-571`). */
export function resolveScale(args: ParsedArgs): number {
  const scale = args.number('scale');
  if (scale !== undefined && Number.isFinite(scale) && scale > 0) {
    return scale;
  }
  return args.boolean('draft') ? 0.5 : 1;
}

/** Resolves a range spec, or the whole video when there is none. */
export function resolveRange(session: RenderSession, spec: string | undefined): FrameRange {
  if (spec === undefined || spec === '') {
    return session.index.fullRange();
  }
  try {
    return session.index.resolveRange(spec);
  } catch (error) {
    if (error instanceof TimeSpecResolveError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

/** Splits `--at 1s,50%,Intro@end` (and the space separated form) into specs. */
export function splitSpecs(values: readonly string[], positionals: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of [...values, ...positionals]) {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '') {
        out.push(trimmed);
      }
    }
  }
  return out;
}

/** Resolves a list of point specs to frames, with the Rust error message on a bad one. */
export function resolveSpecs(session: RenderSession, specs: readonly string[]): { spec: string; frame: number }[] {
  return specs.map((spec) => {
    try {
      return { spec, frame: session.index.resolveFrame(spec) };
    } catch (error) {
      if (error instanceof TimeSpecResolveError) {
        throw new UsageError(error.message);
      }
      throw error;
    }
  });
}

/** The options the session is built with, shared by every command. */
function pipelineOptions(
  video: Video,
  args: ParsedArgs,
  mediaDir: MediaDirectory | null,
): PipelineOptions {
  return {
    fps: video.fps,
    width: video.width,
    height: video.height,
    scale: resolveScale(args),
    mediaDir,
  };
}

/** `render` — the whole video, or `--frame-range`. */
async function commandRender(
  session: RenderSession,
  args: ParsedArgs,
  io: CliIo,
  video: Video,
): Promise<number> {
  const range = resolveRange(session, args.string('frame-range') ?? args.positionals[0]);
  const output = args.string('output') ?? defaultOutputFor(video);
  const draft = args.boolean('draft');

  const report = await renderVideo(session, {
    range,
    output,
    draft,
    scale: resolveScale(args),
    crf: args.number('crf'),
    preset: args.string('preset'),
    floatAudio: args.boolean('float-audio'),
    onProgress: (frame, total) => {
      // Progress belongs on stderr (contract §6) and is throttled: a 10 s video is 300 frames, and
      // one line per frame buries everything else.
      //
      // `onProgress` is fed by `encodeVideo` with `written` already incremented
      // (`ffmpeg-encoder.ts:250-251`), and `renderVideo` forwards `range.start + written`, so `frame`
      // is the 1-based count of frames written: the count of frames done is `frame - range.start`,
      // with no second `+ 1`. The old double count made the first frame report `2/N`, fired the
      // `done === total` line one frame early, never printed `N/N`, and printed nothing at all for a
      // single frame render.
      const done = frame - range.start;
      if (total > 0 && (done === total || done % PROGRESS_EVERY === 0)) {
        io.err(`rendered ${done}/${total} frames`);
      }
    },
  });

  const json = args.boolean('json');
  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(renderText(report));
    for (const file of report.missingAudioFiles) {
      io.err(`warning: audio "${file}" is not in the media directory`);
    }
  }
  return 0;
}

/** `frame` — the frames named by the positional specs. */
async function commandFrame(session: RenderSession, args: ParsedArgs, io: CliIo): Promise<number> {
  const specs = splitSpecs(args.strings('at'), args.positionals);
  if (specs.length === 0) {
    throw new UsageError('frame needs at least one time spec, e.g. `frame 1s,50%`');
  }
  return frameCommand(session, {
    specs: resolveSpecs(session, specs),
    dir: args.string('output') ?? '.',
    svg: args.boolean('svg'),
    json: args.boolean('json'),
    io,
  });
}

/** `svg` — one frame as SVG. */
function commandSvg(session: RenderSession, args: ParsedArgs, io: CliIo): number {
  const specs = splitSpecs(args.strings('at'), args.positionals);
  if (specs.length === 0) {
    throw new UsageError('svg needs a time spec, e.g. `svg 1.5s`');
  }
  const [{ spec, frame }] = resolveSpecs(session, specs);
  return svgCommand(session, {
    spec,
    frame,
    output: args.string('output') ?? null,
    json: args.boolean('json'),
    io,
  });
}

/** `timeline` — the structure of the video. */
function commandTimeline(session: RenderSession, args: ParsedArgs, io: CliIo): number {
  return timelineCommand(session, { json: args.boolean('json'), io });
}

/** `inspect` — the problems, and exit code 2 when one is severe enough. */
function commandInspect(session: RenderSession, args: ParsedArgs, io: CliIo): number {
  return inspectCommand(session, {
    range: resolveRange(session, args.string('frame-range') ?? args.positionals[0]),
    everyFrame: args.boolean('every-frame'),
    distance: args.number('distance'),
    exitSeverity: parseExitSeverity(args.string('exit-code')),
    info: args.boolean('info'),
    checkEmpty: !args.boolean('no-empty-check'),
    json: args.boolean('json'),
    io,
  });
}

/** `audio render | analyze | at` — the subcommand decides. */
async function commandAudio(
  session: RenderSession,
  args: ParsedArgs,
  io: CliIo,
  video: Video,
): Promise<number> {
  const sub = args.positionals[0];
  const range = resolveRange(session, args.string('frame-range'));
  const json = args.boolean('json');

  if (sub === undefined || sub === 'render') {
    return audioRenderCommand(session, {
      range,
      // The default mix path follows the video's own output: `out.mp4` mixes to `out.wav`
      // (contract §3), which `defaultAudioOutput` derives from `video.defaultOutput`.
      output: args.string('output') ?? defaultAudioOutput(video.defaultOutput),
      float: args.boolean('float'),
      json,
      io,
    });
  }

  if (sub === 'analyze') {
    if (args.has('waveform')) {
      throw new UsageError('analyze --waveform is not part of this port (see PORTING.md)');
    }
    return audioAnalyzeCommand(session, { range, json, io });
  }

  if (sub === 'at') {
    const specs = splitSpecs(args.strings('at'), args.positionals.slice(1));
    if (specs.length === 0) {
      throw new UsageError('audio at needs at least one time spec, e.g. `audio at 4.2s`');
    }
    return audioAtCommand(session, { specs: resolveSpecs(session, specs), json, io });
  }

  throw new UsageError(
    `unknown audio subcommand "${sub}", expected render, analyze or at`,
  );
}

/**
 * `run` — the whole command line.
 *
 * ```ts
 * process.exitCode = await run(process.argv);
 * ```
 *
 * `argv` is the full `process.argv` (or `['node', 'fframes', 'video.ts', …]`): the video module
 * is `argv[2]`, the command `argv[3]`.
 */
export async function run(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  const cwd = options.cwd ?? process.cwd();

  const modulePath = argv[2];
  if (modulePath === undefined || modulePath === '' || modulePath === '--help' || modulePath === '-h') {
    // No video named: printing the usage *is* the help, and asking for it explicitly is not an
    // error, so only the bare invocation is a failure (contract §6: a usage error exits 1).
    io.err(USAGE);
    return modulePath === undefined || modulePath === '' ? 1 : 0;
  }

  const requested = argv[3] ?? 'render';
  if (requested === '--help' || requested === '-h' || requested === 'help') {
    io.err(USAGE);
    return 0;
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, requested)) {
    throw new UsageError(
      `unknown command "${requested}", expected one of ${Object.keys(COMMANDS).join(', ')}`,
    );
  }
  const command = requested as CommandName;

  const args = parseArgs(argv.slice(4), COMMANDS[command]);
  if (args.boolean('help')) {
    // The command's own options plus the time spec table, not the whole usage: `fframes <video.ts>
    // render --help` should describe `render`. The video module is not loaded for `--help`, so this
    // works before anything is resolved.
    io.err(helpText(commandHelp[command], COMMANDS[command], TIME_SPECS_HELP));
    return 0;
  }

  const video = await loadVideo(modulePath, cwd);
  const mediaDir = mediaDirFor(modulePath, cwd, args.string('media-dir'));
  const session = createRenderSession(video, pipelineOptions(video, args, mediaDir));

  // The audio map may name files the media directory does not have. That is a finding for
  // `inspect`, not a reason to refuse the other commands, so it is surfaced here as a warning and
  // the reason itself stays on the session for `inspect` to report.
  if (session.audioResolveError !== null) {
    io.err(`warning: ${session.audioResolveError}`);
  }

  switch (command) {
    case 'render':
      return commandRender(session, args, io, video);
    case 'frame':
      return commandFrame(session, args, io);
    case 'svg':
      return commandSvg(session, args, io);
    case 'timeline':
      return commandTimeline(session, args, io);
    case 'inspect':
      return commandInspect(session, args, io);
    case 'audio':
      return commandAudio(session, args, io, video);
    default:
      // Unreachable: the command was checked against COMMANDS above. Kept so the return type is
      // provable without relying on the exhaustiveness of the switch.
      throw new UsageError(`unknown command "${String(command)}"`);
  }
}

/**
 * `runCli` — {@link run} with the exit code applied, and every failure reported as
 * `error: <message>` on stderr with code 1.
 */
export async function runCli(argv: readonly string[] = process.argv, options: CliOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  const json = argv.includes('--json');

  try {
    const code = await run(argv, options);
    process.exitCode = code;
    return code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      io.out(JSON.stringify({ error: message }));
    } else {
      printError(io, message);
    }
    process.exitCode = 1;
    return 1;
  }
}

/** This file's own path, for the direct execution check. */
const thisFile = fileURLToPath(import.meta.url);

/**
 * Whether this module is the entry point.
 *
 * Node 24 has no `import.meta.main`, so this compares `process.argv[1]` with this file's own path,
 * which is the approach the contract asks for (§3, `examples/hello-world/main.ts`).
 *
 * `realpathSync` is applied to both sides because `argv[1]` is whatever the caller typed: a
 * symlinked `bin/fframes` or a path through `/tmp` on macOS would otherwise not compare equal and
 * the CLI would silently do nothing when invoked through a link.
 */
export function isEntryPoint(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (entry === undefined) {
    return false;
  }
  return sameFile(entry, thisFile);
}

function sameFile(a: string, b: string): boolean {
  if (resolvePath(a) === resolvePath(b)) {
    return true;
  }
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Direct execution.
 *
 * The `await` is top level so the process stays alive for the whole render (ffmpeg is a child
 * process, and the frame loop is async). `src/index.ts` deliberately does **not** re-export this
 * module: that would close a cycle through the dynamic import in {@link loadVideo} and deadlock the
 * direct-execution path. See the comment at the end of `src/index.ts`.
 */
if (isEntryPoint()) {
  await runCli();
}
