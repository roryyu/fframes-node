/**
 * 37_xiaohei — 小黑漫画风 (Ian Xiaohei SVG Motion)
 *
 * Ported from chengfeng-videocut-skills / ian-xiaohei-svg-motion.
 * White 16:9 canvas, black hand-drawn linework, Xiaohei character performing
 * a core action with 7-beat narrative progression.
 *
 * Color roles (from style-rules.md):
 * - Black (#1a1a1a): linework, Xiaohei, objects, main Chinese text
 * - Orange (#e8722a): main path, flow direction, motion arrows
 * - Red (#d94040): problems, breakpoints, warnings, results
 * - Blue (#3a7bd5): side notes, before/after context, system status
 *
 * SVG layering (from svg-layering.md):
 * background → mainObject → xiaohei → inputs → outputs → failure → arrows → annotations
 *
 * 7-beat progression (from motion-rules.md):
 * 0: show context → 1: move input → 2: first breakpoint →
 * 3: next segment → 4: move output → 5: second breakpoint → 6: summary
 *
 * Metaphor: "sorting task" — Xiaohei sorts cards on a conveyor belt;
 * one card falls into a pit; Xiaohei reaches down and rescues it.
 */

import { svgr } from '../../core/svgr.ts';
import type { Svgr } from '../../core/svgr.ts';
import type { Frame } from '../../core/frame.ts';
import type { FFramesContext } from '../../core/types.ts';
import type { ArtStyleScene, ArtStyleParams } from '../types.ts';
import { clamp, lerp, seg, ease, smooth } from '../math.ts';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const C = {
  bg:        '#ffffff',
  ink:       '#1a1a1a',
  inkSoft:   '#4a4a4a',
  orange:    '#e8722a',
  red:       '#d94040',
  blue:      '#3a7bd5',
  gray:      '#c0c0c0',
  grayLight: '#ececec',
  cardFill:  '#fafafa',
};

// ---------------------------------------------------------------------------
// Beat timing
// ---------------------------------------------------------------------------
const BEAT_DUR = 1.0;   // seconds per beat
const BEAT_COUNT = 7;

function beatInfo(lt: number): { beat: number; p: number } {
  const t = clamp(lt / BEAT_DUR, 0, BEAT_COUNT - 0.001);
  return { beat: Math.floor(t), p: t - Math.floor(t) };
}

// ---------------------------------------------------------------------------
// Scene geometry (1920×1080 canvas)
// ---------------------------------------------------------------------------
const BELT_Y   = 600;
const BELT_H   = 36;
const BELT_X0  = 180;
const BELT_X1  = 1740;
const PIT_X    = 1020;
const PIT_W    = 130;
const PIT_DEPTH = 220;

const XH_X = 720;          // Xiaohei center-x
const XH_Y = BELT_Y - 8;   // Xiaohei feet y

// Card dimensions
const CARD_W = 90;
const CARD_H = 56;

// ---------------------------------------------------------------------------
// Hand-drawn wobble helpers
// ---------------------------------------------------------------------------
function wob(v: number, seed: number, amt = 1.8): number {
  return v + Math.sin(seed * 13.7 + v * 0.037) * amt;
}

/** Quadratic hand-drawn line path */
function handLine(x1: number, y1: number, x2: number, y2: number, seed = 0): string {
  const mx = (x1 + x2) / 2 + Math.sin(seed * 7.3) * 4;
  const my = (y1 + y2) / 2 + Math.cos(seed * 5.1) * 4;
  return `M${wob(x1, seed).toFixed(1)},${wob(y1, seed).toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${wob(x2, seed + 1).toFixed(1)},${wob(y2, seed + 1).toFixed(1)}`;
}

/** Stroke-draw reveal: dasharray trick */
function drawReveal(pathLen: number, p: number): string {
  const drawn = pathLen * clamp(p);
  return `stroke-dasharray="${drawn.toFixed(1)} ${(pathLen - drawn).toFixed(1)}"`;
}

// ---------------------------------------------------------------------------
// Layer: background
// ---------------------------------------------------------------------------
function layerBackground(W: number, H: number): Svgr {
  return svgr`<rect width="${W}" height="${H}" fill="${C.bg}"/>`;
}

