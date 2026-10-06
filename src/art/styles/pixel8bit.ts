/**
 * 14_8bit — 8-bit 像素风格
 * 240×135 逐像素、14 色板、部件 1px 黑边。质量 ★★★。
 * 
 * SVG 实现：用矩形元素模拟像素，每个"像素"是一个小矩形。
 * 母题动作：尾巴摆、HUD 心闪、问号块顶金币（15-30fps 步进）。
 * 签名转场：像素块放大缩小。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ArtStyleScene, ArtStyleParams } from '../types.ts';
import { rng, stepTime, clamp } from '../math.ts';

// 8-bit 14色调色板
const PALETTE = [
  '#000000', '#1a1c2c', '#5d275d', '#b13e53',
  '#ef7d57', '#ffcd75', '#a7f070', '#38b764',
  '#257179', '#29366f', '#3b5dc9', '#41a6f6',
  '#73eff7', '#f4f4f4',
] as const;

// 像素尺寸（逻辑分辨率 240×135，物理 1920×1080，每个像素 8×8）
const PX = 8;
const LW = 240; // 逻辑宽
const LH = 135; // 逻辑高

/** 绘制一个像素 */
function px(x: number, y: number, colorIdx: number): Svgr {
  const color = PALETTE[clamp(colorIdx, 0, PALETTE.length - 1)];
  return svgr`<rect x="${x * PX}" y="${y * PX}" width="${PX}" height="${PX}" fill="${color}"/>`;
}

/** 绘制一个像素区域 */
function pxRect(x: number, y: number, w: number, h: number, colorIdx: number): Svgr {
  const color = PALETTE[clamp(colorIdx, 0, PALETTE.length - 1)];
  return svgr`<rect x="${x * PX}" y="${y * PX}" width="${w * PX}" height="${h * PX}" fill="${color}"/>`;
}

/** 绘制带黑边的像素区域 */
function pxRectOutline(x: number, y: number, w: number, h: number, colorIdx: number): Svgr {
  const color = PALETTE[clamp(colorIdx, 0, PALETTE.length - 1)];
  return svgr`<rect x="${x * PX}" y="${y * PX}" width="${w * PX}" height="${h * PX}"
    fill="${color}" stroke="#000000" stroke-width="1"/>`;
}

/** 天空背景 */
function sky(t: number): Svgr {
  const parts: Svgr[] = [];
  // 渐变天空（从深蓝到浅蓝）
  for (let y = 0; y < 60; y++) {
    const p = y / 60;
    const ci = p < 0.3 ? 1 : p < 0.6 ? 9 : p < 0.8 ? 10 : 11;
    parts.push(pxRect(0, y, LW, 1, ci));
  }
  // 云朵
  const r = rng(42);
  for (let i = 0; i < 8; i++) {
    const cx = ((r() * LW + t * 3) | 0) % (LW + 40) - 20;
    const cy = 5 + (r() * 20) | 0;
    const cw = 8 + (r() * 12) | 0;
    const ch = 3 + (r() * 3) | 0;
    parts.push(pxRect(cx, cy, cw, ch, 13));
    parts.push(pxRect(cx + 2, cy - 1, cw - 4, 1, 13));
  }
  return svgr`${parts}`;
}

/** 地面 */
function ground(): Svgr {
  const parts: Svgr[] = [];
  // 草地
  parts.push(pxRect(0, 100, LW, 35, 7));
  // 地面顶部亮线
  parts.push(pxRect(0, 100, LW, 1, 6));
  // 砖块
  for (let x = 0; x < LW; x += 4) {
    parts.push(pxRect(x, 110, 3, 2, 4));
    parts.push(pxRect(x + 2, 112, 3, 2, 4));
  }
  return svgr`${parts}`;
}

/** 问号块（带弹跳动画） */
function questionBlock(x: number, y: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const st = stepTime(t, 15); // 15fps 步进
  const bounce = Math.max(0, Math.sin(st * 4)) * 2;
  const by = y - bounce;
  
  // 块体
  parts.push(pxRectOutline(x, by, 8, 8, 5));
  // 问号
  parts.push(pxRect(x + 2, by + 1, 4, 1, 13));
  parts.push(pxRect(x + 5, by + 2, 1, 2, 13));
  parts.push(pxRect(x + 3, by + 4, 2, 1, 13));
  parts.push(pxRect(x + 3, by + 6, 1, 1, 13));
  
  return svgr`${parts}`;
}

