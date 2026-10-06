/**
 * Art Styles Demo — showcases the integrated huashu-art-motion styles.
 * 
 * A journey through art history: cave painting → Van Gogh → Bauhaus → Pop Art → 8-bit → Vaporwave → Ink.
 * Each scene demonstrates the style's signature visual language and motion.
 */

import { svgr, seconds, timeline, Easing, AudioMap, Color, auto } from '../../src/index.ts';
import type { Scene, Svgr, Video, FFramesContext, Frame } from '../../src/index.ts';
import {
  getStyle, getTransition, choreo,
  type ArtStyleParams,
} from '../../src/art/index.ts';
import '../../src/art/styles/index.ts';
import '../../src/art/transitions/index.ts';

const W = 1920;
const H = 1080;

/** Generic art-style scene wrapper */
class ArtScene implements Scene {
  readonly name: string;
  private styleId: string;
  private dur: number;
  private transitionId?: string;
  private transitionDur: number;

  constructor(styleId: string, name: string, dur: number, transitionId?: string, transitionDur = 0) {
    this.styleId = styleId;
    this.name = name;
    this.dur = dur;
    this.transitionId = transitionId;
    this.transitionDur = transitionDur;
  }

  duration() { return seconds(this.dur + this.transitionDur); }

  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    const style = getStyle(this.styleId);
    if (!style) return svgr`<text x="100" y="100" fill="red">Style not found: ${this.styleId}</text>`;

    const lt = frame.seconds();
    const t = frame.seconds(); // In a real video, this would be global time

    const params: ArtStyleParams = {
      width: W,
      height: H,
      localTime: lt,
      globalTime: t,
    };

    // Check if we're in the transition phase
    if (this.transitionId && lt >= this.dur) {
      const transition = getTransition(this.transitionId);
      if (transition) {
        const p = (lt - this.dur) / this.transitionDur;
        const sceneA = style.renderFrame(frame, ctx, params);
        // For transition, we render scene A fading out
        return transition.renderFrame(
          Math.min(1, p),
          sceneA,
          svgr`<rect width="${W}" height="${H}" fill="#000"/>`,
          W, H
        );
      }
    }

    return style.renderFrame(frame, ctx, params);
  }
}

/** Title card scene */
class TitleCard implements Scene {
  readonly name = 'Title';
  duration() { return seconds(3); }

  renderFrame(frame: Frame): Svgr {
    const t = frame.seconds();
    const opacity = Math.min(1, t / 0.5);
    const scale = 0.8 + 0.2 * Math.min(1, t / 0.8);

    return svgr`<g>
      <rect width="${W}" height="${H}" fill="#0a0a1a"/>
      <text x="${W / 2}" y="${H / 2 - 60}" text-anchor="middle"
        font-family="Helvetica" font-size="72" font-weight="bold"
        fill="#e0e0f0" opacity="${opacity}"
        transform="translate(${W / 2},${H / 2 - 60}) scale(${scale}) translate(${-W / 2},${-(H / 2 - 60)})">艺术风格巡礼</text>
      <text x="${W / 2}" y="${H / 2 + 40}" text-anchor="middle"
        font-family="Helvetica" font-size="28"
        fill="#8080a0" opacity="${opacity}">fframes-node × huashu-art-motion</text>
      <text x="${W / 2}" y="${H / 2 + 90}" text-anchor="middle"
        font-family="Helvetica" font-size="20"
        fill="#606080" opacity="${opacity}">从洞穴岩画到蒸汽波 — 用代码让画动起来</text>
    </g>`;
  }
}

/** Style label overlay */
function styleLabel(name: string, period: string, t: number): Svgr {
  const opacity = Math.min(1, t / 0.3);
  return svgr`<g opacity="${opacity}">
    <rect x="20" y="20" width="300" height="70" rx="8" fill="rgba(0,0,0,0.6)"/>
    <text x="35" y="52" font-family="Helvetica" font-size="24"
      font-weight="bold" fill="#ffffff">${name}</text>
    <text x="35" y="78" font-family="Helvetica" font-size="14"
      fill="#aaaaaa">${period}</text>
  </g>`;
}

/** Wrapped scene with label */
class LabeledArtScene implements Scene {
  readonly name: string;
  private inner: ArtScene;
  private labelName: string;
  private labelPeriod: string;

  constructor(styleId: string, name: string, period: string, dur: number) {
    this.inner = new ArtScene(styleId, name, dur);
    this.name = name;
    this.labelName = name;
    this.labelPeriod = period;
  }

  duration() { return this.inner.duration(); }

  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    const t = frame.seconds();
    return svgr`<g>
      ${this.inner.renderFrame(frame, ctx)}
      ${styleLabel(this.labelName, this.labelPeriod, t)}
    </g>`;
  }
}

class ArtStylesVideo implements Video {
  readonly fps = 30;
  readonly width = W;
  readonly height = H;
  readonly defaultOutput = 'art-styles.mp4';

  duration() { return auto; }
  audio() { return AudioMap.none(); }

  defineScenes() {
    return [
      new TitleCard(),
      new LabeledArtScene('01_cave', '洞穴岩画', '公元前 40000 年', 4),
      new LabeledArtScene('09_postimp', '梵高', '1889', 4),
      new LabeledArtScene('12_bauhaus', '包豪斯', '1920s', 4),
      new LabeledArtScene('13_pop', '波普艺术', '1960s', 4),
      new LabeledArtScene('14_8bit', '8-bit 像素', '1980s', 4),
      new LabeledArtScene('26_vaporwave', '蒸汽波', '2010s', 4),
      new LabeledArtScene('17_ink', '中国水墨', '传统', 4),
    ];
  }

  fonts() {
    return [
      '/System/Library/Fonts/Helvetica.ttc',
      '/System/Library/Fonts/PingFang.ttc',
    ];
  }

  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#000000"/>
      ${ctx.renderScenes(frame)}
    </svg>`;
  }
}

export default new ArtStylesVideo();
