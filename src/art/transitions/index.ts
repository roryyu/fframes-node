/**
 * Transition effects between art-style scenes.
 * Ported from huashu-art-motion's signature transitions.
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { ArtTransition } from '../types.ts';
import { clamp, ss, smooth } from '../math.ts';
import { registerTransition } from '../registry.ts';

/** 淡入淡出 */
export const fadeTransition: ArtTransition = {
  id: 'fade',
  name: '淡入淡出',
  duration: 0.8,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, W: number, H: number): Svgr {
    const opacityA = 1 - smooth(p);
    const opacityB = smooth(p);
    return svgr`<g>
      <g opacity="${opacityA}">${sceneA}</g>
      <g opacity="${opacityB}">${sceneB}</g>
    </g>`;
  },
};

/** 硬切 */
export const cutTransition: ArtTransition = {
  id: 'cut',
  name: '硬切',
  duration: 0.05,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr): Svgr {
    return p < 0.5 ? sceneA : sceneB;
  },
};

/** 星空漩涡卷入（梵高签名转场） */
export const swirlTransition: ArtTransition = {
  id: 'swirl',
  name: '星空漩涡卷入',
  duration: 1.2,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, W: number, H: number): Svgr {
    const q = smooth(p);
    const scale = 1 + q * 3;
    const rot = q * 720;
    const opacity = 1 - ss(0.5, 1, p);
    
    return svgr`<g>
      <g transform="translate(${W / 2},${H / 2}) scale(${scale}) rotate(${rot}) translate(${-W / 2},${-H / 2})"
        opacity="${opacity}">${sceneA}</g>
      <g opacity="${ss(0.3, 0.8, p)}">${sceneB}</g>
    </g>`;
  },
};

/** 像素块放大缩小（8-bit 签名转场） */
export const pixelTransition: ArtTransition = {
  id: 'pixel',
  name: '像素块放大缩小',
  duration: 0.6,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, W: number, H: number): Svgr {
    const q = smooth(p);
    const pixelSize = Math.max(1, Math.floor(20 * (1 - Math.abs(q - 0.5) * 2)));
    
    // 中间帧用像素化效果
    if (q < 0.5) {
      const s = 1 - q * 2;
      return svgr`<g>
        <g transform="translate(${W / 2},${H / 2}) scale(${s}) translate(${-W / 2},${-H / 2})">${sceneA}</g>
        <rect width="${W}" height="${H}" fill="#000" opacity="${1 - s}"/>
      </g>`;
    } else {
      const s = (q - 0.5) * 2;
      return svgr`<g>
        <rect width="${W}" height="${H}" fill="#000" opacity="${1 - s}"/>
        <g transform="translate(${W / 2},${H / 2}) scale(${s}) translate(${-W / 2},${-H / 2})">${sceneB}</g>
      </g>`;
    }
  },
};

/** 纸面转场（翻页效果） */
export const pageTurnTransition: ArtTransition = {
  id: 'page_turn',
  name: '纸面翻页',
  duration: 1.0,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, W: number, H: number): Svgr {
    const q = smooth(p);
    const skewX = q * 30;
    const scaleX = 1 - q * 0.5;
    const opacityA = 1 - ss(0.3, 0.9, p);
    const opacityB = ss(0.1, 0.7, p);
    
    return svgr`<g>
      <g transform="translate(${W / 2},0) skewX(${-skewX}) scale(${scaleX},1) translate(${-W / 2},0)"
        opacity="${opacityA}">${sceneA}</g>
      <g opacity="${opacityB}">${sceneB}</g>
      <!-- 翻页阴影 -->
      <rect x="${W * (1 - q)}" y="0" width="${W * q}" height="${H}"
        fill="rgba(0,0,0,${0.3 * Math.sin(q * Math.PI)})"/>
    </g>`;
  },
};

