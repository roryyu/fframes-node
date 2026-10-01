/**
 * The rendering backend: an SVG string to pixels, on the CPU, with `resvg`.
 *
 * Port of `.source/fframes/fframes/src/renderer/cpu.rs` (`CpuRenderingBackend::render` /
 * `CpuFrameRenderer`) in what matters for the pipeline:
 *
 * - the per frame work is `Frame -> renderFrame -> Svgr -> rtree -> pixels`, and the pixels are
 *   handed to the encoder, exactly as `pixmap.data()` is handed to `writer.submit` in `cpu.rs`,
 * - the background is filled before the frame is drawn (`pixmap.fill(background_color)`,
 *   `cpu.rs:147`) — `Video::BACKGROUND_COLOR` has no override in this port, so it is the black
 *   the Rust default spells, applied by the *callers* so that `inspect` can see a transparent
 *   frame (that is how the `empty-frame` check works),
 * - the render loop is serial in this port: the Rust CPU backend uses rayon over segments and
 *   concatenates them (`concatenator.rs`), the contract keeps one thread (see PORTING.md).
 *
 * ## Why PNG and not raw pixels (contract §7, the M0 probe)
 *
 * `@resvg/resvg-js` 2.6 exposes both `RenderedImage.asPng()` and `RenderedImage.pixels`, so both
 * routes are available. The contract pins the **PNG `image2pipe` route** (measured end to end at
 * 37.5 fps for a typical 1080p frame, `.verify/fframes/M0-probe-results.md` P5), and it is the
 * default of the encoder. {@link renderSvgToRgba} is still exported because `inspect` needs the
 * pixels to decide whether a frame is empty, and because it is the shape the contract §3 names.
 *
 * ## `loadSystemFonts` is never `true` (contract §7, P1/P1b)
 *
 * `loadSystemFonts: true` rescans the system font directory for **every** `Resvg` instance:
 * 427 ms/frame cold, 351 ms/frame warm (probe P1/P1b-A) — 2.3 fps, unusable. With
 * `loadSystemFonts: false` plus the `fontFiles` of `Video.fonts()` the same frame costs 25.8 ms
 * (P1b-B). The options built here therefore always set `loadSystemFonts: false`; the only way to
 * change the font set is `Video.fonts()`.
 *
 * ## Why the session lives here
 *
 * The second half of this file is the render **session**: the resolved timeline, the
 * `FFramesContext` and the per-frame calls, which is what `Previewer::new(video, &options)` builds
 * in `renderer/preview.rs` and what the six commands of `cli/*.ts` all borrow. It lives in the
 * render layer rather than in a `cli/` module because `inspect/diagnostics.ts` needs it too, and a
 * library module must not depend on the CLI. The render layer owning it keeps the import graph
 * acyclic: `core` → nothing, `render` → `core` + `audio` + `media`, `encode` → nothing,
 * `inspect` → `render`, `cli` → everything.
 */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { ResvgRenderOptions } from '@resvg/resvg-js';

import { AudioMixer } from '../audio/mixer.ts';
import type { AudioMixerInput, TrackAudio } from '../audio/mixer.ts';
import { AudioMap, AudioTrack, resolve } from '../audio/audio-map.ts';
import type { ResolvedAudioTrack } from '../audio/audio-map.ts';
import { renderScenes, Scenes } from '../core/scenes.ts';
import type { ResolvedScene, ResolvedScenesTimeline } from '../core/scenes.ts';
import { toFrames } from '../core/duration.ts';
import { Frame } from '../core/frame.ts';
import { TimelineIndex } from '../core/time-spec.ts';
import type { FrameRange, TimelineScene } from '../core/time-spec.ts';
import type { Svgr } from '../core/svgr.ts';
import type { FFramesContext, Video } from '../core/types.ts';
import {
  decodeAudioFileStereo,
  // A value import, not `import type`: `decodeAudioSync` constructs one (`resvg-backend.ts:345`).
  DecodedAudio,
  DEFAULT_SAMPLE_RATE,
  deinterleave,
  parseF32le,
} from '../media/audio-decode.ts';
import { MediaDirectory } from '../media/media-dir.ts';

/** The size a frame is rasterized at, after scaling. */
export interface RenderSize {
  readonly width: number;
  readonly height: number;
}

