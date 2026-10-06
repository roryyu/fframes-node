/**
 * 01_cave — 洞穴岩画
 * 噪声浮雕岩壁＋炭点毛边＋赭石吃进岩面。质量 ★★★。
 * 
 * SVG 实现：用噪声纹理模拟岩壁，用粗糙路径模拟炭笔绘制。
 * 母题动作：动物两姿态交替奔跑、火光摇曳、余烬。
 * 签名转场：（开场）。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ArtStyleScene, ArtStyleParams } from '../types.ts';
import { rng, TAU, clamp, lerp, noise, fbm, stepTime } from '../math.ts';
import { pointsToPath, roughPathData } from '../svg-path.ts';

const ROCK_DARK = '#3a2a1a';
const ROCK_MID = '#5a4a3a';
const ROCK_LIGHT = '#7a6a55';
const OCHRE = '#c06030';
const CHARCOAL = '#2a1a10';
const FIRE_ORANGE = '#e08020';
const FIRE_YELLOW = '#f0c040';

/** 岩壁纹理（用 filter 模拟） */
function rockTexture(W: number, H: number): Svgr {
  return svgr`
    <defs>
      <filter id="rockNoise">
        <feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="5" seed="42"/>
        <feColorMatrix type="matrix" values="0 0 0 0 0.23  0 0 0 0 0.16  0 0 0 0 0.10  0 0 0 1 0"/>
        <feComposite in2="SourceGraphic" operator="in"/>
      </filter>
      <filter id="rockBump">
        <feTurbulence type="fractalNoise" baseFrequency="0.004" numOctaves="4" seed="7" result="noise"/>
        <feDiffuseLighting in="noise" lighting-color="#8a7a6a" surfaceScale="2" result="light">
          <feDistantLight azimuth="45" elevation="60"/>
        </feDiffuseLighting>
        <feComposite in="light" in2="SourceGraphic" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>
      </filter>
    </defs>
    <rect width="${W}" height="${H}" fill="${ROCK_MID}" filter="url(#rockBump)"/>
  `;
}

/** 炭笔动物（野牛）— 两姿态交替 */
function caveAnimal(x: number, y: number, s: number, t: number, seed: number): Svgr {
  const st = stepTime(t, 4); // 4fps 交替
  const pose = Math.floor(st + seed) % 2; // 0 或 1
  
  // 野牛轮廓（两姿态）
  const bodyPts: [number, number][] = pose === 0
    ? [
        [x, y], [x + 20 * s, y - 15 * s], [x + 50 * s, y - 20 * s],
        [x + 80 * s, y - 15 * s], [x + 100 * s, y], [x + 95 * s, y + 10 * s],
        [x + 70 * s, y + 15 * s], [x + 40 * s, y + 12 * s], [x + 10 * s, y + 10 * s],
      ]
    : [
        [x, y], [x + 20 * s, y - 18 * s], [x + 50 * s, y - 22 * s],
        [x + 80 * s, y - 12 * s], [x + 100 * s, y + 2 * s], [x + 95 * s, y + 12 * s],
        [x + 70 * s, y + 16 * s], [x + 40 * s, y + 14 * s], [x + 10 * s, y + 10 * s],
      ];
  
  // 腿（两姿态不同位置）
  const legs: [number, number, number, number][] = pose === 0
    ? [
        [x + 15 * s, y + 10 * s, x + 12 * s, y + 35 * s],
        [x + 30 * s, y + 12 * s, x + 28 * s, y + 38 * s],
        [x + 70 * s, y + 14 * s, x + 72 * s, y + 38 * s],
        [x + 85 * s, y + 10 * s, x + 88 * s, y + 35 * s],
      ]
    : [
        [x + 15 * s, y + 10 * s, x + 10 * s, y + 30 * s],
        [x + 30 * s, y + 14 * s, x + 35 * s, y + 40 * s],
        [x + 70 * s, y + 16 * s, x + 65 * s, y + 32 * s],
        [x + 85 * s, y + 12 * s, x + 90 * s, y + 40 * s],
      ];
  
  const r = rng(seed);
  const bodyPath = roughPathData(bodyPts, { amp: 3, seed, closed: true, step: 8 });
  
  return svgr`
    <path d="${bodyPath}" fill="${OCHRE}" opacity="0.7"/>
    <path d="${bodyPath}" fill="none" stroke="${CHARCOAL}" stroke-width="2" opacity="0.8"/>
    ${legs.map(([x1, y1, x2, y2]) => svgr`
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
        stroke="${CHARCOAL}" stroke-width="2.5" stroke-linecap="round"/>
    `)}
    <!-- 角 -->
    <path d="M${x + 5 * s},${y - 12 * s} Q${x - 5 * s},${y - 25 * s} ${x - 2 * s},${y - 30 * s}"
      fill="none" stroke="${CHARCOAL}" stroke-width="2" stroke-linecap="round"/>
    <path d="M${x + 12 * s},${y - 15 * s} Q${x + 5 * s},${y - 28 * s} ${x + 8 * s},${y - 33 * s}"
      fill="none" stroke="${CHARCOAL}" stroke-width="2" stroke-linecap="round"/>
  `;
}

