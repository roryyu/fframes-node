/**
 * 17_ink — 中国水墨写意
 * 毛笔笔锋飞白、墨晕洇开、留白、钤印。质量 ★★。
 * 
 * SVG 实现：用路径和渐变模拟毛笔笔触，用模糊滤镜模拟墨晕。
 * 母题动作：开场笔触自己写出、墨晕扩散、虾须动。
 * 签名转场：（速通里开场）。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ArtStyleScene, ArtStyleParams } from '../types.ts';
import { rng, TAU, clamp, lerp, ss, noise } from '../math.ts';
import { pointsToPath, wavyPts, densify, resample } from '../svg-path.ts';

const INK_DARK = '#1a1a1a';
const INK_MID = '#4a4a4a';
const INK_LIGHT = '#8a8a8a';
const PAPER = '#f5f0e0';
const SEAL_RED = '#c03030';

/** 毛笔笔触路径（模拟笔压变化） */
function brushStroke(pts: [number, number][], maxW: number, t: number, reveal: number): Svgr {
  if (reveal <= 0 || pts.length < 2) return svgr``;
  
  const n = Math.max(2, Math.ceil(pts.length * clamp(reveal)));
  const visible = pts.slice(0, n);
  
  // 用多个不同宽度的路径叠加模拟毛笔效果
  const parts: Svgr[] = [];
  
  // 主笔芯
  const corePath = pointsToPath(visible);
  parts.push(svgr`<path d="${corePath}" fill="none" stroke="${INK_DARK}"
    stroke-width="${maxW * 0.6}" stroke-linecap="round" opacity="0.85"/>`);
  
  // 笔毛（几根不同透明度的线）
  const r = rng(42);
  for (let k = 0; k < 4; k++) {
    const offset = (k - 1.5) * maxW * 0.3;
    const offsetPts: [number, number][] = visible.map((p, i) => {
      const next = visible[Math.min(i + 1, visible.length - 1)];
      const prev = visible[Math.max(i - 1, 0)];
      let dx = next[0] - prev[0], dy = next[1] - prev[1];
      const d = Math.hypot(dx, dy) || 1;
      return [p[0] - dy / d * offset, p[1] + dx / d * offset];
    });
    const opacity = 0.3 + r() * 0.3;
    const w = maxW * (0.15 + r() * 0.2);
    parts.push(svgr`<path d="${pointsToPath(offsetPts)}" fill="none"
      stroke="${INK_DARK}" stroke-width="${w}" stroke-linecap="round" opacity="${opacity}"/>`);
  }
  
  return svgr`${parts}`;
}

/** 墨晕（圆形扩散） */
function inkBloom(cx: number, cy: number, maxR: number, grow: number): Svgr {
  if (grow <= 0) return svgr``;
  const r = maxR * ss(0, 0.6, grow);
  const haloR = maxR * 1.3 * grow;
  
  return svgr`
    <defs>
      <radialGradient id="inkBloom_${cx}_${cy}" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0%" stop-color="${INK_DARK}" stop-opacity="0.8"/>
        <stop offset="60%" stop-color="${INK_MID}" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="${INK_LIGHT}" stop-opacity="0"/>
      </radialGradient>
      <filter id="inkBlur_${cx}_${cy}">
        <feGaussianBlur stdDeviation="${4 * grow}"/>
      </filter>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${haloR}" fill="url(#inkBloom_${cx}_${cy})"
      filter="url(#inkBlur_${cx}_${cy})" opacity="${grow * 0.6}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${INK_DARK}" opacity="${grow * 0.7}"/>
  `;
}

/** 虾（水墨写意） */
function shrimp(x: number, y: number, s: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const wobble = Math.sin(t * 3) * 5;
  
  // 身体（弧线）
  const bodyPts: [number, number][] = [];
  for (let i = 0; i <= 20; i++) {
    const q = i / 20;
    bodyPts.push([
      x + q * 120 * s,
      y + Math.sin(q * Math.PI) * 30 * s + Math.sin(t * 2 + q * 3) * 3,
    ]);
  }
  parts.push(svgr`<path d="${pointsToPath(bodyPts)}" fill="none"
    stroke="${INK_DARK}" stroke-width="${3 * s}" stroke-linecap="round" opacity="0.7"/>`);
  
  // 虾须（两条长曲线）
  for (let side = -1; side <= 1; side += 2) {
    const whiskerPts: [number, number][] = [];
    for (let i = 0; i <= 15; i++) {
      const q = i / 15;
      whiskerPts.push([
        x + q * 80 * s + Math.sin(t * 4 + q * 5 + side) * 8 * s,
        y - 10 * s + side * q * 40 * s + wobble * q,
      ]);
    }
    parts.push(svgr`<path d="${pointsToPath(whiskerPts)}" fill="none"
      stroke="${INK_MID}" stroke-width="${1 * s}" stroke-linecap="round" opacity="0.5"/>`);
  }
  
  // 虾尾
  const tailPts: [number, number][] = [
    [x + 120 * s, y],
    [x + 140 * s, y - 15 * s],
    [x + 145 * s, y],
    [x + 140 * s, y + 15 * s],
  ];
  parts.push(svgr`<path d="${pointsToPath(tailPts, true)}" fill="${INK_MID}" opacity="0.4"/>`);
  
  // 眼睛
  parts.push(svgr`<circle cx="${x + 5 * s}" cy="${y - 5 * s}" r="${2.5 * s}" fill="${INK_DARK}"/>`);
  
  return svgr`${parts}`;
}

