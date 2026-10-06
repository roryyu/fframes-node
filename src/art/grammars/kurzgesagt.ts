/**
 * Y1 · Kurzgesagt 扁平科普语法
 * 把一个抽象概念放进一个能无限缩放的发光世界里，相机在尺度之间穿行。
 * 
 * 核心特征：深色系底、不描边、圆角无处不在、发光体必带径向辉光、持续微动。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ExplainerGrammar, GrammarSpec, GrammarCue } from '../types.ts';
import { rng, TAU, clamp, lerp, smooth, sineInOut, backOut, spring } from '../math.ts';
import { hex, rgb, mix, hsl, toHex } from '../color.ts';
import { pointsToPath, blobPath, starPath } from '../svg-path.ts';

// 2025 深色系色板
const BG_DARK = '#05020F';
const BG_MID = '#0E0631';
const BG_LIGHT = '#25155E';
const ACCENT_CYAN = '#32BAEE';
const ACCENT_CYAN_LIGHT = '#7DD3DC';
const ACCENT_ORANGE = '#F48301';
const ACCENT_YELLOW = '#FACC12';
const ACCENT_GLOW = '#F9EF93';
const ACCENT_MAGENTA = '#BE3A95';
const HIGHLIGHT = '#E7DFE1';
const WHITE = '#F9FCFB';

/** 发光球体（带径向辉光） */
function glowOrb(cx: number, cy: number, r: number, color: string, t: number, seed: number): Svgr {
  const breathe = 1 + Math.sin(t * 2 + seed) * 0.05;
  const glowR = r * 2.5 * breathe;
  const id = `glow_${seed}`;
  
  return svgr`
    <defs>
      <radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0%" stop-color="${ACCENT_GLOW}" stop-opacity="0.9"/>
        <stop offset="30%" stop-color="${color}" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${glowR}" fill="url(#${id})"/>
    <circle cx="${cx}" cy="${cy}" r="${r * breathe}" fill="${color}"/>
    <!-- 高光 -->
    <ellipse cx="${cx - r * 0.25}" cy="${cy - r * 0.3}" rx="${r * 0.3}" ry="${r * 0.15}"
      fill="${WHITE}" opacity="0.6" transform="rotate(-30 ${cx} ${cy})"/>
  `;
}

/** 星星（闪烁） */
function stars(W: number, H: number, count: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const r = rng(42);
  
  for (let i = 0; i < count; i++) {
    const x = r() * W;
    const y = r() * H * 0.6;
    const size = 1 + r() * 3;
    const phase = r() * TAU;
    const speed = 1 + r() * 2.5;
    const twinkle = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * speed + phase));
    
    parts.push(svgr`<circle cx="${x}" cy="${y}" r="${size}"
      fill="${WHITE}" opacity="${twinkle}"/>`);
  }
  
  return svgr`${parts}`;
}

/** 双色分面形状（Kurzgesagt 标志性画法） */
function flatShape(path: string, baseColor: string, shadowColor: string, t: number): Svgr {
  return svgr`
    <path d="${path}" fill="${baseColor}"/>
    <path d="${path}" fill="${shadowColor}" opacity="0.3"
      transform="translate(10,12) scale(0.98)"/>
    <path d="${path}" fill="${WHITE}" opacity="0.15"
      transform="translate(-4,-5) scale(0.97)"/>
  `;
}

/** 有机形状（团状生物） */
function organicBlob(cx: number, cy: number, r: number, color: string, t: number, seed: number): Svgr {
  const wobble = Math.sin(t * 1.5 + seed) * 0.05;
  const path = blobPath(cx, cy, r * (1 + wobble), seed, 0.12, 8);
  const shadowCol = toHex(mix(hex(color), [0, 0, 0], 0.3));
  return flatShape(path, color, shadowCol, t);
}

/** 神经网络节点 */
function neuralNode(x: number, y: number, r: number, active: number, t: number, seed: number): Svgr {
  const pulse = active > 0 ? spring(active, { duration: 0.35, bounce: 0.2 }) : 0;
  const glowSize = r * (1 + pulse * 0.5);
  
  return svgr`
    <circle cx="${x}" cy="${y}" r="${glowSize}" fill="${ACCENT_CYAN}" opacity="${0.2 * pulse}"/>
    <circle cx="${x}" cy="${y}" r="${r}" fill="${active > 0.5 ? ACCENT_YELLOW : BG_LIGHT}"
      opacity="${0.5 + pulse * 0.5}"/>
    <circle cx="${x}" cy="${y}" r="${r * 0.5}" fill="${active > 0.5 ? ACCENT_GLOW : BG_MID}"/>
  `;
}

