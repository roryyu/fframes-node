/**
 * T3 · 财经数据图表动画语法
 * 先搭坐标系、再让数据「长」出来、最后只标一件事；一个颜色讲主角、其余变灰。
 * 
 * 核心原则：数值永远诚实（柱从 0 起、单位和来源写在图上），动画只决定「怎么出现」。
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ExplainerGrammar, GrammarSpec, GrammarCue } from '../types.ts';
import { rng, clamp, lerp, smooth, quintOut, expoOut, spring, lagged } from '../math.ts';
import { pointsToPath } from '../svg-path.ts';

// Economist 色板
const ECON_RED = '#E3120B';
const ECON_BLUE = '#006BA2';
const ECON_CYAN = '#3EBCD2';
const ECON_GREEN = '#379A8B';
const ECON_YELLOW = '#EBB434';
const ECON_GRAY = '#758D99';
const ECON_GRAY_LIGHT = '#C6D2D8';
const BLACK = '#0C0C0C';
const WHITE = '#FFFFFF';
const GRID_GRAY = 'rgba(0,0,0,0.13)';

/** 红色小旗（Economist 风格） */
function redFlag(x: number, y: number): Svgr {
  return svgr`<rect x="${x}" y="${y}" width="96" height="22" fill="${ECON_RED}"/>`;
}

/** 顶部细红线 */
function topRedLine(W: number): Svgr {
  return svgr`<rect x="0" y="0" width="${W}" height="8" fill="${ECON_RED}"/>`;
}

/** 网格线（逐条画出） */
function gridLines(x0: number, y0: number, x1: number, y1: number, count: number, t: number, startTime: number): Svgr {
  const parts: Svgr[] = [];
  
  for (let i = 0; i <= count; i++) {
    const delay = i * 0.12;
    const localT = t - startTime - delay;
    if (localT < 0) continue;
    
    const p = quintOut(clamp(localT / 0.5));
    const y = lerp(y0, y1, i / count);
    const xEnd = lerp(x0, x1, p);
    
    // 零基线加粗
    const isZero = i === count;
    parts.push(svgr`<line x1="${x0}" y1="${y}" x2="${xEnd}" y2="${y}"
      stroke="${isZero ? BLACK : GRID_GRAY}" stroke-width="${isZero ? 3 : 1.5}"/>`);
  }
  
  return svgr`${parts}`;
}

/** 柱状图（从 0 长出＋同步计数＋高亮/变灰） */
function bars(
  x0: number, y0: number, barW: number, maxH: number,
  values: number[], labels: string[],
  t: number, startTime: number,
  highlightIdx = -1
): Svgr {
  const parts: Svgr[] = [];
  const maxVal = Math.max(...values);
  const gap = barW * 0.3;
  
  values.forEach((val, i) => {
    const delay = i * 0.22;
    const localT = t - startTime - delay;
    if (localT < 0) return;
    
    const p = quintOut(clamp(localT / 1.3));
    const h = (val / maxVal) * maxH * p;
    const x = x0 + i * (barW + gap);
    const y = y0 - h;
    
    // 高亮/变灰
    const isHighlight = highlightIdx < 0 || i === highlightIdx;
    const color = isHighlight ? ECON_BLUE : ECON_GRAY_LIGHT;
    
    parts.push(svgr`<rect x="${x}" y="${y}" width="${barW}" height="${h}"
      fill="${color}"/>`);
    
    // 数值标签（跟着柱顶走）
    if (p > 0.1) {
      const displayVal = Math.floor(val * p);
      parts.push(svgr`<text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle"
        font-family="Helvetica" font-size="18" font-weight="bold"
        fill="${isHighlight ? BLACK : ECON_GRAY}">${displayVal}</text>`);
    }
    
    // X 轴标签
    if (i < labels.length) {
      const labelP = clamp((t - startTime - 0.5 - i * 0.1) / 0.3);
      parts.push(svgr`<text x="${x + barW / 2}" y="${y0 + 25}" text-anchor="middle"
        font-family="Helvetica" font-size="14" fill="${ECON_GRAY}"
        opacity="${labelP}">${labels[i]}</text>`);
    }
  });
  
  return svgr`${parts}`;
}