/** 人形（猎人） */
function caveHuman(x: number, y: number, s: number, t: number): Svgr {
  const runPhase = Math.sin(t * 6) * 0.3;
  
  return svgr`
    <!-- 头 -->
    <circle cx="${x}" cy="${y - 20 * s}" r="${5 * s}" fill="${OCHRE}" opacity="0.8"/>
    <!-- 身体 -->
    <line x1="${x}" y1="${y - 15 * s}" x2="${x}" y2="${y + 10 * s}"
      stroke="${OCHRE}" stroke-width="3" stroke-linecap="round"/>
    <!-- 手臂（持矛） -->
    <line x1="${x}" y1="${y - 5 * s}" x2="${x + 15 * s + runPhase * 10 * s}" y2="${y - 15 * s}"
      stroke="${OCHRE}" stroke-width="2.5" stroke-linecap="round"/>
    <!-- 矛 -->
    <line x1="${x + 15 * s + runPhase * 10 * s}" y1="${y - 15 * s}"
      x2="${x + 35 * s + runPhase * 10 * s}" y2="${y - 25 * s}"
      stroke="${CHARCOAL}" stroke-width="1.5" stroke-linecap="round"/>
    <!-- 腿（奔跑姿态） -->
    <line x1="${x}" y1="${y + 10 * s}" x2="${x - 8 * s + runPhase * 15 * s}" y2="${y + 30 * s}"
      stroke="${OCHRE}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="${x}" y1="${y + 10 * s}" x2="${x + 8 * s - runPhase * 15 * s}" y2="${y + 30 * s}"
      stroke="${OCHRE}" stroke-width="2.5" stroke-linecap="round"/>
  `;
}

/** 手印（洞穴画标志性元素） */
function handPrint(x: number, y: number, s: number, seed: number): Svgr {
  const r = rng(seed);
  const parts: Svgr[] = [];
  
  // 手掌
  parts.push(svgr`<ellipse cx="${x}" cy="${y}" rx="${8 * s}" ry="${10 * s}"
    fill="${OCHRE}" opacity="0.5"/>`);
  
  // 手指
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * 0.35;
    const len = (i === 2 ? 12 : i === 0 || i === 4 ? 7 : 10) * s;
    const fx = x + Math.cos(a) * 10 * s;
    const fy = y + Math.sin(a) * 10 * s;
    const tx = x + Math.cos(a) * (10 + len) * s;
    const ty = y + Math.sin(a) * (10 + len) * s;
    parts.push(svgr`<line x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}"
      stroke="${OCHRE}" stroke-width="${3 * s}" stroke-linecap="round" opacity="0.5"/>`);
  }
  
  return svgr`${parts}`;
}

