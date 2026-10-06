/**
 * 13_pop — 利希滕斯坦波普
 * 本戴点、粗黑描边、沃霍尔四格换色。质量 ★★★。
 * 
 * SVG 实现：用 pattern 模拟本戴点，粗描边形状。
 * 母题动作：沃霍尔四格换色、思考点闪、猫扭臀、拟声框抖。
 * 签名转场：闪电＋网点化。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ArtStyleScene, ArtStyleParams } from '../types.ts';
import { rng, TAU, clamp, stepTime } from '../math.ts';

const RED = '#e02020';
const YELLOW = '#f5d020';
const BLUE = '#2040c0';
const BLACK = '#0a0a0a';
const WHITE = '#ffffff';
const SKIN = '#f0c8a0';

/** 本戴点 pattern 定义 */
function benDayDots(id: string, color: string, size = 6, spacing = 12): Svgr {
  return svgr`<pattern id="${id}" width="${spacing}" height="${spacing}" patternUnits="userSpaceOnUse">
    <circle cx="${spacing / 2}" cy="${spacing / 2}" r="${size / 2}" fill="${color}"/>
  </pattern>`;
}

/** 沃霍尔四格 */
function warholGrid(x: number, y: number, size: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const half = size / 2;
  const gap = 8;
  
  // 四格颜色随时间变化
  const colorSets = [
    [RED, YELLOW, BLUE, '#40c040'],
    [YELLOW, BLUE, '#40c040', RED],
    [BLUE, '#40c040', RED, YELLOW],
    ['#40c040', RED, YELLOW, BLUE],
  ];
  const ci = Math.floor(t * 0.8) % colorSets.length;
  const colors = colorSets[ci];
  
  const positions: [number, number][] = [
    [x, y], [x + half + gap, y],
    [x, y + half + gap], [x + half + gap, y + half + gap],
  ];
  
  positions.forEach(([px, py], i) => {
    // 背景色
    parts.push(svgr`<rect x="${px}" y="${py}" width="${half}" height="${half}"
      fill="${colors[i]}" stroke="${BLACK}" stroke-width="4"/>`);
    // 内部图案（简化脸）
    const cx = px + half / 2;
    const cy = py + half / 2;
    const s = half * 0.3;
    // 头
    parts.push(svgr`<ellipse cx="${cx}" cy="${cy}" rx="${s}" ry="${s * 1.1}"
      fill="${SKIN}" stroke="${BLACK}" stroke-width="3"/>`);
    // 眼睛
    parts.push(svgr`<ellipse cx="${cx - s * 0.35}" cy="${cy - s * 0.2}" rx="${s * 0.15}" ry="${s * 0.12}"
      fill="${WHITE}" stroke="${BLACK}" stroke-width="2"/>`);
    parts.push(svgr`<ellipse cx="${cx + s * 0.35}" cy="${cy - s * 0.2}" rx="${s * 0.15}" ry="${s * 0.12}"
      fill="${WHITE}" stroke="${BLACK}" stroke-width="2"/>`);
    parts.push(svgr`<circle cx="${cx - s * 0.35}" cy="${cy - s * 0.2}" r="${s * 0.06}" fill="${BLACK}"/>`);
    parts.push(svgr`<circle cx="${cx + s * 0.35}" cy="${cy - s * 0.2}" r="${s * 0.06}" fill="${BLACK}"/>`);
    // 嘴
    parts.push(svgr`<path d="M${cx - s * 0.3},${cy + s * 0.3} Q${cx},${cy + s * 0.5} ${cx + s * 0.3},${cy + s * 0.3}"
      fill="none" stroke="${BLACK}" stroke-width="2.5"/>`);
  });
  
  return svgr`${parts}`;
}

/** 拟声框（POW! BANG! 等） */
function soundBox(x: number, y: number, text: string, t: number, seed: number): Svgr {
  const r = rng(seed);
  const st = stepTime(t, 8);
  const shake = Math.sin(st * 10 + seed) * 3;
  const sx = x + shake;
  const sy = y + Math.cos(st * 8 + seed) * 2;
  
  // 爆炸形背景
  const spikes = 12;
  const R = 80;
  const pts: string[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * TAU;
    const rad = i % 2 ? R * 0.6 : R;
    pts.push(`${sx + Math.cos(a) * rad},${sy + Math.sin(a) * rad}`);
  }
  
  return svgr`
    <polygon points="${pts.join(' ')}" fill="${YELLOW}" stroke="${BLACK}" stroke-width="4"/>
    <text x="${sx}" y="${sy + 8}" text-anchor="middle" font-family="Helvetica"
      font-size="36" font-weight="900" fill="${RED}" stroke="${BLACK}" stroke-width="1">${text}</text>
  `;
}

/** 思考泡泡 */
function thoughtBubble(x: number, y: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const st = stepTime(t, 4);
  const pulse = 1 + Math.sin(st * 3) * 0.1;
  
  // 主泡泡
  parts.push(svgr`<ellipse cx="${x}" cy="${y}" rx="${60 * pulse}" ry="${45 * pulse}"
    fill="${WHITE}" stroke="${BLACK}" stroke-width="3"/>`);
  // 小泡泡链
  parts.push(svgr`<circle cx="${x - 50}" cy="${y + 40}" r="${12 * pulse}"
    fill="${WHITE}" stroke="${BLACK}" stroke-width="2.5"/>`);
  parts.push(svgr`<circle cx="${x - 70}" cy="${y + 60}" r="${8 * pulse}"
    fill="${WHITE}" stroke="${BLACK}" stroke-width="2"/>`);
  parts.push(svgr`<circle cx="${x - 85}" cy="${y + 75}" r="${5 * pulse}"
    fill="${WHITE}" stroke="${BLACK}" stroke-width="1.5"/>`);
  
  // 省略号
  parts.push(svgr`<circle cx="${x - 15}" cy="${y}" r="4" fill="${BLACK}"/>`);
  parts.push(svgr`<circle cx="${x}" cy="${y}" r="4" fill="${BLACK}"/>`);
  parts.push(svgr`<circle cx="${x + 15}" cy="${y}" r="4" fill="${BLACK}"/>`);
  
  return svgr`${parts}`;
}