/** 折线图（按 x 推进画出） */
function lineChart(
  x0: number, y0: number, w: number, h: number,
  values: number[], labels: string[],
  t: number, startTime: number
): Svgr {
  const parts: Svgr[] = [];
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const range = maxVal - minVal || 1;
  
  const localT = t - startTime;
  if (localT < 0) return svgr``;
  
  const p = smooth(clamp(localT / 1.5));
  const n = values.length;
  const visibleCount = Math.floor(p * n);
  
  // 生成路径点
  const pts: [number, number][] = [];
  for (let i = 0; i <= visibleCount && i < n; i++) {
    const x = x0 + (i / (n - 1)) * w;
    const y = y0 - ((values[i] - minVal) / range) * h;
    pts.push([x, y]);
  }
  
  // 插值最后一个点
  if (visibleCount < n - 1 && visibleCount >= 0) {
    const frac = p * n - visibleCount;
    const i = visibleCount;
    if (i < n - 1) {
      const x = x0 + ((i + frac) / (n - 1)) * w;
      const y0v = ((values[i] - minVal) / range) * h;
      const y1v = ((values[i + 1] - minVal) / range) * h;
      const y = y0 - lerp(y0v, y1v, frac);
      pts.push([x, y]);
    }
  }
  
  if (pts.length < 2) return svgr``;
  
  // 面积渐变
  const areaPath = [...pts, [pts[pts.length - 1][0], y0], [pts[0][0], y0]] as [number, number][];
  parts.push(svgr`<path d="${pointsToPath(areaPath, true)}"
    fill="${ECON_BLUE}" opacity="0.14"/>`);
  
  // 折线
  parts.push(svgr`<path d="${pointsToPath(pts)}"
    fill="none" stroke="${ECON_BLUE}" stroke-width="5" stroke-linecap="round"/>`);
  
  // 头部圆点
  const lastPt = pts[pts.length - 1];
  parts.push(svgr`<circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="9"
    fill="${ECON_BLUE}"/>`);
  
  // 价格标签
  const lastVal = values[Math.min(visibleCount, n - 1)];
  parts.push(svgr`<text x="${lastPt[0] + 15}" y="${lastPt[1] - 15}"
    font-family="monospace" font-size="20" font-weight="bold" fill="${ECON_BLUE}">${lastVal.toFixed(1)}</text>`);
  
  return svgr`${parts}`;
}

/** 标注（圆点弹出＋引线＋文字） */
function callout(
  x: number, y: number, text: string,
  t: number, triggerTime: number
): Svgr {
  const localT = t - triggerTime;
  if (localT < 0) return svgr``;
  
  const parts: Svgr[] = [];
  
  // 圆点弹出（spring）
  const dotP = spring(localT, { duration: 0.45, bounce: 0.25 });
  parts.push(svgr`<circle cx="${x}" cy="${y}" r="${8 * dotP}"
    fill="${ECON_RED}"/>`);
  
  // 脉冲环
  const pulseP = clamp(localT / 0.6);
  if (pulseP < 1) {
    parts.push(svgr`<circle cx="${x}" cy="${y}" r="${8 + pulseP * 20}"
      fill="none" stroke="${ECON_RED}" stroke-width="2" opacity="${1 - pulseP}"/>`);
  }
  
  // 引线（0.12s 后画出）
  const lineT = localT - 0.12;
  if (lineT > 0) {
    const lineP = clamp(lineT / 0.3);
    const endX = x + 80 * lineP;
    const endY = y - 40 * lineP;
    parts.push(svgr`<line x1="${x}" y1="${y}" x2="${endX}" y2="${endY}"
      stroke="${ECON_GRAY}" stroke-width="2"/>`);
    
    // 文字（0.3s 后淡入）
    const textT = localT - 0.42;
    if (textT > 0) {
      const textP = clamp(textT / 0.3);
      parts.push(svgr`<text x="${endX + 5}" y="${endY}"
        font-family="sans-serif" font-size="14" fill="${BLACK}"
        opacity="${textP}">${text}</text>`);
    }
  }
  
  return svgr`${parts}`;
}

