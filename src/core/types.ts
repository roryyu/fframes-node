/**
 * The user facing contracts: `Video`, `Scene`, `FFramesContext` and `RenderOptions`.
 *
 * Port of `Video` / `Scene` from `.source/fframes/fframes/src/video.rs` and `scenes.rs`, and of
 * `FFramesContext` from `fframes_context.rs`. A `Video` is a plain object (or a class instance)
 * with these members — see README.md for a complete example.
 */

import type { AudioMap, Ducking, FadeCurve } from '../audio/audio-map.ts';
import type { DecodedAudio } from '../media/audio-decode.ts';
import type { MediaDirectory } from '../media/media-dir.ts';
import type { Duration, ResolveAudioDuration } from './duration.ts';
import type { Frame } from './frame.ts';
import type { ResolvedScene, ResolvedScenesTimeline, Scenes } from './scenes.ts';
import type { Svgr } from './svgr.ts';

/** `TimeBase` — the fps of the video and the sample rate of the audio. */
export interface TimeBase {
  readonly fps: number;
  readonly sampleRate: number;
}

/** `VideoSize` — the size the current frame is rendered at, after any scaling. */
export interface VideoSize {
  readonly width: number;
  readonly height: number;
}

/** `FFramesMode` — where the frame is being produced. */
export type FFramesMode = 'editor' | 'editorTimelinePreview' | 'renderer';

/** `SampleSize` — the FFT window used by {@link VisualizeFrameInput}. */
export type SampleSize = 256 | 512;

/** `WindowFunction` — the window applied before the FFT. */
export type WindowFunction = 'hann' | 'hamming' | 'blackman' | 'none';

/** `VisualizeFrameInput` — input of `Frame.visualizeAudioFrame`. */
export interface VisualizeFrameInput {
  /** The audio to analyse, already decoded to samples. */
  readonly audio: DecodedAudio;
  /** FFT window size. */
  readonly sampleSize: SampleSize;
  /** How many frames on each side are averaged into the spectrum. */
  readonly smoothLevel: number;
  /** Window function, `hann` by default in the renderer. */
  readonly window?: WindowFunction;
}

/**
 * `Scene` — one part of the video, with its own duration and its own `renderFrame`.
 *
 * Inside a scene `frame.index` is relative to the scene start, so the first frame of a scene
 * always reports `index === 0`.
 */
export interface Scene {
  /** Overrides the scene name derived from the class name. */
  readonly name?: string;
  /** Duration of the scene. */
  duration(): Duration;
  /** Audio this scene adds on top of the video audio map. */
  audio?(): AudioMap;
  /** Renders one frame of the scene. */
  renderFrame(frame: Frame, ctx: FFramesContext): Svgr;
}

/**
 * `FFramesContext` — everything a `Video` or a `Scene` can read besides the frame itself.
 *
 * The renderer builds one context per frame (it is cheap to share, the members are read-only).
 */
export interface FFramesContext {
  /** The time base of the video. */
  readonly timeBase: TimeBase;
  /** The size the current frame is rendered at — use it for the `viewBox`. */
  readonly currentVideoSize: VideoSize;
  /** Total duration of the video, in frames. */
  readonly durationInFrames: number;
  /** Where the frame is being produced. */
  readonly mode: FFramesMode;
  /** The resolved scene timeline, `null` when the video defines no scenes. */
  readonly scenes: ResolvedScenesTimeline | null;
  /** The scenes as declared by the video, before resolution. */
  readonly definedScenes: Scenes | null;
  /** The media directory files are resolved from, `null` when the video has no media. */
  readonly mediaDir: MediaDirectory | null;
  /** Font files registered for this render, from `Video.fonts()`. */
  readonly fontFiles: readonly string[];
  /** Duration of a media file in seconds, `null` when it can not be probed. */
  readonly resolveAudioDuration: ResolveAudioDuration | null;
  /** Renders every scene that contains `frame` and concatenates the results. */
  renderScenes(frame: Frame): Svgr;
  /** The scenes visible at a global frame. */
  scenesAt(globalFrame: number): ResolvedScene[];
  /** A decoded audio file from the media directory, `null` when it does not exist. */
  getAudio(file: string): DecodedAudio | null;
  /** An image as a data URI, `null` when the file does not exist. */
  getImage(file: string): string | null;
  /** Whether a media file exists in the media directory. */
  hasMedia(file: string): boolean;
}

/**
 * `Video` — a whole video: its geometry, its length, its audio and how to render a frame.
 *
 * ```ts
 * const video: Video = {
 *   fps: 30,
 *   width: 1920,
 *   height: 1080,
 *   duration: () => auto,
 *   audio: () => AudioMap.none(),
 *   defineScenes: () => Scenes.from([new SceneOne(), new SceneTwo()]),
 *   fonts: () => ['/System/Library/Fonts/Helvetica.ttc'],
 *   renderFrame: (frame, ctx) => svgr`<svg …>${ctx.renderScenes(frame)}</svg>`,
 * };
 * ```
 */
export interface Video {
  /** Frames per second. */
  readonly fps: number;
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
  /** What `render` writes when no `-o` is given. */
  readonly defaultOutput?: string;
  /** Length of the video; `auto` infers it from the scenes or the audio map. */
  duration(): Duration;
  /** The audio tracks placed on the timeline. */
  audio(): AudioMap;
  /** The scenes of the video, or an empty list. */
  defineScenes(): Scenes | readonly Scene[] | null | undefined;
  /** Font files to register for the render; referenced from SVG by family name. */
  fonts(): readonly string[];
  /** Renders one frame. Called once per frame, so keep it allocation light. */
  renderFrame(frame: Frame, ctx: FFramesContext): Svgr;
}

/** How the `render` command should behave. */
export interface RenderOptions {
  /** Where to write the video; `Video.defaultOutput` or `out.mp4` by default. */
  readonly output?: string | null;
  /** First frame to render, inclusive. */
  readonly frameStart?: number | null;
  /** Last frame to render, exclusive. */
  readonly frameEnd?: number | null;
  /** Resolution multiplier; `--draft` uses `0.5` unless this is set. */
  readonly scale?: number | null;
  /** Half resolution and the fastest libx264 preset. */
  readonly draft?: boolean;
  /** Media directory used to resolve audio and images. */
  readonly mediaDir?: MediaDirectory | null;
  /** Font files; defaults to `Video.fonts()`. */
  readonly fontFiles?: readonly string[] | null;
  /** Ducking defaults applied to tracks that do not define their own. */
  readonly ducking?: Ducking | null;
  /** Fade curve applied to tracks that do not define their own. */
  readonly fadeCurve?: FadeCurve | null;
  /** Progress callback, called with the frame being encoded. */
  readonly onProgress?: ((frame: number, totalFrames: number) => void) | null;
}

/** A finding of `inspect`, mirroring `fframes::diagnostics`. */
export interface InspectFinding {
  readonly frame: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly kind: string;
  readonly message: string;
  readonly count?: number;
}

export interface InspectResult {
  readonly findings: readonly InspectFinding[];
  readonly checkedFrames: number;
  readonly exitCode: number;
}
