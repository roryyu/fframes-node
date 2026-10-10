/**
 * `typeset-card` — Chinese typography cards: the ported typeset module, used as a video.
 *
 * Three vertical cards (1080×1440) share one visual system: a serif body face (Songti SC), a
 * sans title face (Hiragino Sans GB), the semantic Chinese wrapping and the scale ladder of
 * `renderCard` (the content decides how large the type can be). Every block fades in through
 * `appear`, driven by the scene-local time — a mid-fade frame is a single `frame` command away.
 *
 * ```sh
 * node src/cli/main.ts examples/typeset-card/video.ts render -o typeset-card.mp4
 * node src/cli/main.ts examples/typeset-card/video.ts frame 1.2 --draft -o cover-1.2.png
 * node src/cli/main.ts examples/typeset-card/video.ts timeline
 * ```
 */

import { auto, AudioMap, FontMetrics, cardScene, svgr } from '../../src/index.ts';
import type { CardSpec, FFramesContext, Frame, Scene, Video } from '../../src/index.ts';

const SONG = '/System/Library/Fonts/Supplemental/Songti.ttc';
const HEI = '/System/Library/Fonts/Hiragino Sans GB.ttc';

const songFace = { family: 'Songti SC', metrics: FontMetrics.load(SONG, { index: 0 }) };
const heiFace = { family: 'Hiragino Sans GB W3', metrics: FontMetrics.load(HEI, { index: 0 }) };

const WIDTH = 1080;
const HEIGHT = 1440;

/** The shared card skin; the three scenes only differ in their blocks. */
const BASE = {
  width: WIDTH,
  height: HEIGHT,
  background: '#f7f4ee',
  face: songFace,
  titleFace: heiFace,
  accent: '#b4231f',
} satisfies Omit<CardSpec, 'blocks'>;

/** Cover: the claim, a rule, and the subtitle on a smaller scale. */
const cover = cardScene(
  {
    ...BASE,
    blocks: [
      { kind: 'text', text: '把话断在\n该断的地方', role: 'title', appear: { at: 0.15, dur: 0.7 } },
      { kind: 'rule', appear: { at: 0.8, dur: 0.5 } },
      { kind: 'text', text: '中文排版的断行 · 排字 · 自动适配', role: 'note', appear: { at: 1.05, dur: 0.6 } },
    ],
    footer: 'fframes-node · typeset',
  },
  3.2,
  'Cover',
);

/** Body: a justified paragraph, the quote in the middle, the point at the end. */
const body = cardScene(
  {
    ...BASE,
    blocks: [
      { kind: 'text', text: '为什么读得下去', role: 'heading', appear: { at: 0.15, dur: 0.6 } },
      {
        kind: 'text',
        text:
          '好的排版是让读者忘记排版本身。每一处断行都应当顺应语义，' +
          '让目光自然地落在下一行的开头，而不是在读句的半途跌一跤。',
        role: 'body',
        justify: true,
        appear: { at: 0.55, dur: 0.8 },
      },
      { kind: 'text', text: '「断行是呼吸，不是裁切。」', role: 'note', align: 'center', appear: { at: 1.15, dur: 0.6 } },
    ],
  },
  3.6,
  'Body',
);

/** Closing: the mechanism, centred and larger than the body. */
const closing = cardScene(
  {
    ...BASE,
    blocks: [
      { kind: 'spacer', height: HEIGHT * 0.16 },
      {
        kind: 'text',
        text: '六个档位试排\n间距弹性匀开\n放不下就报错',
        role: 'emphasis',
        align: 'center',
        appear: { at: 0.2, dur: 0.7 },
      },
    ],
    footer: '不自动裁字，不缩到看不清',
  },
  2.6,
  'Closing',
);

class TypesetCard implements Video {
  readonly fps = 30;
  readonly width = WIDTH;
  readonly height = HEIGHT;

  duration() {
    return auto;
  }

  audio(): AudioMap {
    return AudioMap.none();
  }

  defineScenes(): readonly Scene[] {
    return [cover, body, closing];
  }

  /** Exactly the two fonts the cards ask for; the resvg backend registers only these. */
  fonts(): string[] {
    return [SONG, HEI];
  }

  renderFrame(frame: Frame, ctx: FFramesContext) {
    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
      ${ctx.renderScenes(frame)}
    </svg>`;
  }
}

export default new TypesetCard();
