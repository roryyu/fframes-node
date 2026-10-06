/**
 * 09_postimp — 梵高（后印象派）
 * 《阿尔的卧室》＋《星月夜》元素。质量标杆（★★★）。
 * 
 * SVG 实现：用 SVG 元素模拟梵高风格——
 * 流场笔触用短线段路径、区域色板、星空漩涡用螺旋路径、灯晕用径向渐变。
 * 
 * 母题动作：星空漩涡旋转、灯晕环外扩、方向场火苗般摇曳、星星闪烁。
 * 签名转场：星空漩涡卷入。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ArtStyleScene, ArtStyleParams } from '../types.ts';
import { rng, noise, TAU, clamp, lerp } from '../math.ts';
import { hex, rgb, mix, swatch } from '../color.ts';
import { spiralPts, pointsToPath, wavyPts } from '../svg-path.ts';

const C = {
  wall: '#5b7bd3', wall2: '#4462bd',
  sky: '#1d2c7c', sky2: '#3a5bc0',
  swirl: '#8fb3ec', star: '#f6d84a', halo: '#fbeea0',
  frame: '#2f8f58', frameHi: '#6fd08a',
  floor: '#b5553b', floor2: '#8a3a2c',
  wood: '#e3ad38', wood2: '#b57d1c',
  bed: '#d9472f', line: '#1c2458',
  cypress: '#1f4a2c', village: '#1a2160',
};

// 漩涡中心
const swirls: [number, number, number][] = [[520, 300, 90], [660, 240, 60], [450, 420, 55], [700, 400, 45]];
// 星星位置
const stars: [number, number, number][] = [[410, 180, 16], [520, 170, 12], [610, 190, 14], [745, 200, 24], [560, 260, 10], [700, 300, 11], [470, 300, 9]];
// 消失点
const VP: [number, number] = [960, 330];

/** 生成墙面笔触路径（模拟梵高竖向笔触） */
function wallStrokes(W: number, H: number, t: number, seed: number): Svgr {
  const r = rng(seed);
  const parts: Svgr[] = [];
  const cell = 14;
  const sw = swatch(['#7f9be6', '#5f7fd8', '#a7bbf2', '#6c6fd2', '#8ad0e6', '#c3cbf6', '#4f6cc8', '#9a8fe0'], 0.3);
  
  for (let y = 0; y < 700; y += cell) {
    for (let x = 0; x < W; x += cell) {
      const px = x + (r() - 0.5) * cell;
      const py = y + (r() - 0.5) * cell;
      // 跳过窗户区域
      if (px > 340 && px < 830 && py > 110 && py < 590) continue;
      // 跳过床区域
      if (px > 1595 && py > 505) continue;
      
      const baseCol = hex(C.wall);
      const col = sw(baseCol, r);
      // 竖向笔触，带噪声摇曳
      const angle = -Math.PI / 2 + 0.26 * noise(px * 0.008 + t * 0.5, py * 0.008 + 3 - t * 0.8);
      const len = 64 * (0.7 + r() * 0.6);
      const dx = Math.cos(angle) * len / 2;
      const dy = Math.sin(angle) * len / 2;
      
      parts.push(svgr`<line x1="${px - dx}" y1="${py - dy}" x2="${px + dx}" y2="${py + dy}"
        stroke="${rgb(col, 0.7)}" stroke-width="${8}" stroke-linecap="round"/>`);
    }
  }
  return svgr`${parts}`;
}

