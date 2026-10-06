/**
 * 26_vaporwave — 蒸汽波/赛博霓虹
 * 霓虹双色辉光、透视网格、VHS 通道分离。质量 ★★★。
 * 
 * SVG 实现：用渐变和滤镜模拟霓虹辉光，透视线模拟网格。
 * 母题动作：落日横条上移、网格前滚、招牌闪、跟踪噪声带。
 * 签名转场：VHS 撕裂＋上滚。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ArtStyleScene, ArtStyleParams } from '../types.ts';
import { rng, TAU, clamp, lerp, stepTime } from '../math.ts';

const PINK = '#ff71ce';
const CYAN = '#01cdfe';
const PURPLE = '#b967ff';
const YELLOW = '#fffb96';
const DARK = '#0d0221';
const GRID_COLOR = '#2a0a4a';

/** 落日（蒸汽波标志性元素） */
function sunset(cx: number, cy: number, r: number, t: number): Svgr {
  const parts: Svgr[] = [];
  
  // 落日渐变
  parts.push(svgr`<defs>
    <linearGradient id="sunGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${YELLOW}"/>
      <stop offset="40%" stop-color="${PINK}"/>
      <stop offset="100%" stop-color="${PURPLE}"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`);
  
  // 太阳本体
  parts.push(svgr`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#sunGrad)" filter="url(#glow)"/>`);
  
  // 横条切割（蒸汽波标志性效果）
  const stripeCount = 6;
  for (let i = 0; i < stripeCount; i++) {
    const sy = cy - r + (i / stripeCount) * r * 2 + t * 20 % (r * 2 / stripeCount);
    const stripeH = 3 + i * 2;
    parts.push(svgr`<rect x="${cx - r}" y="${sy}" width="${r * 2}" height="${stripeH}"
      fill="${DARK}" opacity="0.7"/>`);
  }
  
  return svgr`${parts}`;
}

/** 透视网格地面 */
function perspectiveGrid(W: number, H: number, horizonY: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const vpx = W / 2; // 消失点 x
  
  // 地面背景
  parts.push(svgr`<rect x="0" y="${horizonY}" width="${W}" height="${H - horizonY}" fill="${DARK}"/>`);
  
  // 水平线（向前滚动）
  const scrollSpeed = 40;
  const lineSpacing = 40;
  const offset = (t * scrollSpeed) % lineSpacing;
  
  for (let i = 0; i < 20; i++) {
    const y = horizonY + i * lineSpacing + offset;
    if (y > H) break;
    const p = (y - horizonY) / (H - horizonY);
    const opacity = 0.3 + p * 0.5;
    parts.push(svgr`<line x1="0" y1="${y}" x2="${W}" y2="${y}"
      stroke="${GRID_COLOR}" stroke-width="${1 + p * 2}" opacity="${opacity}"/>`);
  }
  
  // 垂直线（透视汇聚）
  const vLineCount = 30;
  for (let i = -vLineCount / 2; i <= vLineCount / 2; i++) {
    const startX = vpx + i * 30;
    const endX = vpx + i * 200;
    parts.push(svgr`<line x1="${startX}" y1="${horizonY}" x2="${endX}" y2="${H}"
      stroke="${GRID_COLOR}" stroke-width="1" opacity="0.4"/>`);
  }
  
  return svgr`${parts}`;
}

/** 霓虹招牌 */
function neonSign(x: number, y: number, text: string, color: string, t: number, seed: number): Svgr {
  const r = rng(seed);
  const st = stepTime(t, 3);
  const flicker = r() > 0.1 ? 1 : 0.3; // 偶尔闪烁
  const glowSize = 6 + Math.sin(t * 2 + seed) * 2;
  
  return svgr`
    <defs>
      <filter id="neon_${seed}">
        <feGaussianBlur stdDeviation="${glowSize}" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <text x="${x}" y="${y}" text-anchor="middle" font-family="Helvetica"
      font-size="42" font-weight="bold" fill="${color}" opacity="${flicker}"
      filter="url(#neon_${seed})">${text}</text>
  `;
}