export interface ResvgBackendOptions {
  /** `Video.width`, the intrinsic width of the SVG. */
  readonly width: number;
  /** `Video.height`. */
  readonly height: number;
  /** Resolution multiplier; `0.5` renders half size. */
  readonly scale?: number;
  /** `Video.fonts()`. Never empty-checked here: an empty list is legal (text then has no font). */
  readonly fontFiles?: readonly string[];
  /** resvg's fallback family for text with no `font-family`. */
  readonly defaultFontFamily?: string;
  /**
   * CSS3 color painted under the frame, `pixmap.fill(background_color)` in `cpu.rs:147`.
   * Left `undefined` the PNG keeps the alpha channel of the SVG, which is what `inspect` wants.
   */
  readonly background?: string;
}

/** The raster size of a frame: `VideoSize::new_scaled`, with at least one pixel per axis. */
export function scaledSize(width: number, height: number, scale: number = 1): RenderSize {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * The `resvg` options for a frame.
 *
 * `fitTo: { mode: 'width', value }` is how the scale is applied: the SVG keeps its authored
 * `width` / `height` (so `ctx.currentVideoSize` is the only place the scale shows up for the
 * video) and resvg scales the tree to the requested pixel width, which is
 * `super::fit_transform` in the Rust CPU backend.
 */
export function buildResvgOptions(options: ResvgBackendOptions): ResvgRenderOptions {
  const size = scaledSize(options.width, options.height, options.scale ?? 1);
  const font: NonNullable<ResvgRenderOptions['font']> = {
    // The measured hot spot: 351 ms/frame with system fonts, 25.8 ms/frame without.
    loadSystemFonts: false,
    fontFiles: [...(options.fontFiles ?? [])],
  };
  if (options.defaultFontFamily !== undefined && options.defaultFontFamily !== '') {
    font.defaultFontFamily = options.defaultFontFamily;
  }
  const resvgOptions: ResvgRenderOptions = { fitTo: { mode: 'width', value: size.width }, font };
  if (options.background !== undefined && options.background !== '') {
    resvgOptions.background = options.background;
  }
  return resvgOptions;
}

/** Rasterizes one frame. Never reuse a `Resvg` instance across frames: each holds a parsed tree. */
function rasterize(svg: string, options: ResvgBackendOptions): Resvg {
  if (typeof svg !== 'string' || svg.length === 0) {
    throw new Error('resvg-backend: can not render an empty SVG document');
  }
  return new Resvg(svg, buildResvgOptions(options));
}

/**
 * One frame as a PNG buffer — what `encodeVideo` feeds to the `-f image2pipe` pipe.
 *
 * ```ts
 * const png = renderSvgToPng(frame.renderFrame(frame, ctx).value, {
 *   width: 1920, height: 1080, fontFiles: video.fonts(), background: '#000000',
 * });
 * ```
 */
export function renderSvgToPng(svg: string, options: ResvgBackendOptions): Buffer {
  return rasterize(svg, options).render().asPng();
}

/** The pixels of one frame, RGBA, row major, 4 bytes per pixel. */
export interface RgbaImage {
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
}

/** One frame as raw RGBA — the contract §3 name, and what the `empty-frame` check reads. */
export function renderSvgToRgba(svg: string, options: ResvgBackendOptions): RgbaImage {
  const image = rasterize(svg, options).render();
  return { pixels: image.pixels, width: image.width, height: image.height };
}

/**
 * Whether every pixel is fully transparent, i.e. the frame drew nothing.
 *
 * This is the `empty-frame` finding of `inspect`: an alpha check is the one property of a frame
 * that can be decided without a human looking at it, and it catches the common bug of a scene
 * returning an `Svgr` with no visible geometry for the whole scene.
 */
export function isFullyTransparent(image: RgbaImage): boolean {
  const { pixels } = image;
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) !== 0) {
      return false;
    }
  }
  return true;
}

/** `Helvetica.ttc` -> `Helvetica`. */
function familyFromFile(fontFile: string): string {
  const file = basename(fontFile);
  const extension = extname(file);
  return extension === '' ? file : file.slice(0, file.length - extension.length);
}

/**
 * A family name reduced to something comparable: lower case, letters and digits only, and
 * without the style suffix a font file carries (`Arial-Bold.ttf` names the family `Arial`).
 */
