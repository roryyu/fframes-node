/**
 * The module graph of the two entry points — the regression lock for the P0 items of the gen3 fix
 * round (`DELIVERY.md` §4.1 items 1 and 2).
 *
 * `src/cli/main.ts` ends in a top-level `if (isEntryPoint()) await runCli()`. A video module
 * (`examples/<name>/video.ts`) imports `src/index.ts` for the public API, and `loadVideo` imports
 * the video module. So a single static `export … from './cli/main.ts'` in `index.ts` closes this cycle:
 *
 *   node src/cli/main.ts <video.ts> timeline
 *     -> main.ts: the top-level `await runCli()` has not settled
 *        -> loadVideo: `await import('<video.ts>')`
 *           -> video.ts: `import … from '../../src/index.ts'`
 *              -> index.ts: `export … from './cli/main.ts'` (still evaluating)  => never settles
 *
 * Node then reports "unsettled top-level await" and exits 13 for *every* command, with an idle CPU.
 * Nothing in the type system can see that, no unit test reaches it (it needs a direct execution of
 * the entry point), and the programmatic path — import `main.ts` first, then call `runCli(argv)` —
 * works fine, so the defect hides from the normal test suite. The invariant is therefore asserted
 * here against the sources themselves: the first two tests fail on the pre-fix tree and pass now.
 *
 * Nothing is faked here: the assertions read the real files, so they stay honest as the tree grows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The repo root, resolved from this test file. */
const ROOT = new URL('../', import.meta.url);

const resolve = (relative: string): string => fileURLToPath(new URL(relative, ROOT));

const read = (relative: string): string => readFileSync(resolve(relative), 'utf8');

/**
 * The file without its comments.
 *
 * Only whole-line comments are dropped: the `//` lines and the asterisk lines of a block comment,
 * which is every comment form the files below use. String literals are left alone — the prose in
 * `cli/main.ts` and `audio/audio-map.ts` talks about importing `index.ts` and must not be read as
 * code that does.
 */
const withoutComments = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');

/** Every `.ts` file under `src/`, recursively. */
const srcFiles = (dir = 'src/'): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(dir), { withFileTypes: true })) {
    const relative = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...srcFiles(`${relative}/`));
    } else if (entry.name.endsWith('.ts')) {
      out.push(relative);
    }
  }
  return out.sort();
};

test('index.ts does not statically depend on the CLI entry point', () => {
  const code = withoutComments(read('src/index.ts'));

  // The cycle itself: any static import of the CLI from the barrel, in either quoting style.
  assert.equal(
    /\bfrom\s+['"][^'"]*cli\/main\.ts['"]/.test(code),
    false,
    'index.ts must not import cli/main.ts: loadVideo imports the video module, which imports ' +
      'index.ts, so the export would leave index.ts permanently unevaluated and every direct ' +
      '`node src/cli/main.ts …` run would hang (exit 13)',
  );
  // The export form is what the gen3 fix removed; a bare import would be the same cycle.
  assert.equal(/^\s*export\b[^\n]*cli\/main\.ts/m.test(code), false, 'no re-export either');

  // The reasoning has to survive the fix, or the next reader re-adds it: index.ts carries the
  // normative explanation of the cycle and of why the fix belongs here rather than in main.ts.
  const full = read('src/index.ts');
  assert.match(full, /unsettled top-level await/, 'the cycle explanation stays in index.ts');
  assert.match(full, /import \{ run, runCli, loadVideo \}/, 'it still shows how to import the CLI');
});

