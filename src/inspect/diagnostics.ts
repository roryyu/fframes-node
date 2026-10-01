/**
 * `inspect` — check a video without watching it.
 *
 * Port of `.source/fframes/fframes/src/diagnostics.rs` (`Severity`, the diagnostic kinds, the
 * dedup key) and of the `inspect` command of `renderer/cli.rs:894-1001`.
 *
 * ## The two halves of the Rust command
 *
 * `previewer.inspect(frame)` is a *cheap* per frame pass: it runs `render_frame_guarded`, collects
 * what the frame refers to (media, fonts, glyphs) and reports where the elements landed, without
 * rasterizing. Then `cli.rs` merges the findings by `diagnostic.key`, sorts by severity and by
 * first frame, and decides the exit code from `--fail-on`.
 *
 * This port keeps the merge, the sort and the exit code exactly as they are. The per frame pass
 * keeps the checks that are decidable without a human:
 *
 * - `render-error` — `renderFrame` threw. This is `render_frame_guarded`'s job, and the frame,
 *   the second and the scene are in the message.
 * - `missing-font` — a `font-family` in the produced SVG is not among the registered families.
 *   The Rust check asks its `fontdb`; `resvg-js` does not expose one, so the families are
 *   recovered from `Video.fonts()` file names (a documented heuristic).
 * - `missing-media` — a file the `AudioMap` refers to is not in the media directory, or the map
 *   could not be resolved at all. This is a per video check, not a per frame one, and is reported
 *   on the first checked frame.
 * - `empty-frame` — the frame rasterized to nothing but transparency, **or produced no document at
 *   all** (`Svgr.empty()` is the empty string, and malformed markup fails in resvg). It is the one
 *   finding that needs pixels, so `inspect` renders RGBA rather than PNG for that check — and a
 *   rasterization failure is reported as a finding rather than thrown, because the frames this
 *   check exists to catch are exactly the ones that fail to rasterize.
 *
 * ## Sampling (`cli.rs:901-922`)
 *
 * `everyFrame` checks every frame; otherwise `distance` (a frame count, `30` by default) steps
 * through the range, and **every scene's first and last frame are always added**, as are the
 * range's own boundaries. The list is then sorted and de-duplicated, so the scene edges are
 * checked whatever the step is.
 */

import {
  fontFamilyIsRegistered,
  isFullyTransparent,
  registeredFontFamilies,
  renderFrameSvg,
  renderSvgToRgba,
} from '../render/resvg-backend.ts';
import type { RgbaImage, RenderSession } from '../render/resvg-backend.ts';
import type { FrameRange } from '../core/time-spec.ts';
import type { InspectFinding, InspectResult } from '../core/types.ts';

/** `diagnostics::Severity` — the order matters, `>=` is how `--fail-on` compares. */
export type Severity = 'info' | 'warning' | 'error';

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

/** `--exit-code`, the highest severity that fails the run. */
export type ExitSeverity = 'error' | 'warning' | 'info';

export interface InspectOptions {
  /** Check every frame instead of sampling. `--every-frame`. */
  readonly everyFrame?: boolean;
  /** Frames between samples, `30` by default. `--distance`. */
  readonly distance?: number;
  /** Highest severity that fails, `error` by default. `--exit-code`. */
  readonly exitSeverity?: ExitSeverity;
  /** Include `info` findings in the report, `--info` in Rust. */
  readonly info?: boolean;
  /** Font files; `Video.fonts()` when not given. */
  readonly fontFiles?: readonly string[] | null;
  /** Also report the frames that are fully transparent. On by default. */
  readonly checkEmpty?: boolean;
}

/** `Diagnostic` in the Rust sense, before the per video merge. */
export interface RawFinding {
  readonly severity: Severity;
  readonly kind: string;
  readonly message: string;
  /** What makes two findings "the same finding" across frames (`diagnostic.key` in Rust). */
  readonly key: string;
}