/** 金币（旋转动画） */
function coin(x: number, y: number, t: number): Svgr {
  const parts: Svgr[] = [];
  const st = stepTime(t, 20);
  const phase = (st * 3) % 1;
  // 金币旋转：宽度变化模拟
  const w = phase < 0.25 ? 6 : phase < 0.5 ? 4 : phase < 0.75 ? 2 : 4;
  const cx = x + (6 - w) / 2;
  
  parts.push(pxRectOutline(cx, y, w, 6, 5));
  if (w > 2) {
    parts.push(pxRect(cx + 1, y + 1, Math.max(1, w - 2), 1, 13));
  }
  
  return svgr`${parts}`;
}

/** HUD：心形生命值 */
function hud(t: number): Svgr {
  const parts: Svgr[] = [];
  const st = stepTime(t, 2);
  const flash = st % 2 === 0;
  
  // 生命值背景
  parts.push(pxRect(2, 2, 30, 8, 0));
  parts.push(pxRect(2, 2, 30, 1, 13));
  
  // 心形
  for (let i = 0; i < 3; i++) {
    const hx = 4 + i * 9;
    const ci = flash && i === 2 ? 3 : 3; // 最后一颗心闪烁
    // 心形像素图案
    parts.push(px(hx + 1, 3, ci)); parts.push(px(hx + 2, 3, ci));
    parts.push(px(hx + 4, 3, ci)); parts.push(px(hx + 5, 3, ci));
    parts.push(px(hx, 4, ci)); parts.push(px(hx + 1, 4, ci));
    parts.push(px(hx + 2, 4, ci)); parts.push(px(hx + 3, 4, ci));
    parts.push(px(hx + 4, 4, ci)); parts.push(px(hx + 5, 4, ci));
    parts.push(px(hx + 6, 4, ci));
    parts.push(px(hx + 1, 5, ci)); parts.push(px(hx + 2, 5, ci));
    parts.push(px(hx + 3, 5, ci)); parts.push(px(hx + 4, 5, ci));
    parts.push(px(hx + 5, 5, ci));
    parts.push(px(hx + 2, 6, ci)); parts.push(px(hx + 3, 6, ci));
    parts.push(px(hx + 4, 6, ci));
    parts.push(px(hx + 3, 7, ci));
  }
  
  // 分数
  parts.push(pxRect(180, 2, 50, 8, 0));
  parts.push(pxRect(180, 2, 50, 1, 13));
  
  return svgr`${parts}`;
}

/** 水管 */
function pipe(x: number, y: number): Svgr {
  const parts: Svgr[] = [];
  // 主管
  parts.push(pxRectOutline(x, y, 12, 20, 7));
  // 管口
  parts.push(pxRectOutline(x - 2, y - 4, 16, 4, 7));
  parts.push(pxRect(x - 2, y - 4, 16, 1, 6));
  return svgr`${parts}`;
}

/** 砖块 */
function brick(x: number, y: number): Svgr {
  const parts: Svgr[] = [];
  parts.push(pxRectOutline(x, y, 8, 8, 4));
  // 砖缝
  parts.push(pxRect(x, y + 3, 8, 1, 0));
  parts.push(pxRect(x + 3, y, 1, 3, 0));
  parts.push(pxRect(x + 1, y + 4, 1, 4, 0));
  parts.push(pxRect(x + 5, y + 4, 1, 4, 0));
  return svgr`${parts}`;
}

export const pixel8bitScene: ArtStyleScene = {
  id: '14_8bit',
  name: '8-bit 像素',
  period: '1980s',
  quality: 3,
  shortcomings: '猫头压窗台',
  renderFrame(frame: Frame, _ctx: FFramesContext, params: ArtStyleParams): Svgr {
    const { localTime: lt, globalTime: t } = params;
    
    return svgr`<g>
      <!-- 天空 -->
      ${sky(t)}
      <!-- 地面 -->
      ${ground()}
      <!-- 问号块 -->
      ${questionBlock(60, 80, t)}
      ${questionBlock(100, 80, t)}
      ${questionBlock(140, 80, t)}
      <!-- 金币 -->
      ${coin(62, 60, t)}
      ${coin(102, 55, t)}
      ${coin(142, 62, t)}
      <!-- 砖块 -->
      ${brick(80, 80)}
      ${brick(120, 80)}
      ${brick(160, 80)}
      ${brick(180, 80)}
      <!-- 水管 -->
      ${pipe(200, 80)}
      ${pipe(30, 85)}
      <!-- HUD -->
      ${hud(t)}
    </g>`;
  },
};
