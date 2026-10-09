/**
 * Xiaohei Motion Demo — showcases the 小黑漫画风 (Ian Xiaohei SVG Motion) style.
 *
 * Ported from chengfeng-videocut-skills / ian-xiaohei-svg-motion.
 *
 * Scene: "sorting task" metaphor — Xiaohei sorts cards on a conveyor belt;
 * one card falls into a pit; Xiaohei reaches down and rescues it.
 *
 * 7-beat narrative progression (1s per beat, 7s total):
 *   0: show context (belt + Xiaohei)
 *   1: move input (cards start travelling)
 *   2: first breakpoint (card falls into pit)
 *   3: next segment (Xiaohei leans toward pit)
 *   4: move output (Xiaohei pulls card out)
 *   5: second breakpoint (card resumes, output bin appears)
 *   6: summary annotation draws in
 *
 * Usage:
 *   node src/cli/main.ts examples/xiaohei-motion/video.ts timeline
 *   node src/cli/main.ts examples/xiaohei-motion/video.ts frame --at 2.5s -o /tmp/xiaohei
 *   node src/cli/main.ts examples/xiaohei-motion/video.ts render --draft -o xiaohei.mp4
 */

import { svgr, seconds, AudioMap, auto } from '../../src/index.ts';
import type { Scene, Svgr, Video, FFramesContext, Frame } from '../../src/index.ts';
import { getStyle, type ArtStyleParams } from '../../src/art/index.ts';
import '../../src/art/styles/index.ts';

const W = 1920;
const H = 1080;
const SCENE_DUR = 7.5;   // 7 beats + 0.5s tail

// ---------------------------------------------------------------------------
// Title card
// ---------------------------------------------------------------------------
class TitleCard implements Scene {
  readonly name = 'Title';
  duration() { return seconds(2.5); }

  renderFrame(frame: Frame): Svgr {
    const t = frame.seconds();
    const fadeIn = Math.min(1, t / 0.4);
    const slideY = 20 * (1 - Math.min(1, t / 0.6));

    return svgr`<g>
      <rect width="${W}" height="${H}" fill="#ffffff"/>
      <g opacity="${fadeIn.toFixed(3)}" transform="translate(0,${slideY.toFixed(1)})">
        <text x="${W / 2}" y="${H / 2 - 50}" text-anchor="middle"
          font-family="PingFang SC" font-size="64" font-weight="bold" fill="#1a1a1a">小黑漫画风</text>
        <text x="${W / 2}" y="${H / 2 + 20}" text-anchor="middle"
          font-family="PingFang SC" font-size="28" fill="#4a4a4a">Ian Xiaohei SVG Motion · fframes-node</text>
        <text x="${W / 2}" y="${H / 2 + 70}" text-anchor="middle"
          font-family="PingFang SC" font-size="20" fill="#888888">白底黑线 · 橙红蓝标注 · 七拍叙事</text>
        <line x1="${W / 2 - 120}" y1="${H / 2 + 95}" x2="${W / 2 + 120}" y2="${H / 2 + 95}"
          stroke="#e8722a" stroke-width="3" stroke-linecap="round"/>
      </g>
    </g>`;
  }
}

// ---------------------------------------------------------------------------
// Main xiaohei scene (with beat indicator overlay)
// ---------------------------------------------------------------------------
const BEAT_NAMES = ['上下文', '输入移动', '断点', '下一段', '输出移动', '结果', '总结'];

class XiaoheiScene implements Scene {
  readonly name = 'Xiaohei';
  duration() { return seconds(SCENE_DUR); }

  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    const style = getStyle('37_xiaohei');
    if (!style) {
      return svgr`<text x="100" y="100" fill="red" font-family="Helvetica" font-size="32">Style 37_xiaohei not found</text>`;
    }

    const lt = frame.seconds();
    const params: ArtStyleParams = {
      width: W,
      height: H,
      localTime: lt,
      globalTime: lt,
    };

    // Beat indicator (bottom-left HUD)
    const beat = Math.min(6, Math.floor(lt / 1.0));
    const hud = svgr`<g opacity="0.55">
      <rect x="20" y="${H - 60}" width="240" height="40" rx="6" fill="rgba(0,0,0,0.55)"/>
      <text x="32" y="${H - 33}" font-family="PingFang SC" font-size="18" fill="#ffffff">Beat ${beat} · ${BEAT_NAMES[beat]}</text>
    </g>`;

    return svgr`<g>
      ${style.renderFrame(frame, ctx, params)}
      ${hud}
    </g>`;
  }
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------
class XiaoheiMotionVideo implements Video {
  readonly fps = 30;
  readonly width = W;
  readonly height = H;
  readonly defaultOutput = 'xiaohei-motion.mp4';

  duration() { return auto; }
  audio() { return AudioMap.none(); }

  defineScenes() {
    return [
      new TitleCard(),
      new XiaoheiScene(),
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
      <rect width="${W}" height="${H}" fill="#ffffff"/>
      ${ctx.renderScenes(frame)}
    </svg>`;
  }
}

export default new XiaoheiMotionVideo();