/** `font-family="…"` in the produced SVG, de-duplicated and in document order. */
export function fontFamiliesInSvg(svg: string): string[] {
  const families: string[] = [];
  const pattern = /font-family\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(svg);
  while (match !== null) {
    const raw = (match[1] ?? '').trim();
    // `font-family` accepts a fallback list; the first name is the one that has to resolve.
    const first = raw.split(',')[0]?.replace(/^['"]|['"]$/g, '').trim() ?? '';
    if (first !== '' && !families.includes(first)) {
      families.push(first);
    }
    match = pattern.exec(svg);
  }
  return families;
}

/** The frames to check: the sampled ones plus every scene edge, sorted and de-duplicated. */
export function inspectFrames(
  range: FrameRange,
  scenes: readonly { startFrame: number; endFrame: number }[],
  options: InspectOptions,
): number[] {
  const distance = Math.max(1, Math.trunc(options.distance ?? 30));
  const frames = new Set<number>();

  if (options.everyFrame === true) {
    for (let frame = range.start; frame < range.end; frame += 1) {
      frames.add(frame);
    }
  } else {
    for (let frame = range.start; frame < range.end; frame += distance) {
      frames.add(frame);
    }
    // Every scene's first and last frame, whatever the step is (cli.rs:913-919).
    for (const scene of scenes) {
      if (range.start <= scene.startFrame && scene.startFrame < range.end) {
        frames.add(scene.startFrame);
      }
      const last = Math.max(scene.startFrame, scene.endFrame - 1);
      if (range.start <= last && last < range.end) {
        frames.add(last);
      }
    }
    // The last frame of the range itself.
    frames.add(Math.max(range.start, range.end - 1));
  }

  return [...frames].sort((a, b) => a - b);
}

/** What a single frame reported, before the merge. */
export interface FrameInspection {
  readonly frame: number;
  readonly seconds: number;
  readonly scenes: string[];
  readonly findings: readonly RawFinding[];
}

/** Renders one frame and collects what can be decided about it without a human. */
export function inspectFrame(
  session: RenderSession,
  frame: number,
  options: InspectOptions,
): FrameInspection {
  const fps = session.video.fps;
  const seconds = frame / fps;
  const scenes = session.context.scenesAt(frame).map((entry) => entry.name);
  const findings: RawFinding[] = [];

  let svg: string;
  try {
    svg = renderFrameSvg(session, frame);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({
      severity: 'error',
      kind: 'render-error',
      message,
      key: 'render-error',
    });
    return { frame, seconds, scenes, findings };
  }

  const fontFiles = options.fontFiles ?? session.context.fontFiles;
  // The family list is the same for every frame of a session, so it is derived once per call and
  // passed down; recomputing it per family would re-split the same file names.
  const registered = registeredFontFamilies(fontFiles);
  for (const family of fontFamiliesInSvg(svg)) {
    if (!fontFamilyIsRegistered(family, fontFiles, registered)) {
      findings.push({
        severity: 'error',
        kind: 'missing-font',
        message: `font-family "${family}" is not among the registered fonts (${fontFiles.join(', ') || 'none'})`,
        key: `missing-font:${family}`,
      });
    }
  }

  if (options.checkEmpty !== false) {
    // The one check that needs pixels: no background, so an unpainted frame is transparent.
    // Rasterizing can still fail even though `renderFrameSvg` returned a string — `Svgr.empty()`
    // is the empty string and `rasterize` rejects it (`resvg-backend.ts:131-136`), and malformed
    // SVG fails in resvg. That is precisely the frame this check exists to catch, so a throw here
    // becomes a finding instead of killing the whole inspect run: an empty document is an
    // `empty-frame` warning, anything else is a `render-error` like a throw from `renderFrame`.
    let image: RgbaImage | null = null;
    let rasterError: string | null = null;
    try {
      image = renderSvgToRgba(svg, {
        width: session.video.width,
        height: session.video.height,
        scale: session.options.scale,
        fontFiles: session.context.fontFiles,
      });
    } catch (error) {
      rasterError = error instanceof Error ? error.message : String(error);
    }

    if (image !== null && isFullyTransparent(image)) {
      findings.push({
        severity: 'warning',
        kind: 'empty-frame',
        message: `frame ${frame} rendered nothing (fully transparent ${image.width}x${image.height})`,
        key: 'empty-frame',
      });
    } else if (rasterError !== null) {
      const empty = svg.trim() === '' || rasterError.includes('empty SVG document');
      findings.push({
        severity: empty ? 'warning' : 'error',
        kind: empty ? 'empty-frame' : 'render-error',
        message: empty
          ? `frame ${frame} rendered nothing (the SVG document is empty)`
          : `frame ${frame} could not be rasterized: ${rasterError}`,
        key: empty ? 'empty-frame' : 'render-error',
      });
    }
  }

  return { frame, seconds, scenes, findings };
}

/**
 * `missing-media` — a per video check.
 *
 * The Rust `inspect` finds it because `MediaDirectory::process_media_source` fails while the
 * previewer is built; here the media directory is a plain folder, so the check is the explicit
 * `usedFiles` helper of `media/media-dir.ts` (GEN-2 §2.5) over the names the `AudioMap` uses.
 * It is reported on the first checked frame, so the frame range stays non empty.
 *
 * The resolution failure of {@link RenderSession.audioResolveError} is reported through the same
 * kind: it is the same defect seen from the timeline's side (an `Eof` range with no file to read).
 */
export function inspectMedia(session: RenderSession, frame: number): RawFinding[] {
  const mediaDir = session.mediaDir;
  const used = session.audioMap.trackNames();
  if (mediaDir === null || used.length === 0) {
    // No media directory means the audio cannot be resolved at all, which is worth saying even
    // when no track names a file: a video with audio and no `media/` is broken.
    if (used.length > 0) {
      return [
        {
          severity: 'error',
          kind: 'missing-media',
          message: `the audio map names ${used.length} file(s) but no media directory was found`,
          key: 'missing-media:no-directory',
        },
      ];
    }
    return [];
  }
  const { missing } = mediaDir.usedFiles(used);
  const findings: RawFinding[] = missing.map((file) => ({
    severity: 'error',
    kind: 'missing-media',
    message: `audio "${file}" is not in the media directory "${mediaDir.dir}"`,
    key: `missing-media:${file}`,
  }));

  // The resolution failure is the same problem seen from the other side: the `Eof` range of a
  // missing file has no duration. Reporting it here means `broken-video` yields a finding instead
  // of failing to build a session.
  if (session.audioResolveError !== null) {
    findings.push({
      severity: 'error',
      kind: 'missing-media',
      message: `the audio map could not be resolved: ${session.audioResolveError}`,
      key: 'missing-media:unresolvable',
    });
  }

  return findings;
}

/**
 * A finding merged across the frames it was seen in, the `Finding` of `cli.rs:872-886`.
 */
export interface MergedFinding extends InspectFinding {
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly firstSeconds: number;
  readonly lastSeconds: number;
  /** How many checked frames saw it. */
  readonly seenIn: number;
  readonly scenes: string[];
}

/** The full report, the merged findings included — what the `--json` document carries. */
export interface DetailedInspectResult {
  readonly findings: MergedFinding[];
  readonly checkedFrames: number;
  readonly exitCode: number;
}

/**
 * `inspectVideoDetailed` — the whole check, with every merged field.
 *
 * The merge follows `cli.rs:924-955`: the first frame's message is kept, the last frame and the
 * count follow it, the scenes accumulate, and the result is sorted by severity descending then by
 * first frame ascending. The exit code is `2` when any finding reached `exitSeverity`, `0`
 * otherwise.
 */
export function inspectVideoDetailed(
  session: RenderSession,
  input: { readonly range: FrameRange } & InspectOptions,
): DetailedInspectResult {
  const options: InspectOptions = input;
  const sceneRanges = (session.scenes?.timeline ?? []).map((entry) => ({
    startFrame: entry.startFrame,
    endFrame: entry.endFrame,
  }));
  const frames = inspectFrames(input.range, sceneRanges, options);
  const showInfo = options.info === true || options.exitSeverity === 'info';
  const merged = new Map<string, MergedFinding>();

  frames.forEach((frame, position) => {
    const seconds = frame / session.video.fps;
    const scenes = session.context.scenesAt(frame).map((entry) => entry.name);

    // `FrameInspection.findings` is `readonly RawFinding[]` and this block mutates it, so copy it
    // first: the signature stays read-only, the only mutable array is the local copy.
    const raws: RawFinding[] = [...inspectFrame(session, frame, options).findings];
    // `missing-media` is a per video check, so it runs once, on the first checked frame.
    if (position === 0) {
      raws.unshift(...inspectMedia(session, frame));
    }

    for (const raw of raws) {
      if (raw.severity === 'info' && !showInfo) {
        continue;
      }
      const existing = merged.get(raw.key);
      if (existing !== undefined) {
        merged.set(raw.key, {
          ...existing,
          lastFrame: frame,
          lastSeconds: seconds,
          seenIn: existing.seenIn + 1,
          count: (existing.count ?? 1) + 1,
          scenes: [...new Set([...existing.scenes, ...scenes])],
        });
        continue;
      }
      merged.set(raw.key, {
        frame,
        severity: raw.severity,
        kind: raw.kind,
        message: raw.message,
        firstFrame: frame,
        lastFrame: frame,
        firstSeconds: seconds,
        lastSeconds: seconds,
        seenIn: 1,
        count: 1,
        scenes: [...scenes],
      });
    }
  });

  const sorted = [...merged.values()].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    return bySeverity !== 0 ? bySeverity : a.firstFrame - b.firstFrame;
  });
  const threshold = SEVERITY_ORDER[options.exitSeverity ?? 'error'];

  return {
    findings: sorted,
    checkedFrames: frames.length,
    exitCode: sorted.some((finding) => SEVERITY_ORDER[finding.severity] >= threshold) ? 2 : 0,
  };
}

/**
 * `inspectVideo` — the whole check, projected onto the public `InspectResult` shape.
 *
 * ```ts
 * const result = inspectVideo(session, { range: session.index.fullRange() });
 * result.exitCode; // 2 when a finding reached --exit-code
 * ```
 */
export function inspectVideo(
  session: RenderSession,
  input: { readonly range: FrameRange } & InspectOptions,
): InspectResult {
  const detailed = inspectVideoDetailed(session, input);
  return {
    findings: detailed.findings.map((finding) => ({
      frame: finding.firstFrame,
      severity: finding.severity,
      kind: finding.kind,
      message: finding.message,
      count: finding.seenIn,
    })),
    checkedFrames: detailed.checkedFrames,
    exitCode: detailed.exitCode,
  };
}