/** 生成星空漩涡 */
function starrySky(t: number): Svgr {
  const parts: Svgr[] = [];
  
  // 天空渐变背景
  parts.push(svgr`<defs>
    <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.sky}"/>
      <stop offset="100%" stop-color="${C.sky2}"/>
    </linearGradient>
  </defs>`);
  parts.push(svgr`<rect x="370" y="140" width="420" height="400" fill="url(#skyGrad)"/>`);
  
  // 漩涡：螺旋色带，随时间旋转
  swirls.forEach(([cx, cy, r], k) => {
    for (let ring = 0; ring < 3; ring++) {
      const col = ring % 2 ? C.swirl : '#5a82d6';
      const w = 14 - ring * 3;
      const pts: [number, number][] = [];
      for (let a = 0; a < Math.PI * 3; a += 0.15) {
        const rr = r * (0.25 + a / (Math.PI * 3)) * (1 - ring * 0.12);
        const aa = a + t * (0.9 + k * 0.2) * (k % 2 ? -1 : 1);
        pts.push([cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr * 0.8]);
      }
      parts.push(svgr`<path d="${pointsToPath(pts)}" fill="none" stroke="${col}"
        stroke-width="${w}" stroke-linecap="round" opacity="0.8"/>`);
    }
  });
  
  // 月亮（新月）
  parts.push(svgr`<circle cx="745" cy="200" r="30" fill="${C.star}"/>`);
  parts.push(svgr`<circle cx="732" cy="192" r="24" fill="${C.sky}"/>`);
  
  // 柏树（火焰形）
  parts.push(svgr`<path d="M400,545 C372,430 420,330 425,200 C445,320 470,430 452,545 Z"
    fill="${C.cypress}"/>`);
  
  // 村庄轮廓
  const villagePts: [number, number][] = [
    [370, 545], [420, 500], [470, 505], [500, 480], [540, 500],
    [590, 470], [610, 440], [625, 470], [680, 495], [730, 485], [790, 500], [790, 545],
  ];
  parts.push(svgr`<path d="${pointsToPath(villagePts, true)}" fill="${C.village}"/>`);
  
  // 村庄灯光
  const lights: [number, number][] = [[480, 512], [520, 520], [560, 508], [650, 512], [700, 520], [740, 510]];
  lights.forEach(([x, y]) => {
    parts.push(svgr`<rect x="${x}" y="${y}" width="8" height="8" fill="#f2c94c"/>`);
  });
  
  // 星星闪烁
  stars.forEach(([x, y, r], k) => {
    const tw = 0.75 + 0.35 * Math.sin(t * 5 + k * 1.7);
    parts.push(svgr`<circle cx="${x}" cy="${y}" r="${r * 1.9 * tw}" fill="rgba(251,238,160,0.55)"/>`);
    parts.push(svgr`<circle cx="${x}" cy="${y}" r="${r * 0.75 * tw}" fill="${C.star}"/>`);
  });
  
  return svgr`<g clip-path="url(#windowClip)">
    <clipPath id="windowClip"><rect x="370" y="140" width="420" height="400"/></clipPath>
    ${parts}
  </g>`;
}

/** 灯晕：一圈圈向外脉动 */
function lampHalo(t: number): Svgr {
  const parts: Svgr[] = [];
  // 底色径向渐变
  parts.push(svgr`<defs>
    <radialGradient id="haloGrad" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#fff7c8"/>
      <stop offset="55%" stop-color="#f4d65a"/>
      <stop offset="100%" stop-color="rgba(120,150,220,0)"/>
    </radialGradient>
  </defs>`);
  parts.push(svgr`<circle cx="1000" cy="180" r="105" fill="url(#haloGrad)"/>`);
  
  // 脉动环
  for (let k = 0; k < 3; k++) {
    const ph = ((t * 0.9 + k / 3) % 1);
    const r = 40 + ph * 110;
    const opacity = 0.28 * (1 - ph);
    parts.push(svgr`<circle cx="1000" cy="180" r="${r}" fill="none"
      stroke="rgba(255,236,140,${opacity})" stroke-width="18"
      stroke-dasharray="22,14" stroke-dashoffset="${-t * 60}"/>`);
  }
  return svgr`${parts}`;
}