// ---------------------------------------------------------------------------
// Layer: mainObject — conveyor belt + rollers + pit
// ---------------------------------------------------------------------------
function layerBelt(lt: number, beat: number): Svgr {
  const parts: Svgr[] = [];

  // Belt left segment
  parts.push(svgr`<rect x="${BELT_X0}" y="${BELT_Y}" width="${PIT_X - BELT_X0}" height="${BELT_H}"
    fill="${C.grayLight}" stroke="${C.ink}" stroke-width="2.5" rx="2"/>`);

  // Belt right segment
  parts.push(svgr`<rect x="${PIT_X + PIT_W}" y="${BELT_Y}" width="${BELT_X1 - PIT_X - PIT_W}" height="${BELT_H}"
    fill="${C.grayLight}" stroke="${C.ink}" stroke-width="2.5" rx="2"/>`);

  // Rollers (rotating spokes)
  const rollerXs = [240, 380, 520, 660, 800, 940];
  const rollerXs2 = [PIT_X + PIT_W + 60, PIT_X + PIT_W + 200, PIT_X + PIT_W + 340, PIT_X + PIT_W + 480, PIT_X + PIT_W + 620];
  const rot = (lt * 120) % 360;
  for (const rx of [...rollerXs, ...rollerXs2]) {
    const cy = BELT_Y + BELT_H / 2;
    parts.push(svgr`<circle cx="${rx}" cy="${cy}" r="11" fill="none" stroke="${C.inkSoft}" stroke-width="2"/>`);
    const rad = rot * Math.PI / 180;
    parts.push(svgr`<line x1="${rx}" y1="${cy}" x2="${(rx + 9 * Math.cos(rad)).toFixed(1)}" y2="${(cy + 9 * Math.sin(rad)).toFixed(1)}"
      stroke="${C.inkSoft}" stroke-width="2" stroke-linecap="round"/>`);
  }

  // Belt legs
  for (const lx of [BELT_X0 + 30, PIT_X - 40, PIT_X + PIT_W + 30, BELT_X1 - 30]) {
    parts.push(svgr`<line x1="${lx}" y1="${BELT_Y + BELT_H}" x2="${lx}" y2="${BELT_Y + BELT_H + 120}"
      stroke="${C.ink}" stroke-width="4" stroke-linecap="round"/>`);
  }

  // Pit (appears at beat 2)
  if (beat >= 2) {
    const pitOp = beat === 2 ? smooth(seg(lt, 2 * BEAT_DUR, 2 * BEAT_DUR + 0.35)) : 1;
    parts.push(svgr`<g opacity="${pitOp.toFixed(3)}">
      <rect x="${PIT_X}" y="${BELT_Y}" width="${PIT_W}" height="${PIT_DEPTH}" fill="${C.ink}" opacity="0.07"/>
      <path d="${handLine(PIT_X, BELT_Y, PIT_X, BELT_Y + PIT_DEPTH, 30)}" stroke="${C.red}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="${handLine(PIT_X + PIT_W, BELT_Y, PIT_X + PIT_W, BELT_Y + PIT_DEPTH, 31)}" stroke="${C.red}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="${handLine(PIT_X, BELT_Y + PIT_DEPTH, PIT_X + PIT_W, BELT_Y + PIT_DEPTH, 32)}" stroke="${C.red}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-dasharray="8,6"/>
    </g>`);
  }

  return svgr`<g id="mainObject">${parts}</g>`;
}

