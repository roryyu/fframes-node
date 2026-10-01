/**
 * Argument parsing and output for the `fframes` command line.
 *
 * Port of the `clap` derive layer of `.source/fframes/fframes/src/renderer/cli.rs` (the
 * `RenderArgs` / `FrameArgs` / `SvgArgs` / `InspectArgs` / `AudioCommand` structs and the
 * `TIME_SPECS` help text), reduced to what the contract keeps: no `clap`, no sub-`Args` trait for
 * user flags, and only the commands in §3.
 *
 * Three rules the whole CLI follows, from `cli.rs`:
 *
 * - `--json` prints **exactly one** JSON document on stdout, everything else goes to stderr
 *   (`print` in `cli.rs:436`),
 * - a usage or runtime failure prints `error: <message>` on stderr and exits 1 (`cli.rs:422-432`),
 * - the time specs are the ones `core/time-spec.ts` parses, so `--frame-range Intro..Outro` and
 *   `audio at 4.2s` speak the same language as the Rust CLI.
 */

/** How an option consumes a value: no value, a value, or either. */
export type ArgKind = 'boolean' | 'string' | 'number' | 'optional';

/** One declared option. */
export interface ArgSpec {
  /** The long name, without `--`. */
  readonly name: string;
  readonly kind: ArgKind;
  /** A single letter alias, without `-`. */
  readonly short?: string;
  /** The value of a `string` / `number` option that is not given. */
  readonly default?: string | number | boolean;
  /** `Usage: …` line, for `--help`. */
  readonly help?: string;
}

/** The parse result: positionals in order, options by name. */
export interface ParsedArgs {
  /** Positional arguments, in order. */
  readonly positionals: readonly string[];
  /** Option values by long name. */
  readonly values: ReadonlyMap<string, string | number | boolean>;
  /** Whether `--name` was present at all (as a flag or with a value). */
  has(name: string): boolean;
  /** A `string` option, or its default, or `undefined`. */
  string(name: string): string | undefined;
  /** A `number` option, or its default, or `undefined`. */
  number(name: string): number | undefined;
  /** A boolean flag: present as `--name`, or `--name=true` / `--name=false`. */
  boolean(name: string): boolean;
  /** A repeated `string` option (positionals too), in order. */
  strings(name: string): string[];
}

/**
 * A declared option and where its value came from. Kept separate from {@link ArgSpec} so the
 * "was it given" question has one answer instead of three.
 *
 * `values` collects every occurrence, which is what makes a repeated option (`--at 1s --at 50%`,
 * or `audio at 1s,50%`) readable through {@link ParsedArgs.strings} in order.
 */
interface Declared {
  readonly spec: ArgSpec;
  /** Canonical name, with a `short` alias resolved to its long name. */
  readonly key: string;
  readonly values: string[];
  /**
   * Mutable on purpose: this is the parser's own bookkeeping of "the flag appeared", written as
   * the tokens are read. Only the public {@link ParsedArgs} view is read-only.
   */
  present: boolean;
}

/**
 * Whether a token is an option of its own rather than the value of the option before it.
 *
 * A token counts as an option when it is `--` or a long flag naming a declared option. A short
 * token counts only when its letter is declared, so `-5` stays a value.
 */
function isDeclaredOption(
  token: string,
  byName: ReadonlyMap<string, Declared>,
  byShort: ReadonlyMap<string, Declared>,
): boolean {
  if (token === '--') {
    return true;
  }
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    return byName.has(name);
  }
  if (token.startsWith('-') && token.length > 1) {
    const body = token.slice(1);
    const eq = body.indexOf('=');
    const letters = eq >= 0 ? body.slice(0, eq) : body;
    return [...letters].some((letter) => byShort.has(letter));
  }
  return false;
}