/** 地板透视线 */
function floorLines(W: number, H: number): Svgr {
  const parts: Svgr[] = [];
  parts.push(svgr`<rect x="0" y="700" width="${W}" height="${H - 700}" fill="${C.floor}"/>`);
  parts.push(svgr`<rect x="0" y="696" width="${W}" height="10" fill="#3a2a6a"/>`);
  
  // 木板缝（汇向消失点）
  for (let i = -14; i <= 14; i++) {
    parts.push(svgr`<line x1="${VP[0] + i * 60}" y1="700" x2="${VP[0] + i * 230}" y2="${H}"
      stroke="${C.floor2}" stroke-width="6"/>`);
  }
  return svgr`${parts}`;
}

/** 家具：床、桌、椅 */
function furniture(t: number): Svgr {
  const parts: Svgr[] = [];
  
  // 床（右侧）
  parts.push(svgr`<rect x="1610" y="560" width="330" height="420" fill="${C.wood}"/>`);
  parts.push(svgr`<rect x="1640" y="640" width="290" height="300" fill="${C.wood2}"/>`);
  parts.push(svgr`<path d="M1620,600 Q1760,500 1940,520 L1940,640 Q1780,620 1620,660 Z" fill="${C.bed}"/>`);
  parts.push(svgr`<rect x="1598" y="520" width="26" height="470" fill="${C.wood}"/>`);
  parts.push(svgr`<circle cx="1611" cy="515" r="18" fill="${C.wood}"/>`);
  
  // 桌子
  parts.push(svgr`<rect x="810" y="618" width="400" height="32" fill="${C.wood}"/>`);
  parts.push(svgr`<rect x="830" y="650" width="360" height="52" fill="${C.wood2}"/>`);
  parts.push(svgr`<rect x="960" y="664" width="90" height="22" fill="#e9c46a"/>`);
  parts.push(svgr`<circle cx="1005" cy="675" r="5" fill="#6b4a1a"/>`);
  parts.push(svgr`<rect x="842" y="700" width="22" height="205" fill="${C.wood}"/>`);
  parts.push(svgr`<rect x="1160" y="700" width="22" height="205" fill="${C.wood}"/>`);
  parts.push(svgr`<rect x="842" y="860" width="340" height="12" fill="${C.wood}"/>`);
  
  // 椅子（梯背）
  parts.push(svgr`<rect x="1432" y="470" width="16" height="440" fill="${C.wood}"/>`);
  parts.push(svgr`<rect x="1478" y="480" width="16" height="430" fill="${C.wood}"/>`);
  for (let k = 0; k < 4; k++) {
    parts.push(svgr`<rect x="1436" y="${510 + k * 55}" width="56" height="10" fill="${C.wood}"/>`);
  }
  parts.push(svgr`<rect x="1250" y="742" width="250" height="16" fill="${C.wood}"/>`);
  parts.push(svgr`<rect x="1262" y="750" width="14" height="160" fill="${C.wood}"/>`);
  
  // 花瓶＋向日葵
  parts.push(svgr`<path d="M852,618 Q838,575 862,548 L898,548 Q920,575 905,618 Z" fill="#e8c255"/>`);
  // 花茎
  const stems: [number, number, number, number][] = [[870, 548, 842, 490], [880, 548, 890, 462], [890, 548, 930, 502], [875, 548, 868, 528]];
  stems.forEach(([x1, y1, x2, y2]) => {
    parts.push(svgr`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#4d8a3a" stroke-width="6"/>`);
  });
  // 向日葵花头
  const flowers: [number, number, number][] = [[842, 490, 26], [890, 462, 28], [930, 502, 24], [866, 526, 18]];
  flowers.forEach(([x, y, r], k) => {
    const sp = Math.sin(t * 3 + k) * 0.08;
    // 花瓣
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU + sp;
      const px = x + Math.cos(a) * r * 0.8;
      const py = y + Math.sin(a) * r * 0.8;
      parts.push(svgr`<ellipse cx="${px}" cy="${py}" rx="${r * 0.45}" ry="${r * 0.18}"
        transform="rotate(${(a * 180 / Math.PI).toFixed(1)} ${px} ${py})" fill="#f2b51c"/>`);
    }
    parts.push(svgr`<circle cx="${x}" cy="${y}" r="${r * 0.45}" fill="#8a4b14"/>`);
  });
  
  // 吊灯
  parts.push(svgr`<line x1="1000" y1="0" x2="1000" y2="150" stroke="#3a2a2a" stroke-width="4"/>`);
  parts.push(svgr`<path d="M968,176 Q1000,132 1032,176 Z" fill="#f1c232"/>`);
  parts.push(svgr`<circle cx="1000" cy="182" r="12" fill="#fff6c0"/>`);
  
  // 墙上两幅小画
  const paintings: [number, number, number, number, string, string][] = [
    [1590, 250, 100, 120, '#d9733a', '#66a35a'],
    [1730, 250, 100, 120, '#e8d36a', '#4f7fc9'],
  ];
  paintings.forEach(([x, y, w, h, a, b]) => {
    parts.push(svgr`<rect x="${x - 10}" y="${y - 10}" width="${w + 20}" height="${h + 20}" fill="#d8a83a"/>`);
    parts.push(svgr`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${b}"/>`);
    parts.push(svgr`<ellipse cx="${x + w / 2}" cy="${y + h * 0.55}" rx="${w * 0.28}" ry="${h * 0.25}" fill="${a}"/>`);
  });
  
  return svgr`${parts}`;
}

