// Mock fixture for offline/gate runs. `llm.generateVideoSource` in mock mode returns this verbatim;
// `projects.writeSource` then normalizes the import specifier to '../../../src/index.ts' (gate S6).
// The import below is deliberately at the WRONG depth ('../../src/index.ts') so normalization is
// actually exercised end to end. Not part of the tsc project (.studio/** is gitignored + excluded).
import { svgr, seconds, timeline, Easing, Color, AudioMap } from '../../src/index.ts';
import type { Video, Scene, Frame, FFramesContext, Svgr, Duration } from '../../src/index.ts';

const BACKGROUND = timeline<Color>(
  { start: 0, end: 5, from: Color.fromHex('#0b1e3a'), to: Color.fromHex('#123a6b'), easing: Easing.linear },
);

class MockStudioVideo implements Video {
  readonly fps = 30;
  readonly width = 1920;
  readonly height = 1080;

  duration(): Duration {
    return seconds(5);
  }

  audio(): AudioMap {
    return AudioMap.none();
  }

  defineScenes(): readonly Scene[] | null {
    return null;
  }

  fonts(): string[] {
    return ['/System/Library/Fonts/Helvetica.ttc'];
  }

  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    const bg = frame.animate(BACKGROUND);
    const logo = ctx.getImage('asset.png');
    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">
      <rect width="${this.width}" height="${this.height}" x="0" y="0" fill="${bg}" />
      ${logo === null ? '' : svgr`<image href="${logo}" x="760" y="120" width="400" height="400" preserveAspectRatio="xMidYMid meet" />`}
      <text font-family="Helvetica" x="960" y="720" font-size="120" fill="#ffffff" text-anchor="middle">Hello fframes</text>
    </svg>`;
  }
}

export default new MockStudioVideo();