// ---------------------------------------------------------------------------
// Layer: xiaohei — black filled body, white dot eyes, thin curved arms
// ---------------------------------------------------------------------------
function layerXiaohei(lt: number, beat: number, p: number): Svgr {
  const parts: Svgr[] = [];

  // Subtle idle bob
  const bob = Math.sin(lt * 3.5) * 3;
  const bx = XH_X;
  const by = XH_Y + bob;

  // Lean toward pit during beats 3-4
  let lean = 0;
  if (beat === 3) lean = lerp(0, 12, ease.out(p));
  else if (beat === 4) lean = lerp(12, 0, ease.out(p));

  // Right arm reach
  let armAngle = -20;   // resting angle (degrees from horizontal)
  let armLen = 55;
  if (beat === 3) { armAngle = lerp(-20, 55, ease.out(p)); armLen = lerp(55, 95, ease.out(p)); }
  else if (beat === 4) { armAngle = lerp(55, -20, ease.out(p)); armLen = lerp(95, 55, ease.out(p)); }

  const shoulderX = bx + 38;
  const shoulderY = by - 105;
  const armRad = armAngle * Math.PI / 180;
  const elbowX = shoulderX + armLen * 0.55 * Math.cos(armRad);
  const elbowY = shoulderY + armLen * 0.55 * Math.sin(armRad);
  const handX = shoulderX + armLen * Math.cos(armRad);
  const handY = shoulderY + armLen * Math.sin(armRad);

  // Body group with lean
  parts.push(svgr`<g transform="rotate(${lean.toFixed(2)} ${bx} ${by})">`);

  // Legs
  parts.push(svgr`<line x1="${bx - 16}" y1="${by - 20}" x2="${bx - 22}" y2="${by + 28}"
    stroke="${C.ink}" stroke-width="7" stroke-linecap="round"/>`);
  parts.push(svgr`<line x1="${bx + 16}" y1="${by - 20}" x2="${bx + 22}" y2="${by + 28}"
    stroke="${C.ink}" stroke-width="7" stroke-linecap="round"/>`);

  // Body (black filled ellipse)
  parts.push(svgr`<ellipse cx="${bx}" cy="${by - 80}" rx="44" ry="58" fill="${C.ink}"/>`);

  // Eyes (white dots)
  const pupilDx = beat >= 2 ? 4 : 0;
  parts.push(svgr`<circle cx="${bx - 14}" cy="${by - 92}" r="7" fill="white"/>`);
  parts.push(svgr`<circle cx="${bx + 14}" cy="${by - 92}" r="7" fill="white"/>`);
  parts.push(svgr`<circle cx="${(bx - 14 + pupilDx).toFixed(1)}" cy="${by - 92}" r="3.5" fill="${C.ink}"/>`);
  parts.push(svgr`<circle cx="${(bx + 14 + pupilDx).toFixed(1)}" cy="${by - 92}" r="3.5" fill="${C.ink}"/>`);

  // Left arm (static, slightly back)
  parts.push(svgr`<path d="M${bx - 38},${by - 100} Q${bx - 68},${by - 75} ${bx - 58},${by - 48}"
    stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>`);

  // Right arm (animated)
  parts.push(svgr`<path d="M${shoulderX},${shoulderY} Q${elbowX.toFixed(1)},${elbowY.toFixed(1)} ${handX.toFixed(1)},${handY.toFixed(1)}"
    stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>`);

  // Hand circle
  parts.push(svgr`<circle cx="${handX.toFixed(1)}" cy="${handY.toFixed(1)}" r="8" fill="${C.ink}"/>`);

  parts.push(svgr`</g>`);

  return svgr`<g id="xiaohei">${parts}</g>`;
}

// ---------------------------------------------------------------------------
// Layer: inputs / outputs — cards on the belt
// ---------------------------------------------------------------------------
function card(x: number, y: number, rot: number, stroke: string, label?: string): Svgr {
  return svgr`<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rot.toFixed(2)})">
    <rect x="${-CARD_W / 2}" y="${-CARD_H / 2}" width="${CARD_W}" height="${CARD_H}" rx="4"
      fill="${C.cardFill}" stroke="${stroke}" stroke-width="2.5"/>
    <line x1="${-CARD_W / 2 + 14}" y1="-10" x2="${CARD_W / 2 - 14}" y2="-10" stroke="${C.gray}" stroke-width="2" stroke-linecap="round"/>
    <line x1="${-CARD_W / 2 + 14}" y1="2" x2="${CARD_W / 2 - 24}" y2="2" stroke="${C.gray}" stroke-width="2" stroke-linecap="round"/>
    <line x1="${-CARD_W / 2 + 14}" y1="14" x2="${CARD_W / 2 - 18}" y2="14" stroke="${C.gray}" stroke-width="2" stroke-linecap="round"/>
    ${label ? svgr`<text x="0" y="${CARD_H / 2 + 22}" text-anchor="middle" font-family="PingFang SC" font-size="18" fill="${C.inkSoft}">${label}</text>` : svgr``}
  </g>`;
}

