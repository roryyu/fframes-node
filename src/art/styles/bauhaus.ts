/**
 * 12_bauhaus — 包豪斯
 * 纯几何构成、施莱默人偶关节盘。质量 ★★★。
 * 
 * SVG 实现：几何形状（圆、三角、矩形）的构成，红黄蓝三原色。
 * 母题动作：指针杆转陡、蒙德里安格换色、猫拨球。
 * 签名转场：红黄蓝几何旋转放大。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ArtStyleScene, ArtStyleParams } from '../types.ts';
import { rng, TAU, clamp, lerp } from '../math.ts';

const RED = '#e0301e';
const YELLOW = '#f5c518';
const BLUE = '#2e5fa3';
const BLACK = '#1a1a1a';
const WHITE = '#f5f0e8';
const GRAY = '#8a8a8a';

/** 蒙德里安格背景 */
function mondrianGrid(W: number, H: number, t: number): Svgr {
  const r = rng(7);
  const parts: Svgr[] = [];
  
  // 背景
  parts.push(svgr`<rect width="${W}" height="${H}" fill="${WHITE}"/>`);
  
  // 水平线
  const hLines = [0.15, 0.35, 0.55, 0.75, 0.92];
  hLines.forEach((p, i) => {
    const y = p * H;
    const w = 2 + r() * 4;
    parts.push(svgr`<rect x="0" y="${y}" width="${W}" height="${w}" fill="${BLACK}"/>`);
  });
  
  // 垂直线
  const vLines = [0.1, 0.25, 0.45, 0.6, 0.8, 0.93];
  vLines.forEach((p, i) => {
    const x = p * W;
    const w = 2 + r() * 4;
    parts.push(svgr`<rect x="${x}" y="0" width="${w}" height="${H}" fill="${BLACK}"/>`);
  });
  
  // 色块（随时间换色）
  const colors = [RED, YELLOW, BLUE, WHITE, WHITE, WHITE];
  const blocks: [number, number, number, number][] = [
    [0.1, 0.15, 0.15, 0.2],
    [0.45, 0.35, 0.15, 0.2],
    [0.6, 0.55, 0.2, 0.2],
    [0.25, 0.75, 0.2, 0.17],
    [0.8, 0.15, 0.13, 0.2],
    [0.45, 0.75, 0.15, 0.17],
  ];
  
  blocks.forEach(([x, y, w, h], i) => {
    const ci = Math.floor(t * 0.5 + i) % colors.length;
    parts.push(svgr`<rect x="${x * W}" y="${y * H}" width="${w * W}" height="${h * H}"
      fill="${colors[ci]}"/>`);
  });
  
  return svgr`${parts}`;
}

/** 大圆（包豪斯标志性元素） */
function bigCircle(cx: number, cy: number, r: number, t: number): Svgr {
  const parts: Svgr[] = [];
  // 外圆
  parts.push(svgr`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${RED}"/>`);
  // 内切三角
  const triPts: [number, number][] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU - Math.PI / 2 + t * 0.3;
    triPts.push([cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6]);
  }
  parts.push(svgr`<polygon points="${triPts.map(p => p.join(',')).join(' ')}" fill="${YELLOW}"/>`);
  // 中心小圆
  parts.push(svgr`<circle cx="${cx}" cy="${cy}" r="${r * 0.15}" fill="${BLUE}"/>`);
  return svgr`${parts}`;
}

/** 指针杆（施莱默式） */
function needleRod(cx: number, cy: number, len: number, t: number): Svgr {
  const angle = t * 1.2;
  const x2 = cx + Math.cos(angle) * len;
  const y2 = cy + Math.sin(angle) * len;
  return svgr`
    <line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}"
      stroke="${BLACK}" stroke-width="6" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="10" fill="${BLACK}"/>
    <circle cx="${x2}" cy="${y2}" r="14" fill="${RED}"/>
  `;
}

/** 几何猫（包豪斯风格简化） */
function geometricCat(x: number, y: number, s: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const tailWag = Math.sin(t * 5.2) * 15;
  
  // 身体（大圆）
  parts.push(svgr`<circle cx="${x}" cy="${y}" r="${s}" fill="${BLACK}"/>`);
  // 头（中圆）
  parts.push(svgr`<circle cx="${x + s * 0.8}" cy="${y - s * 0.6}" r="${s * 0.55}" fill="${BLACK}"/>`);
  // 耳朵（三角形）
  parts.push(svgr`<polygon points="${x + s * 0.6},${y - s * 1.05} ${x + s * 0.75},${y - s * 1.3} ${x + s * 0.9},${y - s * 1.05}" fill="${BLACK}"/>`);
  parts.push(svgr`<polygon points="${x + s * 0.95},${y - s * 1.0} ${x + s * 1.1},${y - s * 1.25} ${x + s * 1.2},${y - s * 0.95}" fill="${BLACK}"/>`);
  // 眼睛（小圆）
  parts.push(svgr`<circle cx="${x + s * 0.7}" cy="${y - s * 0.65}" r="${s * 0.08}" fill="${YELLOW}"/>`);
  parts.push(svgr`<circle cx="${x + s * 0.95}" cy="${y - s * 0.6}" r="${s * 0.08}" fill="${YELLOW}"/>`);
  // 尾巴（弧线）
  const tailX = x - s * 0.9;
  const tailY = y - s * 0.3;
  parts.push(svgr`<path d="M${tailX},${tailY} Q${tailX - s * 0.5},${tailY - s * 0.5 + tailWag} ${tailX - s * 0.3},${tailY - s * 0.8 + tailWag}"
    stroke="${BLACK}" stroke-width="${s * 0.12}" fill="none" stroke-linecap="round"/>`);
  
  return svgr`${parts}`;
}

/** 球（猫拨的球） */
function ball(x: number, y: number, r: number, t: number): Svgr {
  const bounce = Math.abs(Math.sin(t * 3)) * 20;
  return svgr`<circle cx="${x}" cy="${y - bounce}" r="${r}" fill="${BLUE}"/>`;
}

/** 半圆弧线装饰 */
function arcs(W: number, H: number): Svgr {
  const parts: Svgr[] = [];
  // 左下角大半圆
  parts.push(svgr`<path d="M0,${H} A${W * 0.3},${W * 0.3} 0 0,1 ${W * 0.3},${H - W * 0.3}"
    fill="${YELLOW}" opacity="0.6"/>`);
  // 右上角半圆
  parts.push(svgr`<path d="M${W},0 A${W * 0.25},${W * 0.25} 0 0,0 ${W - W * 0.25},${W * 0.25}"
    fill="${BLUE}" opacity="0.5"/>`);
  return svgr`${parts}`;
}

export const bauhausScene: ArtStyleScene = {
  id: '12_bauhaus',
  name: '包豪斯',
  period: '1920s',
  quality: 3,
  shortcomings: '猫头偏离骨架位',
  renderFrame(frame: Frame, _ctx: FFramesContext, params: ArtStyleParams): Svgr {
    const { width: W, height: H, localTime: lt, globalTime: t } = params;
    
    return svgr`<g>
      ${mondrianGrid(W, H, t)}
      ${arcs(W, H)}
      ${bigCircle(W * 0.7, H * 0.35, 120, t)}
      ${needleRod(W * 0.3, H * 0.5, 150, t)}
      ${geometricCat(W * 0.5, H * 0.65, 60, t)}
      ${ball(W * 0.62, H * 0.7, 20, t)}
    </g>`;
  },
};