/** 来源行 */
function sourceLine(x: number, y: number, text: string): Svgr {
  return svgr`<text x="${x}" y="${y}" font-family="Helvetica"
    font-size="12" fill="${ECON_GRAY}" opacity="0.75">${text}</text>`;
}

/** 示意数据角标 */
function demoBadge(W: number, H: number): Svgr {
  return svgr`<text x="${W - 10}" y="${H - 10}" text-anchor="end"
    font-family="sans-serif" font-size="11" fill="${ECON_GRAY}" opacity="0.6">示意数据</text>`;
}

export const financeChartGrammar: ExplainerGrammar = {
  id: 'finance_chart',
  name: '财经数据图表',
  description: '先搭坐标系、再让数据「长」出来、最后只标一件事；一个颜色讲主角、其余变灰；数值永远诚实。',
  renderFrame(frame: Frame, _ctx: FFramesContext, spec: GrammarSpec): Svgr {
    const { width: W, height: H, cues, data } = spec;
    const t = frame.seconds();
    
    // 从 data 获取配置
    const title = (data?.title as string) || '营收五年涨到原来的近 9 倍';
    const subtitle = (data?.subtitle as string) || '年营收，亿元';
    const source = (data?.source as string) || '数据来源：公司年报';
    const chartType = (data?.chartType as string) || 'bar'; // 'bar' | 'line'
    const values = (data?.values as number[]) || [12.4, 28.6, 45.2, 67.8, 107.9];
    const labels = (data?.labels as string[]) || ['2019', '2020', '2021', '2022', '2023'];
    const highlightIdx = (data?.highlightIdx as number) ?? values.length - 1;
    const calloutText = (data?.calloutText as string) || '';
    const calloutAt = (data?.calloutAt as number) ?? 2.5;
    
    // 图表区域
    const chartX = W * 0.12;
    const chartY = H * 0.75;
    const chartW = W * 0.76;
    const chartH = H * 0.5;
    const barW = 60;
    
    return svgr`<g>
      <!-- 白底 -->
      <rect width="${W}" height="${H}" fill="${WHITE}"/>
      
      <!-- 版式 -->
      ${topRedLine(W)}
      ${redFlag(20, 20)}
      
      <!-- 标题 -->
      <text x="20" y="70" font-family="sans-serif" font-size="32"
        font-weight="bold" fill="${BLACK}">${title}</text>
      <text x="20" y="100" font-family="sans-serif" font-size="16"
        fill="${ECON_GRAY}">${subtitle}</text>
      
      <!-- 网格 -->
      ${gridLines(chartX, chartY - chartH, chartX + chartW, chartY, 5, t, 0.5)}
      
      <!-- 图表内容 -->
      ${chartType === 'bar'
        ? bars(chartX + 20, chartY, barW, chartH, values, labels, t, 1.0, highlightIdx)
        : lineChart(chartX + 20, chartY, chartW - 40, chartH, values, labels, t, 1.0)
      }
      
      <!-- 标注 -->
      ${calloutText ? callout(
        chartX + chartW * 0.7, chartY - chartH * 0.6,
        calloutText, t, calloutAt
      ) : svgr``}
      
      <!-- 来源 -->
      ${sourceLine(20, H - 20, source)}
      ${demoBadge(W, H)}
      
      <!-- 处理 cues -->
      ${cues.map(cue => {
        const localT = t - cue.at;
        if (localT < 0) return svgr``;
        
        if (cue.kind === 'number') {
          const p = expoOut(clamp(localT / 0.9));
          const value = Math.floor(p * (parseFloat(cue.text || '100')));
          return svgr`<text x="${W * 0.5}" y="${H * 0.35}" text-anchor="middle"
            font-family="monospace" font-size="64" font-weight="bold" fill="${ECON_BLUE}"
            opacity="${clamp(localT / 0.3)}">${value}</text>`;
        }
        
        return svgr``;
      })}
    </g>`;
  },
};