/** 棕榈树剪影 */
function palmTree(x: number, y: number, s: number): Svgr {
  const parts: Svgr[] = [];
  // 树干
  parts.push(svgr`<path d="M${x},${y} Q${x + 5 * s},${y - 40 * s} ${x + 3 * s},${y - 80 * s}"
    stroke="${DARK}" stroke-width="${4 * s}" fill="none"/>`);
  // 叶子
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * 0.5;
    const lx = x + 3 * s + Math.cos(a) * 35 * s;
    const ly = y - 80 * s + Math.sin(a) * 20 * s;
    parts.push(svgr`<path d="M${x + 3 * s},${y - 80 * s} Q${(x + 3 * s + lx) / 2 + 10 * s},${(y - 80 * s + ly) / 2 - 10 * s} ${lx},${ly}"
      stroke="${DARK}" stroke-width="${3 * s}" fill="none" stroke-linecap="round"/>`);
  }
  return svgr`${parts}`;
}

/** VHS 扫描线 */
function scanLines(W: number, H: number, t: number): Svgr {
  const parts: Svgr[] = [];
  // 水平扫描线
  for (let y = 0; y < H; y += 3) {
    parts.push(svgr`<rect x="0" y="${y}" width="${W}" height="1" fill="rgba(0,0,0,0.15)"/>`);
  }
  // 跟踪噪声带（随机位置的水平干扰线）
  const r = rng(Math.floor(t * 2));
  for (let i = 0; i < 3; i++) {
    const y = r() * H;
    const h = 2 + r() * 8;
    parts.push(svgr`<rect x="0" y="${y}" width="${W}" height="${h}"
      fill="rgba(255,113,206,0.1)"/>`);
  }
  return svgr`${parts}`;
}

/** 几何装饰（三角形、圆形漂浮物） */
function floatingShapes(W: number, H: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const r = rng(99);
  
  for (let i = 0; i < 8; i++) {
    const x = ((r() * W + t * 30) | 0) % (W + 100) - 50;
    const y = r() * H * 0.5;
    const size = 10 + r() * 30;
    const rot = t * (0.5 + r() * 0.5);
    const color = [PINK, CYAN, PURPLE, YELLOW][i % 4];
    
    if (i % 2 === 0) {
      // 三角形
      parts.push(svgr`<polygon
        points="${x},${y - size} ${x - size},${y + size} ${x + size},${y + size}"
        fill="none" stroke="${color}" stroke-width="2" opacity="0.6"
        transform="rotate(${rot * 30} ${x} ${y})"/>`);
    } else {
      // 圆形
      parts.push(svgr`<circle cx="${x}" cy="${y}" r="${size / 2}"
        fill="none" stroke="${color}" stroke-width="2" opacity="0.5"/>`);
    }
  }
  
  return svgr`${parts}`;
}

export const vaporwaveScene: ArtStyleScene = {
  id: '26_vaporwave',
  name: '蒸汽波/赛博霓虹',
  period: '2010s',
  quality: 3,
  shortcomings: '部件交界也发光',
  renderFrame(frame: Frame, _ctx: FFramesContext, params: ArtStyleParams): Svgr {
    const { width: W, height: H, localTime: lt, globalTime: t } = params;
    const horizonY = H * 0.55;
    
    return svgr`<g>
      <!-- 天空背景 -->
      <defs>
        <linearGradient id="skyVapor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0d0221"/>
          <stop offset="50%" stop-color="#2a0a4a"/>
          <stop offset="100%" stop-color="#4a1a6a"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${horizonY}" fill="url(#skyVapor)"/>
      
      <!-- 落日 -->
      ${sunset(W / 2, horizonY - 80, 120, t)}
      
      <!-- 透视网格 -->
      ${perspectiveGrid(W, H, horizonY, t)}
      
      <!-- 棕榈树 -->
      ${palmTree(W * 0.1, horizonY, 1.5)}
      ${palmTree(W * 0.85, horizonY, 1.2)}
      
      <!-- 霓虹招牌 -->
      ${neonSign(W * 0.25, H * 0.15, 'A E S T H E T I C', PINK, t, 1)}
      ${neonSign(W * 0.75, H * 0.12, 'V A P O R', CYAN, t, 2)}
      ${neonSign(W * 0.5, H * 0.08, '1 9 8 9', PURPLE, t, 3)}
      
      <!-- 漂浮几何 -->
      ${floatingShapes(W, H, t)}
      
      <!-- VHS 扫描线 -->
      ${scanLines(W, H, t)}
    </g>`;
  },
};