function layerCards(lt: number, beat: number, p: number): Svgr {
  const parts: Svgr[] = [];

  // Card A — normal, travels left→right, exits at beat 5
  const aP = seg(lt, 0.8 * BEAT_DUR, 5.5 * BEAT_DUR);
  const ax = lerp(BELT_X0 - 60, BELT_X1 + 60, ease.linear(aP));
  const ay = BELT_Y - CARD_H / 2 - 4;
  if (aP > 0 && aP < 1) {
    parts.push(card(ax, ay, 0, C.ink));
  }

  // Card B — the one that falls into the pit
  let bx2 = 0, by2 = 0, brot = 0, bStroke = C.ink;
  if (beat < 2) {
    // Approaching pit
    const approach = seg(lt, 0.5 * BEAT_DUR, 2 * BEAT_DUR);
    bx2 = lerp(BELT_X0 - 40, PIT_X + PIT_W / 2, ease.linear(approach));
    by2 = BELT_Y - CARD_H / 2 - 4;
    brot = 0;
  } else if (beat === 2) {
    // Falling into pit
    bx2 = PIT_X + PIT_W / 2;
    by2 = lerp(BELT_Y - CARD_H / 2 - 4, BELT_Y + PIT_DEPTH - 30, ease.in(p));
    brot = lerp(0, 28, ease.out(p));
    bStroke = C.red;
  } else if (beat === 3) {
    // In pit, Xiaohei reaching
    bx2 = PIT_X + PIT_W / 2;
    by2 = BELT_Y + PIT_DEPTH - 30;
    brot = 28;
    bStroke = C.red;
  } else if (beat === 4) {
    // Being pulled out
    bx2 = lerp(PIT_X + PIT_W / 2, PIT_X + PIT_W + 60, ease.out(p));
    by2 = lerp(BELT_Y + PIT_DEPTH - 30, BELT_Y - CARD_H / 2 - 4, ease.out(p));
    brot = lerp(28, 0, ease.out(p));
    bStroke = p > 0.6 ? C.ink : C.red;
  } else {
    // Resumed travel
    const resume = seg(lt, 4.8 * BEAT_DUR, 6.5 * BEAT_DUR);
    bx2 = lerp(PIT_X + PIT_W + 60, BELT_X1 + 60, ease.linear(resume));
    by2 = BELT_Y - CARD_H / 2 - 4;
    brot = 0;
  }
  if (beat >= 1 || (beat === 0 && lt > 0.5 * BEAT_DUR)) {
    parts.push(card(bx2, by2, brot, bStroke));
  }

  // Output bin (appears beat 5+)
  if (beat >= 5) {
    const binOp = beat === 5 ? smooth(seg(lt, 5 * BEAT_DUR, 5 * BEAT_DUR + 0.4)) : 1;
    parts.push(svgr`<g opacity="${binOp.toFixed(3)}">
      <rect x="${BELT_X1 - 100}" y="${BELT_Y - 90}" width="100" height="90" rx="4"
        fill="none" stroke="${C.blue}" stroke-width="3"/>
      <text x="${BELT_X1 - 50}" y="${BELT_Y - 100}" text-anchor="middle"
        font-family="PingFang SC" font-size="20" fill="${C.blue}">完成</text>
    </g>`);
  }

  return svgr`<g id="inputs">${parts}</g>`;
}