/** 红黄蓝几何旋转放大（包豪斯签名转场） */
export const bauhausTransition: ArtTransition = {
  id: 'bauhaus',
  name: '包豪斯几何旋转',
  duration: 0.9,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, W: number, H: number): Svgr {
    const q = smooth(p);
    const colors = ['#e0301e', '#f5c518', '#2e5fa3'];
    const shapes: Svgr[] = [];
    
    // 三个几何形状旋转放大
    for (let i = 0; i < 3; i++) {
      const delay = i * 0.15;
      const localP = clamp((p - delay) / (1 - delay));
      const s = localP * 3;
      const rot = localP * 360;
      const cx = W / 2, cy = H / 2;
      
      if (i === 0) {
        shapes.push(svgr`<circle cx="${cx}" cy="${cy}" r="${100 * s}"
          fill="${colors[i]}" opacity="${0.7 * (1 - localP)}"
          transform="rotate(${rot} ${cx} ${cy})"/>`);
      } else if (i === 1) {
        const size = 150 * s;
        shapes.push(svgr`<rect x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}"
          fill="${colors[i]}" opacity="${0.6 * (1 - localP)}"
          transform="rotate(${rot} ${cx} ${cy})"/>`);
      } else {
        const r = 120 * s;
        const pts: string[] = [];
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 - Math.PI / 2;
          pts.push(`${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`);
        }
        shapes.push(svgr`<polygon points="${pts.join(' ')}"
          fill="${colors[i]}" opacity="${0.5 * (1 - localP)}"
          transform="rotate(${rot} ${cx} ${cy})"/>`);
      }
    }
    
    return svgr`<g>
      <g opacity="${1 - ss(0, 0.5, p)}">${sceneA}</g>
      ${shapes}
      <g opacity="${ss(0.4, 0.9, p)}">${sceneB}</g>
    </g>`;
  },
};

/** VHS 撕裂＋上滚（蒸汽波签名转场） */
export const vhsTransition: ArtTransition = {
  id: 'vhs',
  name: 'VHS 撕裂上滚',
  duration: 0.8,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, W: number, H: number): Svgr {
    const q = smooth(p);
    const tearY = H * q;
    const glitchOffset = Math.sin(q * 50) * 10 * (1 - q);
    
    return svgr`<g>
      <!-- 场景A：上滚出屏 -->
      <g transform="translate(${glitchOffset},${-tearY})">
        ${sceneA}
      </g>
      <!-- 场景B：从下方进入 -->
      <g transform="translate(0,${H - tearY})">
        ${sceneB}
      </g>
      <!-- VHS 噪声线 -->
      <rect x="0" y="${tearY - 5}" width="${W}" height="10"
        fill="rgba(255,113,206,${0.5 * (1 - q)})"/>
      <rect x="0" y="${tearY - 2}" width="${W}" height="4"
        fill="rgba(1,205,254,${0.4 * (1 - q)})"/>
    </g>`;
  },
};

/** 墨晕扩散（水墨签名转场） */
export const inkBloomTransition: ArtTransition = {
  id: 'ink_bloom',
  name: '墨晕扩散',
  duration: 1.5,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, W: number, H: number): Svgr {
    const q = smooth(p);
    const maxR = Math.hypot(W, H) * 0.6;
    const r = q * maxR;
    
    return svgr`<g>
      ${sceneA}
      <!-- 墨晕遮罩 -->
      <defs>
        <radialGradient id="inkTransition" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stop-color="white" stop-opacity="1"/>
          <stop offset="${clamp(q * 1.2)}" stop-color="white" stop-opacity="1"/>
          <stop offset="${clamp(q * 1.2 + 0.1)}" stop-color="white" stop-opacity="0"/>
        </radialGradient>
        <mask id="inkMask">
          <rect width="${W}" height="${H}" fill="black"/>
          <circle cx="${W / 2}" cy="${H / 2}" r="${r}" fill="url(#inkTransition)"/>
        </mask>
      </defs>
      <g mask="url(#inkMask)">
        ${sceneB}
      </g>
    </g>`;
  },
};

/** 闪电＋网点化（波普签名转场） */
export const popTransition: ArtTransition = {
  id: 'pop_flash',
  name: '闪电网点化',
  duration: 0.5,
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, W: number, H: number): Svgr {
    const flashOn = p < 0.3;
    
    return svgr`<g>
      ${flashOn ? sceneA : sceneB}
      ${flashOn ? svgr`<rect width="${W}" height="${H}" fill="white" opacity="${0.8 * (1 - p / 0.3)}"/>` : svgr``}
    </g>`;
  },
};

// Register all transitions
registerTransition(fadeTransition);
registerTransition(cutTransition);
registerTransition(swirlTransition);
registerTransition(pixelTransition);
registerTransition(pageTurnTransition);
registerTransition(bauhausTransition);
registerTransition(vhsTransition);
registerTransition(inkBloomTransition);
registerTransition(popTransition);