/** 连接线（信号脉冲） */
function connection(x1: number, y1: number, x2: number, y2: number, t: number, seed: number): Svgr {
  const progress = ((t * 0.5 + seed * 0.3) % 1);
  const px = lerp(x1, x2, progress);
  const py = lerp(y1, y2, progress);
  
  return svgr`
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
      stroke="${ACCENT_CYAN}" stroke-width="1.5" opacity="0.3"/>
    <circle cx="${px}" cy="${py}" r="3" fill="${ACCENT_CYAN}" opacity="0.8"/>
  `;
}

/** 浮动粒子 */
function floatingParticles(W: number, H: number, t: number, count = 20): Svgr {
  const parts: Svgr[] = [];
  const r = rng(99);
  
  for (let i = 0; i < count; i++) {
    const baseX = r() * W;
    const baseY = r() * H;
    const drift = 30 + r() * 50;
    const speed = 0.3 + r() * 0.5;
    const phase = r() * TAU;
    const size = 1 + r() * 2;
    
    const x = baseX + Math.sin(t * speed + phase) * drift;
    const y = baseY + Math.cos(t * speed * 0.7 + phase) * drift * 0.5;
    const opacity = 0.2 + 0.3 * Math.sin(t * 0.5 + phase);
    
    parts.push(svgr`<circle cx="${x}" cy="${y}" r="${size}"
      fill="${ACCENT_CYAN}" opacity="${opacity}"/>`);
  }
  
  return svgr`${parts}`;
}

/** 标题文字（逐字弹入） */
function titleText(x: number, y: number, text: string, t: number, startTime: number): Svgr {
  const parts: Svgr[] = [];
  const chars = [...text];
  
  chars.forEach((ch, i) => {
    const delay = i * 0.045;
    const localT = t - startTime - delay;
    if (localT < 0) return;
    
    const p = clamp(localT / 0.5);
    const scale = backOut(p, 1.1);
    const opacity = clamp(localT / 0.3);
    
    parts.push(svgr`<text x="${x + i * 50}" y="${y}" font-family="Helvetica"
      font-size="48" font-weight="bold" fill="${WHITE}"
      opacity="${opacity}" transform="translate(${x + i * 50},${y}) scale(${scale}) translate(${-(x + i * 50)},${-y})">${ch}</text>`);
  });
  
  return svgr`${parts}`;
}

/** 视差层远山 */
function parallaxMountains(W: number, H: number, t: number, cameraZoom: number): Svgr {
  const parts: Svgr[] = [];
  
  // 三层山，不同视差速度
  const layers = [
    { d: 0.3, color: BG_LIGHT, baseY: 0.55 },
    { d: 0.65, color: BG_MID, baseY: 0.65 },
    { d: 1.0, color: BG_DARK, baseY: 0.8 },
  ];
  
  layers.forEach(({ d, color, baseY }, li) => {
    const pts: [number, number][] = [];
    const offset = t * 5 * d;
    
    for (let x = 0; x <= W + 100; x += 30) {
      const y = H * baseY + Math.sin((x + offset) * 0.005 + li * 2) * 40 * d;
      pts.push([x, y]);
    }
    pts.push([W + 100, H]);
    pts.push([0, H]);
    
    parts.push(svgr`<path d="${pointsToPath(pts, true)}" fill="${color}" opacity="0.8"/>`);
  });
  
  return svgr`${parts}`;
}