export function normalizeFontFamily(name: string): string {
  const base = name
    .split(/[\\/]/)
    .pop()
    ?.split('.')[0]
    ?.replace(/[-_](regular|bold|italic|medium|semibold|light|thin|black|heavy|book|oblique)$/i, '');
  return (base ?? name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The family names a set of font files provides, in `normalizeFontFamily` form.
 *
 * The Rust renderer builds a real `fontdb::Database` and can ask it for a family
 * (`renderer_font_source.rs`); `resvg-js` does not expose its font database, so the names are
 * recovered from the file names. That is enough for the `missing-font` check of `inspect` and is
 * documented as a heuristic in DELIVERY.md.
 */
export function registeredFontFamilies(fontFiles: readonly string[]): string[] {
  const names: string[] = [];
  for (const file of fontFiles) {
    const normalized = normalizeFontFamily(file);
    if (normalized !== '' && !names.includes(normalized)) {
      names.push(normalized);
    }
  }
  return names;
}

/**
 * Whether `font-family` names a family the render has.
 *
 * A family matches when the normalized names are equal, when one is a prefix of the other (that
 * is what makes `font-family="Dm Sans"` match `DMSans-Regular.ttf`), or when the whole
 * `fontFiles` list is empty — a video that registers no font is not asked to have one, so the
 * check stays silent instead of reporting every text element as missing its font.
 */
export function fontFamilyIsRegistered(
  family: string,
  fontFiles: readonly string[],
  registered: readonly string[] = registeredFontFamilies(fontFiles),
): boolean {
  if (registered.length === 0) {
    return true;
  }
  const wanted = normalizeFontFamily(family);
  if (wanted === '') {
    return true;
  }
  return registered.some(
    (name) => name === wanted || name.startsWith(wanted) || wanted.startsWith(name),
  );
}

// ---------------------------------------------------------------------------
// The render session
// ---------------------------------------------------------------------------

/** What the session needs to know about a run. */
export interface PipelineOptions {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  /** Resolution multiplier; `0.5` renders half size. */
  readonly scale?: number;
  /** Font files; `Video.fonts()` when not given. */
  readonly fontFiles?: readonly string[] | null;
  /** Where audio and images are looked up. */
  readonly mediaDir?: MediaDirectory | null;
  /** Sample rate of the mix and of the encoder. */
  readonly sampleRate?: number;
  /** Forwarded to `AudioMixer`. */
  readonly mixerOptions?: AudioMixerInput['options'];
}

/** The resolved session: a video, its timeline, and the context handed to `renderFrame`. */
export interface RenderSession {
  readonly video: Video;
  readonly options: PipelineOptions;
  /** The scene timeline, or `null` when the video defines no scenes. */
  readonly scenes: ResolvedScenesTimeline | null;
  /** The video's audio map with the scene maps flattened onto the video timeline. */
  readonly audioMap: AudioMap;
  /** Duration in frames, already resolved. */
  readonly durationInFrames: number;
  /** The index every command resolves `--at` / `--frame-range` against. */
  readonly index: TimelineIndex;
  /** The context, shared by every frame. */
  readonly context: FFramesContext;
  /** The output size at the current `scale`. */
  readonly size: RenderSize;
  /** Media directory, `null` when the video has no media. */
  readonly mediaDir: MediaDirectory | null;
  /** Resolves the duration of a media file, for `fromAudio` and `Eof` ranges. */
  readonly resolveAudioDuration: (file: string) => number | null;
  /** Decoded audio, memoized: two tracks on one file must not decode it twice. */
  readonly audioCache: Map<string, DecodedAudio>;
  /**
   * Why the audio map could not be resolved, `null` when it could.
   *
   * Set when a track's range ends at `Eof` and the file is not in the media directory, so
   * {@link resolveDuration} had no duration to work with. `inspect` reports it as `missing-media`;
   * the other commands carry on with the duration the scenes or the literal give.
   */
  readonly audioResolveError: string | null;
}

/** `VideoSize::new_scaled` — the size `ctx.currentVideoSize` reports. */
export function videoSize(width: number, height: number, scale: number = 1): RenderSize {
  return scaledSize(width, height, scale);
}

/**
 * The duration of a media file, probed synchronously.
 *
 * `ResolveAudioDuration` is a plain function in this port (`core/duration.ts`), and
 * `Scenes.resolveTimeline` / `toFrames` are synchronous like the Rust originals, so the probe has
 * to be synchronous too. `ffprobe` runs once per distinct file and the result is memoized, which
 * is what `Previewer` does with its media cache. The async form
 * (`media/audio-decode.ts` `probeDurationSeconds`) is what the non-CLI API uses.
 */
export function probeDurationSync(filePath: string): number | null {
  try {
    const stdout = execFileSync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', filePath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed: unknown = JSON.parse(stdout);
    const duration = (parsed as { format?: { duration?: unknown } }).format?.duration;
    const seconds = typeof duration === 'string' ? Number(duration) : duration;
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * Decodes an audio file synchronously, the fallback behind `ctx.getAudio`.
 *
 * The Rust `Previewer` preloads every media file before the first frame, so `ctx.get_audio` is a
 * map lookup there. Here decoding is asynchronous (`decodeSessionAudio`) because the render loop
 * is async, but `renderFrame` is **not**: a scene that draws a spectrum with
 * `frame.visualizeAudioFrame(ctx.getAudio('track.wav'))` has to find the samples. So the first
 * `getAudio` of a file decodes it in a subprocess and caches it; every later read is a map lookup,
 * and a video that never asks for audio never spawns ffmpeg.
 */
function decodeAudioSync(filePath: string, sampleRate: number): DecodedAudio {
  const bytes = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', filePath, '-f', 'f32le', '-ac', '2', '-ar', String(sampleRate), 'pipe:1'],
    // A 10 minute stereo track is ~200 MiB of f32le, well past the 1 MiB default.
    { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const [left, right] = deinterleave(parseF32le(bytes), 2);
  return new DecodedAudio(left ?? new Float32Array(0), sampleRate, right ?? null);
}

/** The timeline of a video, or `null` when it defines no scenes. */
export function resolveScenes(
  fps: number,
  scenes: Scenes,
  resolveAudioDuration: (file: string) => number | null,
): ResolvedScenesTimeline | null {
  if (scenes.isEmpty()) {
    return null;
  }
  return scenes.resolveTimeline(fps, resolveAudioDuration);
}

/** Shifts every range of a map later on the timeline by `offsetSeconds`. */
function offsetMap(map: AudioMap, offsetSeconds: number): AudioMap {
  if (map.isNone() || offsetSeconds === 0) {
    return map;
  }
  const shifted = (map.tracks ?? []).map((track) => {
    const start = (track.range.start ?? 0) + offsetSeconds;
    const end = track.range.end === undefined ? undefined : track.range.end + offsetSeconds;
    return new AudioTrack(track.file, { start, ...(end === undefined ? {} : { end }) }, track.mix);
  });
  return AudioMap.of(shifted);
}

/**
 * The audio map of a video with the scene maps flattened onto the video timeline.
 *
 * `AudioMap::unstable_flatten_with_scenes` shifts each scene map by the scene's start time; a
 * scene's map is relative to the scene timestamp, not to the video, so the shift is what makes the
 * two comparable.
 */
export function flattenAudioMap(video: Video, scenes: ResolvedScenesTimeline | null): AudioMap {
  const base = video.audio();
  if (scenes === null) {
    return base;
  }
  const sceneMaps: AudioMap[] = [];
  for (const entry of scenes.timeline) {
    const audio = entry.scene.audio;
    if (audio === undefined) {
      continue;
    }
    sceneMaps.push(offsetMap(audio(), entry.startFrame / video.fps));
  }
  return base.flattenWithScenes(sceneMaps);
}

/** What {@link resolveDuration} came up with. */
export interface DurationResolution {
  /** The video's length in frames. */
  readonly durationInFrames: number;
  /** Why the audio map could not be resolved, `null` when it could. */
  readonly audioResolveError: string | null;
}

/**
 * The resolved duration in frames: scenes for `auto`, then the audio map, then the literal.
 *
 * Resolving the audio map needs the duration of every `Eof` track, and a file that is not in the
 * media directory has none. That is a **missing-media** problem, not a reason to refuse to build a
 * session: the whole point of `inspect` is to report it. So the failure is captured in
 * {@link RenderSession.audioResolveError} and the resolution continues with whatever the other
 * sources can say. The error surfaces as a `missing-media` finding (see `inspect/diagnostics.ts`).
 *
 * A duration that still cannot be resolved — `auto` with no scenes and no usable audio map — *is*
 * fatal, because there is no frame to render and no frame to inspect.
 */
export function resolveDuration(
  video: Video,
  scenes: ResolvedScenesTimeline | null,
  audioMap: AudioMap,
  resolveAudioDuration: (file: string) => number | null,
): DurationResolution {
  let resolved: ResolvedAudioTrack[] = [];
  let audioResolveError: string | null = null;

  try {
    resolved = resolve(audioMap, {
      fps: video.fps,
      sampleRate: DEFAULT_SAMPLE_RATE,
      resolveAudioDuration,
    });
  } catch (error) {
    audioResolveError = error instanceof Error ? error.message : String(error);
  }

  try {
    return {
      durationInFrames: toFrames(video.duration(), video.fps, {
        resolveAudioDuration,
        scenesDurationInFrames: scenes?.totalDurationInFrames,
        audioMap: { tracks: resolved },
      }),
      audioResolveError,
    };
  } catch (error) {
    // `auto` with no scenes and no resolvable audio map cannot say how long the video is. There is
    // nothing to render and nothing to inspect, so this one is fatal — a zero length video would
    // hide the problem instead of reporting it.
    throw new Error(
      `Duration: ${error instanceof Error ? error.message : String(error)} (fps ${String(video.fps)}, ` +
        `${scenes === null ? 'no scenes' : `${String(scenes.totalDurationInFrames)} scene frames`})`,
      { cause: error },
    );
  }
}

/**
 * Builds the session a command works with.
 *
 * ```ts
 * const session = createRenderSession(video, { fps: video.fps, width: video.width, height: video.height });
 * const png = renderFramePng(session, 0);
 * ```
 *
 * The probe is memoized per file and only runs for a video that actually needs one (`fromAudio`,
 * an `Eof` range, or `auto` without scenes).
 */
export function createRenderSession(video: Video, options: PipelineOptions): RenderSession {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const mediaDir = options.mediaDir ?? null;
  const scale = options.scale ?? 1;
  const fontFiles = options.fontFiles ?? video.fonts();

  const probed = new Map<string, number | null>();
  const resolveAudioDuration = (file: string): number | null => {
    if (probed.has(file)) {
      return probed.get(file) ?? null;
    }
    const seconds =
      mediaDir !== null && mediaDir.exists(file) ? probeDurationSync(mediaDir.path(file)) : null;
    probed.set(file, seconds);
    return seconds;
  };

  const definedScenes = Scenes.fromValue(video.defineScenes());
  const scenes = resolveScenes(video.fps, definedScenes, resolveAudioDuration);
  const audioMap = flattenAudioMap(video, scenes);
  const { durationInFrames, audioResolveError } = resolveDuration(
    video,
    scenes,
    audioMap,
    resolveAudioDuration,
  );
  const size = videoSize(video.width, video.height, scale);
  const audioCache = new Map<string, DecodedAudio>();
  // Data URIs of images, memoized per file; see `getImage` below.
  const imageCache = new Map<string, string>();

  const context: FFramesContext = {
    timeBase: { fps: video.fps, sampleRate },
    currentVideoSize: size,
    durationInFrames,
    mode: 'renderer',
    scenes,
    definedScenes,
    mediaDir,
    fontFiles,
    resolveAudioDuration,
    renderScenes(frame: Frame): Svgr {
      return renderScenes(frame, video, context, scenes?.timeline);
    },
    scenesAt(globalFrame: number): ResolvedScene[] {
      return (scenes?.timeline ?? []).filter(
        (entry) => globalFrame >= entry.startFrame && globalFrame < entry.endFrame,
      );
    },
    getAudio(file: string): DecodedAudio | null {
      const cached = audioCache.get(file);
      if (cached !== undefined) {
        return cached;
      }
      if (mediaDir === null || !mediaDir.exists(file)) {
        return null;
      }
      const decoded = decodeAudioSync(mediaDir.path(file), sampleRate);
      audioCache.set(file, decoded);
      return decoded;
    },
    getImage(file: string): string | null {
      if (mediaDir === null || !mediaDir.exists(file)) {
        return null;
      }
      const cached = imageCache.get(file);
      if (cached !== undefined) {
        return cached;
      }
      const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
      const mime =
        extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : 'image/jpeg';
      try {
        // Base64 of a whole image is not cheap, and `renderFrame` is called once per frame with
        // the same media every time, so the data URI is memoized per file. The Rust `Previewer`
        // preloads every media file, which is the same effect.
        const uri = `data:${mime};base64,${readFileSync(mediaDir.path(file)).toString('base64')}`;
        imageCache.set(file, uri);
        return uri;
      } catch {
        return null;
      }
    },
    hasMedia(file: string): boolean {
      return mediaDir !== null && mediaDir.exists(file);
    },
  };

  return {
    video,
    options: { ...options, sampleRate, fontFiles, mediaDir, scale },
    scenes,
    audioMap,
    durationInFrames,
    index: new TimelineIndex(
      video.fps,
      durationInFrames,
      (scenes?.timeline ?? []).map(
        (entry): TimelineScene => ({
          index: entry.index,
          name: entry.name,
          fullName: entry.fullName,
          startFrame: entry.startFrame,
          endFrame: entry.endFrame,
        }),
      ),
    ),
    context,
    size,
    mediaDir,
    resolveAudioDuration,
    audioCache,
    audioResolveError,
  };
}

/**
 * `Frame::__internal_make_for_renderer` — the frame handed to `Video.renderFrame`.
 *
 * Both indices are the global one: a `Video` always sees the whole timeline and only
 * `renderScenes` shifts the index for a scene (`Frame::clone_with_scene_offset`).
 */
export function makeFrame(globalFrame: number, fps: number): Frame {
  return new Frame(globalFrame, globalFrame, fps);
}

/**
 * Renders one global frame to an SVG string.
 *
 * A throw from `renderFrame` is wrapped with the frame, the second and the scene, which is the
 * context `render_frame_guarded` adds to the Rust `?` — the Rust panic message names the frame,
 * the second and the scene, and so does this one.
 */
export function renderFrameSvg(session: RenderSession, globalFrame: number): string {
  const frame = makeFrame(globalFrame, session.video.fps);
  try {
    return session.video.renderFrame(frame, session.context).value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sceneNames = session.context
      .scenesAt(globalFrame)
      .map((entry) => entry.name)
      .join(' + ');
    const where = sceneNames === '' ? '' : `, scene ${sceneNames}`;
    throw new Error(
      `renderFrame threw at frame ${globalFrame} (${(globalFrame / session.video.fps).toFixed(2)}s${where}): ${message}`,
      { cause: error },
    );
  }
}

/**
 * Renders one global frame to a PNG, with the black background `pixmap.fill(background_color)`
 * lays down in `cpu.rs:147` (`Video::BACKGROUND_COLOR` is not part of this port's API).
 */
export function renderFramePng(session: RenderSession, globalFrame: number): Buffer {
  return renderSvgToPng(renderFrameSvg(session, globalFrame), {
    width: session.video.width,
    height: session.video.height,
    scale: session.options.scale,
    fontFiles: session.context.fontFiles,
    background: '#000000',
  });
}

/** Decodes every file of the audio map once, keyed by media directory name. */
export async function decodeSessionAudio(
  session: RenderSession,
): Promise<Map<string, DecodedAudio>> {
  const sampleRate = session.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  for (const file of session.audioMap.trackNames()) {
    if (session.audioCache.has(file) || undecodableAudio(session).has(file)) {
      continue;
    }
    if (session.mediaDir === null || !session.mediaDir.exists(file)) {
      continue;
    }
    try {
      session.audioCache.set(
        file,
        await decodeAudioFileStereo(session.mediaDir.path(file), sampleRate),
      );
    } catch (error) {
      // Rust skips a track whose audio can not be preloaded and reports it as missing
      // (`audio_mix.rs:416-427`: `AudioData::Lazy => continue`, `None => report + push missing`).
      // Letting ffmpeg's failure escape here instead killed the whole render, which is exactly the
      // path `resolveSessionAudio`'s doc calls out as wrong. The file is remembered as
      // undecodable so the render reports it as missing and the track stays silent; the reason
      // rides along for the commands that want to print it.
      undecodableAudio(session).set(
        file,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return session.audioCache;
}

/**
 * The files of the audio map that exist in the media directory but could not be decoded, mapped to
 * the reason ffmpeg gave.
 *
 * They are reported exactly like an absent file (`missingAudioFiles` in `render`, `missingFiles` in
 * `audio`), because that is the same outcome for the caller: the track contributes no samples and
 * the mix stays silent for it. Rust keeps the two apart internally (`AudioData::Lazy` vs `None`) but
 * only ever exposes the joined `missing` list to the CLI.
 */
export function undecodableAudio(session: RenderSession): Map<string, string> {
  let cached = undecodableAudioCache.get(session);
  if (cached === undefined) {
    cached = new Map<string, string>();
    undecodableAudioCache.set(session, cached);
  }
  return cached;
}

/**
 * `AudioMixer::missing_files` — the files the audio map names that yield no samples.
 *
 * Rust decides this from the media provider, not from the decode cache: `resolve_audio` returning
 * `None` is the only thing pushed onto `missing`, and a file that cannot be preloaded is skipped
 * the same way (`audio_mix.rs:416-427`). Asking the cache instead reported every track of a
 * healthy video, because the cache is still empty when the report is produced — nothing is decoded
 * until the mix, and it stays empty whenever the mix was skipped.
 *
 * Three arguments rather than a session, so the rule is callable (and testable) without building
 * one: {@link missingAudioFilesOf} is the session-shaped wrapper both CLI commands use.
 */
export function missingAudioFiles(
  trackNames: Iterable<string>,
  mediaDir: MediaDirectory | null,
  undecodable: ReadonlyMap<string, string>,
): string[] {
  const missing: string[] = [];
  for (const file of trackNames) {
    if (mediaDir === null || !mediaDir.exists(file) || undecodable.has(file)) {
      missing.push(file);
    }
  }
  return missing;
}

/**
 * {@link missingAudioFiles} for a session.
 *
 * An unresolvable map yields no tracks at all (`resolveSessionAudio` returns `[]`), so there is
 * nothing to report as missing — the reason is already on the session as `audioResolveError` for
 * `inspect` to turn into a `missing-media` finding.
 */
export function missingAudioFilesOf(session: RenderSession): string[] {
  if (session.audioResolveError !== null) {
    return [];
  }
  return missingAudioFiles(session.audioMap.trackNames(), session.mediaDir, undecodableAudio(session));
}

/** Per session record of undecodable files; `WeakMap` so a session stays collectable. */
const undecodableAudioCache = new WeakMap<RenderSession, Map<string, string>>();

/**
 * The resolved audio tracks of a session, in samples at the session sample rate.
 *
 * Returns `[]` when the map cannot be resolved (see {@link RenderSession.audioResolveError}): the
 * caller mixes nothing, writes a silent track, and the reason is already on the session for
 * `inspect` to report. Throwing here would turn "a referenced file is missing" into "the render
 * command failed", which is not what the Rust port does either — its mixer skips the file and
 * reports it through `missing_files()`.
 */
export function resolveSessionAudio(session: RenderSession): ResolvedAudioTrack[] {
  if (session.audioResolveError !== null) {
    return [];
  }
  return resolve(session.audioMap, {
    fps: session.video.fps,
    sampleRate: session.options.sampleRate ?? DEFAULT_SAMPLE_RATE,
    resolveAudioDuration: session.resolveAudioDuration,
  });
}

/** `AudioTimelineSamples::from_frames` — `frame * sample_rate / fps`, integer division. */
export function framesToSamples(frame: number, fps: number, sampleRate: number): number {
  return Math.trunc((frame * sampleRate) / fps);
}

/**
 * Builds the mixer for a frame range, with every file decoded.
 *
 * This is `mixer_for` (`cli.rs:1049-1072`): the output range is the frame range converted to
 * samples and the total is the whole video in samples, so the limiter latency and the fades know
 * where they are.
 */
export async function createSessionMixer(
  session: RenderSession,
  range: FrameRange,
): Promise<AudioMixer> {
  const sampleRate = session.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const fps = session.video.fps;
  const audio = new Map<string, TrackAudio>();
  for (const [file, decoded] of await decodeSessionAudio(session)) {
    audio.set(file, decoded);
  }

  return new AudioMixer({
    tracks: resolveSessionAudio(session),
    audio,
    sampleRate,
    mapSampleRate: sampleRate,
    outputRange: {
      start: framesToSamples(range.start, fps, sampleRate),
      end: framesToSamples(range.end, fps, sampleRate),
    },
    totalSamples: framesToSamples(session.durationInFrames, fps, sampleRate),
    options: session.options.mixerOptions,
  });
}

/** Renders every frame of a range as a PNG. Serial by contract §7. */
export function* framePngs(
  session: RenderSession,
  range: FrameRange,
  onFrame?: (frame: number) => void,
): Generator<Buffer> {
  for (let frame = range.start; frame < range.end; frame += 1) {
    onFrame?.(frame);
    yield renderFramePng(session, frame);
  }
}
