/**
 * `broken-video` — a video with exactly two problems, for `inspect`.
 *
 * Structurally normal: one scene, a real font file, a duration. Two references point at nothing:
 *
 * - `font-family="DefinitelyMissingFont-XYZ"`, while `fonts()` registers Helvetica, which is what
 *   `missing-font` has to catch,
 * - an `AudioMap` track on `'nope.wav'`, which is not in the media directory, which is what
 *   `missing-media` has to catch.
 *
 * ```sh
 * node src/cli/main.ts examples/broken-video/video.ts inspect; echo $?   # 2
 * node src/cli/main.ts examples/broken-video/video.ts inspect --json
 * ```
 *
 * The exit code is 2 because both findings are errors and `--exit-code` defaults to `error`. The
 * frame is not empty (it has a background rect), so no `empty-frame` is reported — a third
 * `broken-video`-style check would be a frame that draws nothing.
 */

import { svgr, seconds, AudioMap, audioTrack } from '../../src/index.ts';
import type { Svgr, Video, FFramesContext, Frame } from '../../src/index.ts';

class BrokenVideo implements Video {
  readonly fps = 30;
  readonly width = 640;
  readonly height = 360;
  readonly defaultOutput = 'broken.mp4';

  duration() {
    return seconds(2);
  }

  /** The one problem for `missing-media`: the file is not in `media/`. */
  audio(): AudioMap {
    return AudioMap.of([audioTrack('nope.wav')]);
  }

  /** The interface requires `defineScenes`; this example has no scenes, and `null` is how the port
   * says so — `Scenes::default()` in Rust, which `Scenes.fromValue(null)` reads as an empty
   * timeline. */
  defineScenes(): null {
    return null;
  }

  /** The registered font is Helvetica; the frame asks for something else. */
  fonts(): string[] {
    return ['/System/Library/Fonts/Helvetica.ttc'];
  }

  renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">
      <rect width="${this.width}" height="${this.height}" fill="#1f2937" />
      <text x="40" y="140" font-family="DefinitelyMissingFont-XYZ" font-size="40" fill="#f9fafb">this font does not exist</text>
      <text x="40" y="220" font-family="Helvetica" font-size="28" fill="#9ca3af">frame ${frame.index}</text>
    </svg>`;
  }
}

export default new BrokenVideo();
