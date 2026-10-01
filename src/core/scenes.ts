/**
 * Scenes: splitting a long video into independently timed parts.
 *
 * Port of `.source/fframes/fframes/src/scenes.rs` plus the timeline resolution of
 * `ResolvedScenesTimeline::from_scenes` in `video.rs`.
 *
 * Scenes are placed on the timeline back to back in the order they are defined; there is no
 * cross-fade between them in this port (`Scene::overlap` is out of scope, see PORTING.md), so a
 * frame belongs to at most one scene.
 */

import { toFrames, type ResolveAudioDuration } from './duration.ts';
import { Frame } from './frame.ts';
import { concatSvgr, type Svgr } from './svgr.ts';
import { shortSceneName } from './time-spec.ts';
import type { Scene, Video, FFramesContext } from './types.ts';

/** `SceneInfo` + the resolved name and the scene itself. */
export interface ResolvedScene {
  /** Index of the scene in the video, 0-based. */
  readonly index: number;
  /** Short name, e.g. `Intro`. */
  readonly name: string;
  /** Name as reported by the scene. */
  readonly fullName: string;
  /** First frame of the scene, inclusive. */
  readonly startFrame: number;
  /** Last frame of the scene, exclusive. */
  readonly endFrame: number;
  /** Resolved duration of the scene in frames. */
  readonly durationInFrames: number;
  /** `true` when this is the last scene of the video. */
  readonly isLast: boolean;
  /** How many scenes the video defines. */
  readonly totalScenes: number;
  /** The scene implementation. */
  readonly scene: Scene;
}

/** `ResolvedScenesTimeline` */
export interface ResolvedScenesTimeline {
  /** Sum of the scene durations, in frames. */
  readonly totalDurationInFrames: number;
  /** The scenes in timeline order. */
  readonly timeline: readonly ResolvedScene[];
}

/** `Scenes::from(scenes)` — the ordered list of scenes of a video. */
export class Scenes {
  readonly list: readonly Scene[];

  constructor(list: readonly Scene[] = []) {
    this.list = list;
  }

  /** `Scenes::from(vec![...])` */
  static from(scenes: Iterable<Scene> | null | undefined): Scenes {
    if (scenes === null || scenes === undefined) {
      return new Scenes([]);
    }
    return new Scenes([...scenes]);
  }

  /** `Scenes::empty()` */
  static empty(): Scenes {
    return new Scenes([]);
  }

  /** Normalizes a `Scene[]` or an existing `Scenes` into a `Scenes`. */
  static fromValue(value: Scenes | readonly Scene[] | null | undefined): Scenes {
    if (value instanceof Scenes) {
      return value;
    }
    return Scenes.from(value ?? null);
  }

  get length(): number {
    return this.list.length;
  }

  /** `Scenes::is_empty` */
  isEmpty(): boolean {
    return this.list.length === 0;
  }

  /**
   * `ResolvedScenesTimeline::from_scenes` — places every scene after the previous one and
   * resolves each duration against `fps`.
   *
   * `resolveAudioDuration` is needed when a scene duration is `fromAudio(...)`.
   */
  resolveTimeline(fps: number, resolveAudioDuration?: ResolveAudioDuration): ResolvedScenesTimeline {
    const scenesCount = this.list.length;
    const resolved: ResolvedScene[] = [];
    let finalDuration = 0;

    for (let index = 0; index < scenesCount; index += 1) {
      const scene = this.list[index] as Scene;
      const duration = toFrames(scene.duration(), fps, { resolveAudioDuration });
      const startFrame = finalDuration;
      const endFrame = finalDuration + duration;

      resolved.push({
        index,
        name: sceneName(scene),
        fullName: sceneFullName(scene),
        startFrame,
        endFrame,
        durationInFrames: duration,
        isLast: index === scenesCount - 1,
        totalScenes: scenesCount,
        scene,
      });

      finalDuration += duration;
    }

    return { totalDurationInFrames: finalDuration, timeline: resolved };
  }

  /** Resolves the timeline only when the video defines scenes. */
  tryResolveTimeline(
    fps: number,
    resolveAudioDuration?: ResolveAudioDuration,
  ): ResolvedScenesTimeline | null {
    if (this.isEmpty()) {
      return null;
    }
    return this.resolveTimeline(fps, resolveAudioDuration);
  }

  /** The resolved timeline, or an empty one when the video defines no scenes. */
  static emptyTimeline(): ResolvedScenesTimeline {
    return { totalDurationInFrames: 0, timeline: [] };
  }
}

/** The name of a scene: the explicit `name` when present, otherwise the class name. */
export function sceneName(scene: Scene): string {
  if (typeof scene.name === 'string' && scene.name.length > 0) {
    return shortSceneName(scene.name);
  }
  return shortSceneName(scene.constructor.name || 'Scene');
}

/** The name of a scene exactly as reported, without the module path. */
export function sceneFullName(scene: Scene): string {
  if (typeof scene.name === 'string' && scene.name.length > 0) {
    return scene.name;
  }
  return scene.constructor.name || 'Scene';
}

/**
 * `FFramesContext::render_scenes` — renders every scene that contains `frame`.
 *
 * Each scene receives a frame shifted by the scene start (`Frame::clone_with_scene_offset`), so
 * `frame.index` and `frame.seconds()` inside a scene are relative to the scene while
 * `frame.globalIndex` still points into the whole video. The results are concatenated in timeline
 * order; an empty `Svgr` is returned when no scene covers the frame.
 */
export function renderScenes(
  frame: Frame,
  video: Video,
  ctx: FFramesContext,
  timeline?: readonly ResolvedScene[],
): Svgr {
  const resolved =
    timeline ??
    ctx.scenes?.timeline ??
    Scenes.fromValue(video.defineScenes()).resolveTimeline(
      frame.fps,
      ctx.resolveAudioDuration ?? undefined,
    ).timeline;

  const parts: Svgr[] = [];
  for (const entry of resolved) {
    if (frame.index >= entry.startFrame && frame.index < entry.endFrame) {
      parts.push(entry.scene.renderFrame(Frame.cloneWithSceneOffset(frame, entry.startFrame), ctx));
    }
  }

  return concatSvgr(parts);
}

export { shortSceneName };