/** Builds a {@link ParsedArgs} from raw `argv` tokens and the declared options. */
export function parseArgs(argv: readonly string[], specs: readonly ArgSpec[]): ParsedArgs {
  const byName = new Map<string, Declared>();
  const byShort = new Map<string, Declared>();

  for (const spec of specs) {
    const declared: Declared = { spec, key: spec.name, values: [], present: false };
    byName.set(spec.name, declared);
    if (spec.short !== undefined) {
      byShort.set(spec.short, declared);
    }
  }

  const positionals: string[] = [];
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }

    // `--name`, `--name=value`, `--name value`
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined;
      const declared = byName.get(name);

      if (declared === undefined) {
        // Unknown long flags are kept as `true` so `--whatever` never crashes a video script.
        byName.set(name, { spec: { name, kind: 'boolean' }, key: name, values: [], present: true });
        continue;
      }

      declared.present = true;
      if (inline !== undefined) {
        declared.values.push(inline);
        continue;
      }
      if (declared.spec.kind === 'boolean') {
        declared.values.push('true');
        continue;
      }
      if (declared.spec.kind === 'optional') {
        continue;
      }
      // A value flag takes the next token, unless that token is a declared option of its own.
      // Testing against the declared names rather than against `-` is what lets
      // `--frame-range -5..5` work: a leading `-` there is part of the spec, not a new flag.
      const next = argv[i + 1];
      if (next !== undefined && !isDeclaredOption(next, byName, byShort)) {
        declared.values.push(next);
        i += 1;
      }
      continue;
    }

    // `-o value`, `-o=value`, `-abc` (bundled boolean shorts)
    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const eq = body.indexOf('=');
      const letters = eq >= 0 ? body.slice(0, eq) : body;
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined;

      // An unknown single letter is a negative number or a bare positional, not a flag: `-5` and
      // `-1s` are time specs in reverse, and losing them would be worse than passing them through.
      const known = [...letters].some((letter) => byShort.has(letter));
      if (!known && inline === undefined) {
        positionals.push(token);
        continue;
      }

      for (let j = 0; j < letters.length; j += 1) {
        const letter = letters[j] as string;
        const declared = byShort.get(letter);
        if (declared === undefined) {
          continue;
        }
        declared.present = true;
        if (declared.spec.kind === 'boolean') {
          declared.values.push('true');
          continue;
        }
        if (declared.spec.kind === 'optional') {
          continue;
        }
        if (j === letters.length - 1) {
          if (inline !== undefined) {
            declared.values.push(inline);
          } else {
            const next = argv[i + 1];
            if (next !== undefined && !isDeclaredOption(next, byName, byShort)) {
              declared.values.push(next);
              i += 1;
            }
          }
        }
      }
      continue;
    }

    positionals.push(token);
  }

  const readOnly = new Map<string, string | number | boolean>();
  for (const [name, declared] of byName) {
    if (declared.values.length === 0) {
      if (declared.present && declared.spec.default !== undefined) {
        readOnly.set(name, declared.spec.default);
      }
      continue;
    }
    const last = declared.values[declared.values.length - 1] as string;
    if (declared.spec.kind === 'number') {
      const parsed = Number(last);
      readOnly.set(name, Number.isFinite(parsed) ? parsed : declared.spec.default ?? NaN);
      continue;
    }
    if (declared.spec.kind === 'boolean') {
      readOnly.set(name, last !== 'false' && last !== '0');
      continue;
    }
    readOnly.set(name, last);
  }

  const get = (name: string): Declared | undefined => byName.get(name);

  const result: ParsedArgs = {
    positionals,
    values: readOnly,

    has(name: string): boolean {
      return get(name)?.present === true;
    },

    string(name: string): string | undefined {
      const value = readOnly.get(name);
      if (typeof value === 'string') {
        return value;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      return undefined;
    },

    number(name: string): number | undefined {
      const value = readOnly.get(name);
      if (typeof value === 'number') {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    },

    boolean(name: string): boolean {
      const value = readOnly.get(name);
      if (typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'number') {
        return value !== 0;
      }
      if (typeof value === 'string') {
        return value !== 'false' && value !== '0' && value !== '';
      }
      return false;
    },

    strings(name: string): string[] {
      const declared = get(name);
      if (declared === undefined) {
        return [];
      }
      return [...declared.values];
    },
  };

  return result;
}

/** A usage error: the message is the whole `error: …` line on stderr and the exit code is 1. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * The options every command accepts.
 *
 * `--json` and `--scale` are the two globals of the Rust `Cli` struct (`cli.rs:47-63`); `--help`
 * and `--media-dir` are added because the Rust CLI gets the media directory from `RenderOptions`
 * rather than from a flag, while a Node module has to be told where its media folder is.
 */
export function globalSpecs(): ArgSpec[] {
  return [
    { name: 'json', kind: 'boolean', help: 'Print one JSON document to stdout.' },
    {
      name: 'scale',
      kind: 'number',
      help: 'Output resolution factor, e.g. 0.5 for half resolution.',
    },
    { name: 'media-dir', kind: 'string', help: 'Folder audio and images resolve from.' },
    { name: 'help', kind: 'boolean', short: 'h', help: 'Print this help.' },
  ];
}

/** Where output goes. Injected so the tests can capture it. */
export interface CliIo {
  /** The report: stdout when `--json`, or the human text. */
  out(text: string): void;
  /** Progress, warnings and errors: always stderr. */
  err(text: string): void;
}

/** The real terminal. */
export const processIo: CliIo = {
  out(text: string): void {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  },
  err(text: string): void {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  },
};

/**
 * `print` from `cli.rs:436`: one JSON document, or the human text, never both.
 */
export function printReport(io: CliIo, json: boolean, value: unknown, text: () => string): void {
  if (json) {
    io.out(JSON.stringify(value, null, 2));
    return;
  }
  const body = text();
  if (body !== '') {
    io.out(body);
  }
}

/** `err(message)` — the `error: …` line of `cli.rs:428`. */
export function printError(io: CliIo, message: string): void {
  io.err(`error: ${message}`);
}

/**
 * The help text of a command, built from its specs.
 *
 * `command` is the usage tail (`render [RANGE]`, `frame <spec...> [-o dir]`), so each command writes
 * its own argument shape and this only lays the options out. Pass `note` for the trailing block —
 * {@link TIME_SPECS_HELP} for the commands that take a time.
 */
export function helpText(command: string, specs: readonly ArgSpec[], note?: string): string {
  const lines = [`Usage: fframes <video.ts> ${command} [options]`, ''];
  // The widest flag decides the column, so `-h, --help` and `--every-frame` line up.
  const width = specs.reduce((max, spec) => {
    const flag = spec.short === undefined ? `--${spec.name}` : `-${spec.short}, --${spec.name}`;
    return Math.max(max, flag.length);
  }, 0);
  for (const spec of specs) {
    const flag = spec.short === undefined ? `--${spec.name}` : `-${spec.short}, --${spec.name}`;
    lines.push(`  ${flag.padEnd(width)}  ${spec.help ?? ''}`);
  }
  if (note !== undefined && note !== '') {
    lines.push('', note);
  }
  return lines.join('\n');
}

/** The `TIME_SPECS` help of `cli.rs:33-41`, reused by every command that takes a spec. */
export const TIME_SPECS_HELP = `TIME SPECS (for --at, ranges and positional times):
  120, 120f        frame 120               3.2s, 500ms, 1:05.5   a timestamp
  50%              half of the video       start, end            first / last frame
  Intro            first frame of a scene (case-insensitive)   #3   scene index 3
  Intro[1]         second scene of type Intro
  Intro@1.2s       1.2s into the scene (also @12, @50%, @end)
RANGES: a..b (end exclusive), a.., ..b, all, or a scene name for the whole scene.
Run \`timeline\` to list scenes. Add --json to any command for machine-readable output.`;
