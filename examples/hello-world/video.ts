/**
 * `hello-world` — the two scene example, ported from the Rust original.
 *
 * Line by line from `.source/fframes/examples/hello-world/src/hello_world_multiscene.rs`:
 * 30 fps, 1920x1080, `Duration::Auto`, `SceneOne` and `SceneTwo` of 15 s each, the same six stop
 * background animation, the same two scenes with the same markup, and the same frame index / second
 * text in the corner.
 *
 * Two deliberate changes, both forced by the port rather than chosen:
 *
 * - `font-family` is `Helvetica` and `fonts()` returns `/System/Library/Fonts/Helvetica.ttc`. The
 *   Rust example asks for `DM Sans` and `JetBrains Mono`, which live in the example's own media
 *   folder; shipping a 2.3 MB font is not something an example should do, and the resvg backend
 *   registers exactly the files `fonts()` lists.
 * - `Easing::Linear(0.2)` in `SceneTwo` is a linear tween with a **duration**; the port spells that
 *   as an explicit `end` on the keyframe, which is what `KeyFramesAnimation::new` computes from it.
 *
 * ```sh
 * # from the fframes-node directory
 * node src/cli/main.ts examples/hello-world/video.ts render -o hello.mp4
 * node src/cli/main.ts examples/hello-world/video.ts timeline
 * node src/cli/main.ts examples/hello-world/video.ts inspect --every-frame
 * ```
 */

import { svgr, Svgr, seconds, timeline, Easing, AudioMap, Color, auto } from '../../src/index.ts';
import type { Scene, Video, FFramesContext, Frame } from '../../src/index.ts';

/** `SceneOne` — 15 s, static text and two green rects, one of them rotated. */
class SceneOne implements Scene {
  readonly name = 'SceneOne';

  duration() {
    return seconds(15);
  }

  renderFrame(_frame: Frame, _ctx: FFramesContext): Svgr {
    return svgr`<text font-family="Helvetica" x="100" y="300" font-size="150">hello scene 1</text>
      <g id="g1" transform="scale(1)">
        <rect id="rect1" x="0" y="0" width="120" height="120" fill="green" />
      </g>
      <g id="g2" transform="rotate(45)" transform-origin="top left">
        <rect id="rect1" x="0" y="0" width="120" height="120" fill="green" />
      </g>`;
  }
}

/** `SceneTwo` — 15 s, the text drifts from y=300 to y=320 over 0.2 s. */
class SceneTwo implements Scene {
  readonly name = 'SceneTwo';

  duration() {
    return seconds(15);
  }

  renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
    return svgr`<text
        x="100"
        font-size="150"
        font-family="Helvetica"
        y="${frame.animate(
          timeline<number>(
            { start: 0, end: 0.2, from: 300, to: 320, easing: Easing.linear },
          ),
        )}"
      >Hello Scene 2</text>`;
  }
}

/**
 * The background: six 5 second stops.
 *
 * `animation::Easing::Linear(5.)` in the Rust source is a linear tween of 5 seconds, so every
 * keyframe carries `end: start + 5`. The colors are copied from the Rust source verbatim.
 */
const BACKGROUND = timeline<Color>(
  { start: 0, end: 5, from: Color.fromHex('#fff'), to: Color.fromHex('#f8fafc'), easing: Easing.linear },
  { start: 5, end: 10, from: Color.fromHex('#f8fafc'), to: Color.fromHex('#fff7ed'), easing: Easing.linear },
  { start: 10, end: 15, from: Color.fromHex('#fff7ed'), to: Color.fromHex('#fef2f2'), easing: Easing.linear },
  { start: 15, end: 20, from: Color.fromHex('#fef2f2'), to: Color.fromHex('#f7fee7'), easing: Easing.linear },
  { start: 20, end: 25, from: Color.fromHex('#f7fee7'), to: Color.fromHex('#ecfdf5'), easing: Easing.linear },
  { start: 25, end: 30, from: Color.fromHex('#ecfdf5'), to: Color.fromHex('#faf5ff'), easing: Easing.linear },
);

class HelloWorld implements Video {
  readonly fps = 30;
  readonly width = 1920;
  readonly height = 1080;

  /** `Duration::Auto` is a value in Rust too — the unit variant, not a constructor call. */
  duration() {
    return auto;
  }

  audio(): AudioMap {
    return AudioMap.none();
  }

  defineScenes(): readonly Scene[] {
    return [new SceneOne(), new SceneTwo()];
  }

  /** The only font the renderer loads; `loadSystemFonts` is off (see PORTING.md). */
  fonts(): string[] {
    return ['/System/Library/Fonts/Helvetica.ttc'];
  }

  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">
      <rect width="${this.width}" height="${this.height}" x="0" y="0" fill="${frame.animate(BACKGROUND)}" />
      ${ctx.renderScenes(frame)}
      <text font-weight="500" font-family="Helvetica" x="100" y="440" font-size="74" fill="#4b5563">This frame index: ${frame.index}, second: ${frame.seconds().toFixed(2)}</text>
    </svg>`;
  }
}

export default new HelloWorld();