test('the barrel is a leaf, and only the video modules import it', () => {
  const files = srcFiles();

  // Nothing inside the port imports the public barrel *that the barrel reaches back to*: the
  // cycle needs both halves, and `src/studio/` is the one subtree the barrel never re-exports.
  // The studio is its own entry point (`npm run studio`) and talks to the library through the
  // public API by design (src/studio/pipeline.ts, §5.1 of STUDIO-DELIVERY.md), so its
  // `from '../index.ts'` imports cannot close the cycle. The exemption rests on that fact alone
  // and the next test locks the fact itself.
  const importers = files.filter(
    (file) =>
      !file.startsWith('src/studio/') &&
      /\bfrom\s+['"](?:\.\.\/)*index\.ts['"]/.test(withoutComments(read(file))),
  );
  assert.deepEqual(importers, [], 'src/ must not import the public barrel (outside src/studio)');

  // The command modules stay free of main.ts, which is what makes the re-exports of the other
  // cli/ modules in index.ts safe (they cannot be part of the cycle). The pattern insists on a path
  // separator, so a hypothetical `domain.ts` could not trip it.
  //
  // `src/studio/` is exempt for the same reason as above and under the same lock: the barrel never
  // reaches it, so its `'../cli/main.ts'` imports (mediaDirFor / loadVideo, deliberate — see
  // src/studio/pipeline.ts) sit on a different evaluation path than the CLI's own. `main.ts` only
  // calls `runCli` behind its entry-point check, so loading it costs nothing.
  const mainImporters = files.filter(
    (file) =>
      !file.startsWith('src/studio/') &&
      /\bfrom\s+['"][^'"]*\/main\.ts['"]/.test(withoutComments(read(file))),
  );
  assert.deepEqual(mainImporters, [], 'src/ must not import cli/main.ts (outside src/studio)');

  // The other side of the cycle, stated so the two halves stay in step: every example video gets
  // its API from the barrel, which is exactly why the barrel must not reach back into the CLI.
  for (const example of ['hello-world', 'audio-demo', 'broken-video', 'typeset-card']) {
    assert.match(
      withoutComments(read(`examples/${example}/video.ts`)),
      /\bfrom\s+['"]\.\.\/\.\.\/src\/index\.ts['"]/,
      `examples/${example}/video.ts imports the public API from the barrel`,
    );
  }
});

test('the barrel does not reach src/studio, which is what makes the studio exemption sound', () => {
  // `src/studio/` imports the public barrel (the test above exempts it); that is only safe while
  // the barrel never re-exports the studio, because the re-export would close the cycle again.
  // This is the other half of the exemption, so it is asserted rather than left to prose.
  const code = withoutComments(read('src/index.ts'));
  assert.equal(
    /['"][^'"]*studio/i.test(code),
    false,
    'index.ts must not re-export src/studio: the studio imports the barrel, so the re-export ' +
      'would close the module-graph cycle this file exists to prevent',
  );
});

test('the CLI keeps the entry point shape the contract asks for', () => {
  const main = read('src/cli/main.ts');

  // Contract §3: the shebang, and the direct-execution check that guards the top-level await.
  // The gen3 fix cut the cycle in index.ts on purpose — this test fails if anyone "fixes" the hang
  // here instead, which would put every video module's evaluation behind a promise.
  assert.ok(main.startsWith('#!/usr/bin/env node\n'), 'the shebang is the first line');
  assert.match(main, /if\s*\(\s*isEntryPoint\(\)\s*\)/, 'the entry point is detected explicitly');
  assert.match(main, /await runCli\(\)/, 'and the CLI is awaited at the top level');
  // Node 24 has no `import.meta.main`, so the check compares this file's own path with argv[1]
  // (contract §3). Asserted on the code, not on the prose that documents it.
  assert.match(
    main,
    /function isEntryPoint\(argv: readonly string\[\] = process\.argv\)/,
    'isEntryPoint reads the real process.argv by default',
  );
  assert.match(main, /const entry = argv\[1\]/, 'and takes the entry from argv[1]');
  assert.match(main, /return sameFile\(entry, thisFile\)/, 'compared against this file');
  assert.match(
    main,
    /const thisFile = fileURLToPath\(import\.meta\.url\)/,
    'this file is identified by its own URL',
  );
});

test('the public API still covers the contract symbols after the fix', () => {
  // Every `export … ;` statement of the barrel, comments removed, so a symbol that is only
  // *mentioned* in prose does not satisfy the check. The statements are matched, not split on `;`:
  // splitting would swallow the first one into the import that precedes it, and that first block
  // is the one exporting `Video`. The list is the contract §4 example plus the symbols gate A11
  // greps for.
  const code = withoutComments(read('src/index.ts'));
  const statements = [...code.matchAll(/export\b[\s\S]*?;/g)].map((match) => match[0]).join('\n');
  assert.ok(statements.length > 0, 'the barrel has export statements at all');

  for (const symbol of [
    'Video',
    'Frame',
    'Svgr',
    'svgr',
    'seconds',
    'frames',
    'auto',
    'fromAudio',
    'timeline',
    'Easing',
    'AudioMap',
    'audioTrack',
    'Color',
    'Transform',
    'Ducking',
    'MediaDirectory',
  ]) {
    assert.match(statements, new RegExp(`\\b${symbol}\\b`), `${symbol} is exported from index.ts`);
  }
});

test('the out-of-scope render pipeline file is still gone', () => {
  // GEN-3 left a zero byte src/render/pipeline.ts behind, outside the contract's file list. It was
  // deleted; this is the lock, paired with the next assertion so an empty directory cannot make it
  // pass for the wrong reason.
  assert.equal(
    existsSync(resolve('src/render/pipeline.ts')),
    false,
    'src/render/pipeline.ts is gone',
  );
  assert.equal(
    existsSync(resolve('src/render/resvg-backend.ts')),
    true,
    'and the session code lives in src/render/resvg-backend.ts',
  );
});