/** 窗框 */
function windowFrame(): Svgr {
  return svgr`
    <rect x="357" y="127" width="446" height="426" fill="none" stroke="${C.frame}" stroke-width="26"/>
    <rect x="366" y="136" width="428" height="408" fill="none" stroke="${C.frameHi}" stroke-width="6"/>
    <rect x="568" y="140" width="20" height="400" fill="${C.frame}"/>
    <rect x="330" y="552" width="500" height="22" fill="${C.frameHi}"/>
    <rect x="330" y="570" width="500" height="14" fill="${C.frame}"/>
  `;
}

/** 热气（从杯口卷曲上升） */
function steam(t: number, x: number, y: number): Svgr {
  const parts: Svgr[] = [];
  for (let k = 0; k < 2; k++) {
    const ox = (k - 0.5) * 14;
    const ph = t * 3 + k * 2.1 + 1;
    const pts: [number, number][] = [];
    for (let s = 0; s <= 20; s++) {
      const q = s / 20;
      pts.push([x + ox + Math.sin(ph - q * 5) * 9 * q, y - q * 70]);
    }
    parts.push(svgr`<path d="${pointsToPath(pts)}" fill="none"
      stroke="rgba(240,244,255,0.85)" stroke-width="4" stroke-linecap="round"
      opacity="${1 - pts.length / 25}"/>`);
  }
  return svgr`${parts}`;
}

export const postimpScene: ArtStyleScene = {
  id: '09_postimp',
  name: '梵高',
  period: '1889',
  quality: 3,
  shortcomings: '每帧 120ms 最重',
  renderFrame(frame: Frame, _ctx: FFramesContext, params: ArtStyleParams): Svgr {
    const { width: W, height: H, localTime: lt, globalTime: t } = params;
    
    return svgr`<g>
      <defs>
        <linearGradient id="wallGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${C.wall}"/>
          <stop offset="100%" stop-color="${C.wall2}"/>
        </linearGradient>
      </defs>
      <!-- 墙面底色 -->
      <rect x="0" y="0" width="${W}" height="720" fill="url(#wallGrad)"/>
      <!-- 墙面笔触 -->
      ${wallStrokes(W, H, t, 9)}
      <!-- 地板 -->
      ${floorLines(W, H)}
      <!-- 星空（窗户区域） -->
      ${starrySky(t)}
      <!-- 窗框 -->
      ${windowFrame()}
      <!-- 灯晕 -->
      ${lampHalo(t)}
      <!-- 家具 -->
      ${furniture(t)}
      <!-- 热气 -->
      ${steam(t, 1005, 660)}
    </g>`;
  },
};