/** 闪电 */
function lightning(x: number, y: number, t: number): Svgr {
  const st = stepTime(t, 6);
  const flash = st % 3 < 0.3;
  if (!flash) return svgr``;
  
  const pts: [number, number][] = [
    [x, y], [x - 15, y + 40], [x + 5, y + 40],
    [x - 10, y + 80], [x + 20, y + 35], [x + 2, y + 35],
    [x + 15, y],
  ];
  return svgr`<polygon points="${pts.map(p => p.join(',')).join(' ')}"
    fill="${YELLOW}" stroke="${BLACK}" stroke-width="3" opacity="${flash ? 1 : 0}"/>`;
}

/** 波普猫 */
function popCat(x: number, y: number, s: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const st = stepTime(t, 12);
  const wiggle = Math.sin(st * 6) * 5;
  
  // 身体
  parts.push(svgr`<ellipse cx="${x + wiggle}" cy="${y}" rx="${s}" ry="${s * 0.8}"
    fill="url(#benday_orange)" stroke="${BLACK}" stroke-width="4"/>`);
  // 头
  parts.push(svgr`<circle cx="${x + s * 0.7 + wiggle}" cy="${y - s * 0.5}" r="${s * 0.5}"
    fill="url(#benday_orange)" stroke="${BLACK}" stroke-width="4"/>`);
  // 耳朵
  parts.push(svgr`<polygon points="${x + s * 0.45 + wiggle},${y - s * 0.85} ${x + s * 0.55},${y - s * 1.15} ${x + s * 0.7},${y - s * 0.9}"
    fill="${RED}" stroke="${BLACK}" stroke-width="3"/>`);
  parts.push(svgr`<polygon points="${x + s * 0.8 + wiggle},${y - s * 0.9} ${x + s * 0.95},${y - s * 1.15} ${x + s * 1.05},${y - s * 0.85}"
    fill="${RED}" stroke="${BLACK}" stroke-width="3"/>`);
  // 眼睛
  parts.push(svgr`<ellipse cx="${x + s * 0.55 + wiggle}" cy="${y - s * 0.55}" rx="${s * 0.12}" ry="${s * 0.1}"
    fill="${WHITE}" stroke="${BLACK}" stroke-width="2"/>`);
  parts.push(svgr`<ellipse cx="${x + s * 0.85 + wiggle}" cy="${y - s * 0.5}" rx="${s * 0.12}" ry="${s * 0.1}"
    fill="${WHITE}" stroke="${BLACK}" stroke-width="2"/>`);
  parts.push(svgr`<circle cx="${x + s * 0.55 + wiggle}" cy="${y - s * 0.55}" r="${s * 0.05}" fill="${BLACK}"/>`);
  parts.push(svgr`<circle cx="${x + s * 0.85 + wiggle}" cy="${y - s * 0.5}" r="${s * 0.05}" fill="${BLACK}"/>`);
  // 尾巴
  const tailX = x - s * 0.9 + wiggle;
  parts.push(svgr`<path d="M${tailX},${y - s * 0.2} Q${tailX - s * 0.4},${y - s * 0.6 + wiggle * 2} ${tailX - s * 0.2},${y - s * 0.9 + wiggle * 2}"
    stroke="${BLACK}" stroke-width="${s * 0.1}" fill="none" stroke-linecap="round"/>`);
  
  return svgr`${parts}`;
}

export const popScene: ArtStyleScene = {
  id: '13_pop',
  name: '利希滕斯坦波普',
  period: '1960s',
  quality: 3,
  shortcomings: '',
  renderFrame(frame: Frame, _ctx: FFramesContext, params: ArtStyleParams): Svgr {
    const { width: W, height: H, localTime: lt, globalTime: t } = params;
    
    return svgr`<g>
      <defs>
        ${benDayDots('benday_red', RED, 5, 10)}
        ${benDayDots('benday_blue', BLUE, 5, 10)}
        ${benDayDots('benday_yellow', YELLOW, 5, 10)}
        ${benDayDots('benday_orange', '#e08030', 5, 10)}
      </defs>
      <!-- 背景：本戴点 -->
      <rect width="${W}" height="${H}" fill="url(#benday_yellow)"/>
      <!-- 沃霍尔四格 -->
      ${warholGrid(W * 0.05, H * 0.1, 350, t)}
      <!-- 拟声框 -->
      ${soundBox(W * 0.75, H * 0.25, 'POW!', t, 1)}
      ${soundBox(W * 0.85, H * 0.55, 'BANG!', t, 2)}
      <!-- 思考泡泡 -->
      ${thoughtBubble(W * 0.6, H * 0.15, t)}
      <!-- 闪电 -->
      ${lightning(W * 0.3, H * 0.05, t)}
      <!-- 波普猫 -->
      ${popCat(W * 0.5, H * 0.7, 80, t)}
    </g>`;
  },
};