/** 火光 */
function fireGlow(x: number, y: number, t: number): Svgr {
  const flicker = 0.7 + 0.3 * Math.sin(t * 8) * Math.sin(t * 13);
  const r = 60 * flicker;
  
  return svgr`
    <defs>
      <radialGradient id="fireGlow" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0%" stop-color="${FIRE_YELLOW}" stop-opacity="${0.4 * flicker}"/>
        <stop offset="50%" stop-color="${FIRE_ORANGE}" stop-opacity="${0.2 * flicker}"/>
        <stop offset="100%" stop-color="${FIRE_ORANGE}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="${x}" cy="${y}" r="${r}" fill="url(#fireGlow)"/>
    <!-- 火焰形状 -->
    <path d="M${x},${y} Q${x - 8},${y - 20 * flicker} ${x},${y - 35 * flicker}
      Q${x + 8},${y - 20 * flicker} ${x},${y}" fill="${FIRE_ORANGE}" opacity="${0.6 * flicker}"/>
    <path d="M${x},${y} Q${x - 5},${y - 15 * flicker} ${x},${y - 25 * flicker}
      Q${x + 5},${y - 15 * flicker} ${x},${y}" fill="${FIRE_YELLOW}" opacity="${0.5 * flicker}"/>
  `;
}

/** 余烬粒子 */
function embers(x: number, y: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const r = rng(77);
  
  for (let i = 0; i < 12; i++) {
    const ph = r() * 6;
    const life = 3 + r() * 3;
    const q = ((t + ph) % life) / life;
    const ex = x + (r() - 0.5) * 40 + Math.sin(t * 2 + i) * 10;
    const ey = y - q * 80;
    const size = (1 - q) * 3;
    const opacity = (1 - q) * 0.6;
    
    parts.push(svgr`<circle cx="${ex}" cy="${ey}" r="${size}"
      fill="${FIRE_ORANGE}" opacity="${opacity}"/>`);
  }
  
  return svgr`${parts}`;
}

/** 点状装饰（岩画点列） */
function dotPattern(x0: number, y0: number, x1: number, y1: number, count: number, seed: number): Svgr {
  const r = rng(seed);
  const parts: Svgr[] = [];
  
  for (let i = 0; i < count; i++) {
    const q = i / count;
    const x = lerp(x0, x1, q) + (r() - 0.5) * 10;
    const y = lerp(y0, y1, q) + (r() - 0.5) * 10;
    const size = 2 + r() * 3;
    parts.push(svgr`<circle cx="${x}" cy="${y}" r="${size}"
      fill="${OCHRE}" opacity="${0.3 + r() * 0.3}"/>`);
  }
  
  return svgr`${parts}`;
}

export const caveScene: ArtStyleScene = {
  id: '01_cave',
  name: '洞穴岩画',
  period: '公元前 40000 年',
  quality: 3,
  shortcomings: '人形太卡通，不够原始',
  renderFrame(frame: Frame, _ctx: FFramesContext, params: ArtStyleParams): Svgr {
    const { width: W, height: H, localTime: lt, globalTime: t } = params;
    
    return svgr`<g>
      <!-- 岩壁 -->
      ${rockTexture(W, H)}
      
      <!-- 点状装饰带 -->
      ${dotPattern(W * 0.1, H * 0.15, W * 0.9, H * 0.12, 30, 1)}
      ${dotPattern(W * 0.15, H * 0.85, W * 0.85, H * 0.88, 25, 2)}
      
      <!-- 野牛群 -->
      ${caveAnimal(W * 0.15, H * 0.4, 1.5, t, 10)}
      ${caveAnimal(W * 0.45, H * 0.35, 1.2, t, 20)}
      ${caveAnimal(W * 0.7, H * 0.42, 1.0, t, 30)}
      
      <!-- 猎人 -->
      ${caveHuman(W * 0.3, H * 0.65, 1.2, t)}
      ${caveHuman(W * 0.55, H * 0.62, 1.0, t + 0.5)}
      
      <!-- 手印 -->
      ${handPrint(W * 0.85, H * 0.3, 1.5, 5)}
      ${handPrint(W * 0.1, H * 0.6, 1.2, 6)}
      ${handPrint(W * 0.9, H * 0.7, 1.0, 7)}
      
      <!-- 火光 -->
      ${fireGlow(W * 0.5, H * 0.85, t)}
      ${embers(W * 0.5, H * 0.85, t)}
    </g>`;
  },
};
