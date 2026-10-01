/**
 * A runnable entry point for the `hello-world` example.
 *
 * The Rust example's `main.rs` hands the video to `fframes::cli`. Here the video module is loaded
 * by path and the command line is assembled from `process.argv`, so the example runs two ways:
 *
 * ```sh
 * node examples/hello-world/main.ts render -o hello.mp4
 * node src/cli/main.ts examples/hello-world/video.ts render -o hello.mp4
 * ```
 *
 * `run(argv)` from `cli/main.ts` is what makes both work: it takes a full `process.argv`, so the
 * only thing this file has to do is put the video path where the CLI expects it.
 *
 * The flags pass through untouched, so `node examples/hello-world/main.ts timeline` and
 * `… inspect --every-frame` work as they do through `src/cli/main.ts`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../../src/cli/main.ts';

const here = dirname(fileURLToPath(import.meta.url));
const video = resolve(here, 'video.ts');

/** `argv[2]` onwards, with the video path in front: `['node', 'fframes', video, …]`. */
export function buildArgv(argv: readonly string[] = process.argv): string[] {
  return ['node', 'fframes', video, ...argv.slice(2)];
}

/**
 * Node 24 has no `import.meta.main`, so this compares `process.argv[1]` with this file's own path.
 * The same check is in `cli/main.ts` as `isEntryPoint()`; both are one line because both files
 * need it and neither should import the other.
 */
if ((process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(buildArgv());
}