export const kurzgesagtGrammar: ExplainerGrammar = {
  id: 'kurzgesagt',
  name: 'Kurzgesagt 扁平科普',
  description: '把一个抽象概念放进一个能无限缩放的发光世界里，相机在尺度之间穿行，画面里的东西永远不停地轻轻动。',
  renderFrame(frame: Frame, _ctx: FFramesContext, spec: GrammarSpec): Svgr {
    const { width: W, height: H, cues, data } = spec;
    const t = frame.seconds();
    
    // 相机慢推
    const cameraZoom = 1 + (t / spec.duration) * 0.1;
    
    // 从 data 获取配置
    const title = (data?.title as string) || '探索微观世界';
    const showNetwork = (data?.showNetwork as boolean) ?? true;
    const showBlobs = (data?.showBlobs as boolean) ?? true;
    
    return svgr`<g>
      <!-- 深色系背景 -->
      <defs>
        <linearGradient id="kzBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${BG_DARK}"/>
          <stop offset="50%" stop-color="${BG_MID}"/>
          <stop offset="100%" stop-color="${BG_LIGHT}"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#kzBg)"/>
      
      <!-- 星星 -->
      ${stars(W, H, 80, t)}
      
      <!-- 视差远山 -->
      ${parallaxMountains(W, H, t, cameraZoom)}
      
      <!-- 发光球体群 -->
      ${glowOrb(W * 0.3, H * 0.35, 40, ACCENT_ORANGE, t, 1)}
      ${glowOrb(W * 0.7, H * 0.3, 30, ACCENT_CYAN, t, 2)}
      ${glowOrb(W * 0.5, H * 0.45, 25, ACCENT_MAGENTA, t, 3)}
      
      <!-- 有机生物 -->
      ${showBlobs ? svgr`
        ${organicBlob(W * 0.2, H * 0.7, 50, ACCENT_CYAN, t, 10)}
        ${organicBlob(W * 0.8, H * 0.65, 40, ACCENT_MAGENTA, t, 20)}
        ${organicBlob(W * 0.6, H * 0.75, 35, ACCENT_ORANGE, t, 30)}
      ` : svgr``}
      
      <!-- 神经网络 -->
      ${showNetwork ? svgr`
        ${connection(W * 0.3, H * 0.5, W * 0.5, H * 0.4, t, 1)}
        ${connection(W * 0.5, H * 0.4, W * 0.7, H * 0.5, t, 2)}
        ${connection(W * 0.3, H * 0.5, W * 0.5, H * 0.6, t, 3)}
        ${connection(W * 0.5, H * 0.6, W * 0.7, H * 0.5, t, 4)}
        ${neuralNode(W * 0.3, H * 0.5, 12, Math.sin(t * 2) * 0.5 + 0.5, t, 1)}
        ${neuralNode(W * 0.5, H * 0.4, 15, Math.sin(t * 2 + 1) * 0.5 + 0.5, t, 2)}
        ${neuralNode(W * 0.5, H * 0.6, 10, Math.sin(t * 2 + 2) * 0.5 + 0.5, t, 3)}
        ${neuralNode(W * 0.7, H * 0.5, 14, Math.sin(t * 2 + 3) * 0.5 + 0.5, t, 4)}
      ` : svgr``}
      
      <!-- 浮动粒子 -->
      ${floatingParticles(W, H, t)}
      
      <!-- 标题 -->
      ${titleText(W * 0.5 - title.length * 25, H * 0.15, title, t, 0.5)}
      
      <!-- 处理 cues -->
      ${cues.map(cue => {
        const localT = t - cue.at;
        if (localT < 0) return svgr``;
        
        if (cue.kind === 'text') {
          const p = clamp(localT / 0.5);
          const scale = backOut(p, 1.1);
          return svgr`<text x="${W * 0.5}" y="${H * 0.85}" text-anchor="middle"
            font-family="Helvetica" font-size="36" fill="${HIGHLIGHT}"
            opacity="${clamp(localT / 0.3)}"
            transform="translate(${W * 0.5},${H * 0.85}) scale(${scale}) translate(${-W * 0.5},${-H * 0.85})">${cue.text || ''}</text>`;
        }
        
        if (cue.kind === 'number') {
          const p = clamp(localT / 0.9);
          const value = Math.floor(p * (parseFloat(cue.text || '100')));
          return svgr`<text x="${W * 0.5}" y="${H * 0.5}" text-anchor="middle"
            font-family="Helvetica" font-size="72" font-weight="bold" fill="${ACCENT_YELLOW}"
            opacity="${clamp(localT / 0.3)}">${value}</text>`;
        }
        
        return svgr``;
      })}
    </g>`;
  },
};