// ---------------------------------------------------------------------------
// Layer: arrows — orange flow direction
// ---------------------------------------------------------------------------
function layerArrows(lt: number, beat: number): Svgr {
  if (beat < 1) return svgr``;
  const parts: Svgr[] = [];

  // Main flow arrow (draws in at beat 1)
  const arrowP = seg(lt, BEAT_DUR, 1.6 * BEAT_DUR);
  const arrowLen = 500;
  parts.push(svgr`<g>
    <path d="M320,${BELT_Y - 80} L${320 + arrowLen},${BELT_Y - 80}"
      stroke="${C.orange}" stroke-width="4" fill="none" stroke-linecap="round"
      ${drawReveal(arrowLen, arrowP)}/>
    ${arrowP > 0.85 ? svgr`<path d="M${320 + arrowLen - 14},${BELT_Y - 92} L${320 + arrowLen + 2},${BELT_Y - 80} L${320 + arrowLen - 14},${BELT_Y - 68}"
      stroke="${C.orange}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : svgr``}
  </g>`);

  // Rescue arrow (beat 4)
  if (beat >= 4) {
    const resP = seg(lt, 4 * BEAT_DUR, 4.6 * BEAT_DUR);
    parts.push(svgr`<path d="M${PIT_X + PIT_W / 2},${BELT_Y + PIT_DEPTH - 60} Q${PIT_X + PIT_W + 30},${BELT_Y + 60} ${PIT_X + PIT_W + 80},${BELT_Y - 20}"
      stroke="${C.orange}" stroke-width="3.5" fill="none" stroke-linecap="round"
      ${drawReveal(280, resP)}/>`);
  }

  return svgr`<g id="arrows">${parts}</g>`;
}

// ---------------------------------------------------------------------------
// Layer: annotations — sparse, short, by beat
// ---------------------------------------------------------------------------
function layerAnnotations(lt: number, beat: number): Svgr {
  const parts: Svgr[] = [];

  // Beat 0: context labels (blue)
  if (beat >= 0) {
    const op = smooth(seg(lt, 0.15 * BEAT_DUR, 0.6 * BEAT_DUR));
    parts.push(svgr`<g opacity="${op.toFixed(3)}">
      <text x="${BELT_X0 + 10}" y="${BELT_Y - 110}" font-family="PingFang SC" font-size="26" fill="${C.blue}">输入</text>
      <text x="${BELT_X1 - 60}" y="${BELT_Y - 110}" font-family="PingFang SC" font-size="26" fill="${C.blue}">输出</text>
    </g>`);
  }

  // Beat 2: problem label (red)
  if (beat >= 2) {
    const op = smooth(seg(lt, 2.15 * BEAT_DUR, 2.5 * BEAT_DUR));
    parts.push(svgr`<g opacity="${op.toFixed(3)}">
      <text x="${PIT_X + PIT_W / 2}" y="${BELT_Y + PIT_DEPTH + 40}" text-anchor="middle"
        font-family="PingFang SC" font-size="26" fill="${C.red}">漏掉了！</text>
      <path d="${handLine(PIT_X + PIT_W / 2, BELT_Y + PIT_DEPTH + 18, PIT_X + PIT_W / 2, BELT_Y + PIT_DEPTH - 10, 50)}"
        stroke="${C.red}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    </g>`);
  }

  // Beat 4: action label (orange)
  if (beat >= 4) {
    const op = smooth(seg(lt, 4.1 * BEAT_DUR, 4.45 * BEAT_DUR));
    parts.push(svgr`<g opacity="${op.toFixed(3)}">
      <text x="${XH_X}" y="${XH_Y - 175}" text-anchor="middle"
        font-family="PingFang SC" font-size="24" fill="${C.orange}">捡回来</text>
    </g>`);
  }

  // Beat 6: summary (ink)
  if (beat >= 6) {
    const op = smooth(seg(lt, 6.1 * BEAT_DUR, 6.6 * BEAT_DUR));
    // Stroke-draw underline
    const ulP = seg(lt, 6.3 * BEAT_DUR, 6.8 * BEAT_DUR);
    parts.push(svgr`<g opacity="${op.toFixed(3)}">
      <text x="960" y="920" text-anchor="middle"
        font-family="PingFang SC" font-size="34" fill="${C.ink}">每张卡片都要到位</text>
      <path d="M780,935 L1140,935" stroke="${C.orange}" stroke-width="4" fill="none" stroke-linecap="round"
        ${drawReveal(360, ulP)}/>
    </g>`);
  }

  return svgr`<g id="annotations">${parts}</g>`;
}

// ---------------------------------------------------------------------------
// Exported scene
// ---------------------------------------------------------------------------
export const xiaoheiScene: ArtStyleScene = {
  id: '37_xiaohei',
  name: '小黑漫画风',
  period: '当代',
  quality: 3,
  shortcomings: '',
  renderFrame(_frame: Frame, _ctx: FFramesContext, params: ArtStyleParams): Svgr {
    const { width: W, height: H, localTime: lt } = params;
    const { beat, p } = beatInfo(lt);

    return svgr`<g>
      ${layerBackground(W, H)}
      ${layerBelt(lt, beat)}
      ${layerXiaohei(lt, beat, p)}
      ${layerCards(lt, beat, p)}
      ${layerArrows(lt, beat)}
      ${layerAnnotations(lt, beat)}
    </g>`;
  },
};
