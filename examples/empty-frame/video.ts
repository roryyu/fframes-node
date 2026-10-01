/**
 * `empty-frame` — a video whose frame draws nothing, for `inspect`'s `empty-frame` check.
 *
 * `renderFrame` returns `Svgr.empty()` (the empty string), which the guidance actively recommends
 * for "nothing this frame" (a missing video/image frame → `return Svgr.empty()`). The empty string
 * is a legal frame value, but `rasterize` rejects it, so this is exactly the frame that used to take
 * the whole `inspect` run down with exit 1 instead of producing the `empty-frame` warning the check
 * exists for. This fixture is the CLI-level regression lock for that fix (FIX13); the function-level
 * lock is `test/inspect-frame.test.ts`.
 *
 * ```sh
 * node src/cli/main.ts examples/empty-frame/video.ts inspect --json; echo $?   # 0, with a finding
 * ```
 *
 * `empty-frame` is a warning, and `--exit-code` defaults to `error`, so the run exits 0 — the point
 * is that it reports rather than crashes.
 */

import { Svgr, seconds, AudioMap } from '../../src/index.ts';
import type { Video, FFramesContext, Frame } from '../../src/index.ts';

class EmptyFrameVideo implements Video {
  readonly fps = 30;
  readonly width = 320;
  readonly height = 180;
  readonly defaultOutput = 'empty-frame.mp4';

  duration() {
    return seconds(1);
  }

  defineScenes(): null {
    return null;
  }

  audio(): AudioMap {
    return AudioMap.none();
  }

  fonts(): string[] {
    return [];
  }

  /** The legal "nothing this frame" value: an empty SVG document. */
  renderFrame(_frame: Frame, _ctx: FFramesContext): Svgr {
    return Svgr.empty();
  }
}

export default new EmptyFrameVideo();