/** 竹叶 */
function bambooLeaf(x: number, y: number, angle: number, len: number, t: number): Svgr {
  const sway = Math.sin(t * 1.5 + x * 0.01) * 0.05;
  const a = angle + sway;
  
  // 两头尖的叶形
  const pts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const q = i / 10;
    const bend = Math.sin(q * Math.PI) * 0.08 * len;
    pts.push([
      x + Math.cos(a) * len * q - Math.sin(a) * bend,
      y + Math.sin(a) * len * q + Math.cos(a) * bend,
    ]);
  }
  
  // 用可变宽度路径
  const w = (q: number) => 4 * Math.pow(Math.sin(Math.PI * Math.min(1, q * 1.1)), 0.7) + 0.5;
  
  // 简化为填充路径
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const q = i / (pts.length - 1);
    const hw = w(q) / 2;
    const next = pts[Math.min(i + 1, pts.length - 1)];
    const prev = pts[Math.max(i - 1, 0)];
    let dx = next[0] - prev[0], dy = next[1] - prev[1];
    const d = Math.hypot(dx, dy) || 1;
    left.push([pts[i][0] - dy / d * hw, pts[i][1] + dx / d * hw]);
    right.push([pts[i][0] + dy / d * hw, pts[i][1] - dx / d * hw]);
  }
  
  const allPts = [...left, ...right.reverse()];
  return svgr`<path d="${pointsToPath(allPts, true)}" fill="${INK_DARK}" opacity="0.7"/>`;
}

/** 竹干 */
function bambooStalk(x: number, y0: number, y1: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const sway = Math.sin(t * 1.2 + x * 0.005) * 3;
  
  // 主干
  parts.push(svgr`<line x1="${x + sway}" y1="${y0}" x2="${x}" y2="${y1}"
    stroke="${INK_DARK}" stroke-width="5" stroke-linecap="round"/>`);
  
  // 竹节
  const segments = 4;
  for (let i = 1; i < segments; i++) {
    const y = y0 + (y1 - y0) * (i / segments);
    const sx = x + sway * (1 - i / segments);
    parts.push(svgr`<line x1="${sx - 6}" y1="${y}" x2="${sx + 6}" y2="${y}"
      stroke="${INK_DARK}" stroke-width="2" opacity="0.5"/>`);
  }
  
  return svgr`${parts}`;
}

/** 钤印（印章） */
function seal(x: number, y: number, size: number): Svgr {
  return svgr`
    <rect x="${x}" y="${y}" width="${size}" height="${size}"
      fill="${SEAL_RED}" rx="2" opacity="0.85"/>
    <text x="${x + size / 2}" y="${y + size * 0.7}" text-anchor="middle"
      font-family="PingFang SC" font-size="${size * 0.5}" fill="${PAPER}" font-weight="bold">印</text>
  `;
}

/** 远山（淡墨） */
function distantMountains(W: number, H: number, t: number): Svgr {
  const parts: Svgr[] = [];
  
  // 三层远山，越来越淡
  for (let layer = 0; layer < 3; layer++) {
    const opacity = 0.15 - layer * 0.04;
    const baseY = H * 0.3 + layer * 40;
    const pts: [number, number][] = [];
    
    for (let x = 0; x <= W; x += 20) {
      const y = baseY + noise(x * 0.003 + layer * 10, layer * 5) * 60;
      pts.push([x, y]);
    }
    pts.push([W, H * 0.5]);
    pts.push([0, H * 0.5]);
    
    parts.push(svgr`<path d="${pointsToPath(pts, true)}" fill="${INK_MID}" opacity="${opacity}"/>`);
  }
  
  return svgr`${parts}`;
}

export const inkScene: ArtStyleScene = {
  id: '17_ink',
  name: '中国水墨写意',
  period: '传统',
  quality: 2,
  shortcomings: '人物不够写意',
  renderFrame(frame: Frame, _ctx: FFramesContext, params: ArtStyleParams): Svgr {
    const { width: W, height: H, localTime: lt, globalTime: t } = params;
    
    // 开场笔触写出动画
    const writeReveal = clamp(lt / 2);
    
    return svgr`<g>
      <!-- 宣纸底色 -->
      <rect width="${W}" height="${H}" fill="${PAPER}"/>
      
      <!-- 远山 -->
      ${distantMountains(W, H, t)}
      
      <!-- 墨晕 -->
      ${inkBloom(W * 0.3, H * 0.4, 80, clamp(lt / 3))}
      ${inkBloom(W * 0.7, H * 0.5, 60, clamp((lt - 0.5) / 3))}
      
      <!-- 竹子 -->
      ${bambooStalk(W * 0.15, H * 0.2, H * 0.8, t)}
      ${bambooStalk(W * 0.22, H * 0.25, H * 0.75, t)}
      ${bambooLeaf(W * 0.15, H * 0.3, -0.5, 60, t)}
      ${bambooLeaf(W * 0.15, H * 0.35, 0.3, 50, t)}
      ${bambooLeaf(W * 0.22, H * 0.3, -0.8, 55, t)}
      ${bambooLeaf(W * 0.22, H * 0.4, 0.5, 45, t)}
      
      <!-- 虾 -->
      ${shrimp(W * 0.4, H * 0.6, 1.2, t)}
      ${shrimp(W * 0.6, H * 0.7, 0.9, t + 1)}
      
      <!-- 毛笔笔触（开场写出） -->
      ${brushStroke([
        [W * 0.1, H * 0.15],
        [W * 0.3, H * 0.12],
        [W * 0.5, H * 0.18],
        [W * 0.7, H * 0.1],
        [W * 0.9, H * 0.15],
      ], 8, t, writeReveal)}
      
      <!-- 钤印 -->
      ${seal(W * 0.85, H * 0.8, 40)}
    </g>`;
  },
};
