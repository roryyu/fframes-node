/**
 * 文本块排版 —— 把一段中文文本排成字形级 SVG 树。
 *
 * 这是 cy-carousel（chengyi-ai/cy-carousel-skill，MIT）「排字细节」的 SVG 版：
 * Python 那边用 PIL 往位图上逐字画，这里逐字定位后输出 SVG，位置规则逐一移植：
 *
 * - **破折号「—」** 不画字体字形，而画一段细线（长 0.74em、粗 0.045em，最小 1.5px），
 *   垂直居中于汉字字面中线（`国` 的墨迹中线，宋体实测 -0.35em），推进宽收窄到 0.86em
 *   ——「——」即两段带间隙的线；
 * - **省略号「…」** 画三个等距圆点（直径 0.12em、点距 1/3 em），同样居中于汉字中线；
 * - **【】窄排** 到 0.44em（字体的方头括号侧面留白太宽），开括号靠右、闭括号靠左，
 *   距相邻字 0.03em；
 * - **间隔号「·」** 窄排到 0.30em，墨迹居中；
 * - **数字与拉丁字母** 可换西文字体（`latin`），按 `latinScale` 缩放、共用基线；
 * - **缺字回退**：主字体缺字形时依次尝试 `latin` / `fallback`，都缺则抛错，绝不静默画豆腐。
 *
 * 断行用 `wrapText`（栏宽留 3% 余量，让行尾标点不出界）；`justify` 把余量均分到字间
 * （含空格的行优先只拉空格；两个拉丁字符之间、连续「——」「……」内部不拉；要拉超过
 * 0.05em/字就不拉，留参差比拉出窟窿好看）。行高默认 `size × 1.36`，基线 = 行顶 + 主字体 ascent。
 *
 * 输出：同字体同字号的连续字形合并成一个 `<text>` 用 x 列表定位；图形字输出
 * `<rect>` / `<circle>`。返回结构带 `lines` / `glyphs` / `usedWidth` / `usedHeight`，
 * 供上层（如卡片构建器）做自动适配。
 */

import { svgr, type Svgr } from '../core/svgr.ts';
import type { FontMetrics } from './font-metrics.ts';
import { wrapTextDetailed, type WrapLine } from './wrap.ts';

/** 一个字体角色：SVG 用的字体族名 + 度量。 */
export interface FontFace {
  /** `font-family` 值（resvg 注册的字体名）。 */
  readonly family: string;
  readonly metrics: FontMetrics;
}

/** 排字规则里的图形字符类别。 */
export type TypeSetSpecial = 'dash' | 'dots' | 'bracket-open' | 'bracket-close' | 'middot';

/** 排版产出的单个字形定位。`x + shift` 才是字形实际落点。 */
export interface TypeSetGlyph {
  readonly char: string;
  /** 字格起点（px）。 */
  readonly x: number;
  /** 字形额外位移（px，【】· 窄排校正用，其余为 0）。 */
  readonly shift: number;
  /** 基线 y（px）。 */
  readonly baseline: number;
  /** 字格宽（px，含 letterSpacing）。 */
  readonly advance: number;
  /** 实际渲染字体族。 */
  readonly family: string;
  /** 实际渲染字号（拉丁混排时可能不同）。 */
  readonly size: number;
  /** 行号（0 起）。 */
  readonly line: number;
  /** 图形字类别；普通字形为 null。 */
  readonly special: TypeSetSpecial | null;
}

export interface TypeSetOptions {
  /** 文本块左上角 x，默认 0。 */
  readonly x?: number;
  /** 文本块顶部 y（第一行行顶），默认 0。 */
  readonly y?: number;
  /** 栏宽（px）。断行按 `width × 0.97` 执行，余量给行尾标点。 */
  readonly width: number;
  /** 容器高（px）；给了就检查溢出，超出抛错（不自动缩字号）。 */
  readonly height?: number;
  /** 字号（px）。 */
  readonly size: number;
  /** 主字体。 */
  readonly face: FontFace;
  /** 拉丁/数字字体；缺省用主字体。 */
  readonly latin?: FontFace;
  /** 缺字回退字体。 */
  readonly fallback?: FontFace;
  /** 拉丁字号相对主字号的缩放，默认 1（随具体字体搭配调，如西文衬线配宋体可试 1.07）。 */
  readonly latinScale?: number;
  /** 行高（px），默认 `size × 1.36`。 */
  readonly lineHeight?: number;
  /** 字间距（px），默认 0。 */
  readonly letterSpacing?: number;
  /** 对齐，默认左对齐。 */
  readonly align?: 'left' | 'center' | 'right';
  /** 文字颜色，默认黑。 */
  readonly color?: string;
  /** 保护词（人名、品牌名），交给断行使用。 */
  readonly protect?: readonly string[];
  /** 启用排字规则（破折号/省略号/【】· 窄排），默认 true。 */
  readonly typo?: boolean;
  /** 两端对齐，默认 false。 */
  readonly justify?: boolean;
  /** 行数上限；超出截断（见 `ellipsis`）。 */
  readonly maxLines?: number;
  /** 截断时末行加「…」，默认 true。 */
  readonly ellipsis?: boolean;
}

export interface TypeSetResult {
  /** 文本块的 SVG 树（不含 `<svg>` 根）。 */
  readonly svg: Svgr;
  /** 断行结果（每行文本，不加省略号前的原文）。 */
  readonly lines: readonly string[];
  /** 全部字形定位（行优先）。 */
  readonly glyphs: readonly TypeSetGlyph[];
  /** 实际使用宽（最长行，px）。 */
  readonly usedWidth: number;
  /** 实际使用高（行数 × 行高，px）。 */
  readonly usedHeight: number;
  /** 行数。 */
  readonly lineCount: number;
  /** 字号（px，与入参一致）。 */
  readonly size: number;
}

/** 排字规则数值（见 references/排字细节.md，5 篇 1:1 复刻实测）。 */
const TYPO = {
  dashLen: 0.74,
  dashThick: 0.045,
  dashAdv: 0.86,
  dotsD: 0.12,
  dotsPitch: 1 / 3,
  bracket: 0.44,
  bracketMargin: 0.03,
  middot: 0.3,
  justifySpaceMax: 0.5,
  justifyMax: 0.05,
} as const;

/** 换西文衬线字体的字符集（cy-carousel 同款白名单）。 */
const LATIN_CHARS: ReadonlySet<string> = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%.+',
);

const isBlank = (ch: string): boolean => ch.trim().length === 0;

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });

const fmt = (n: number): string => {
  const s = n.toFixed(2);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
};

/**
 * 把一段文本排成 SVG 字形树。
 *
 * ```ts
 * const songti = FontMetrics.load('/System/Library/Fonts/Supplemental/Songti.ttc');
 * const block = typeset('太极空间，让每一次呼吸都值得记录。', {
 *   x: 120, y: 200, width: 800,
 *   size: 44,
 *   face: { family: 'Songti SC', metrics: songti },
 *   lineHeight: 44 * 1.6,
 * });
 * // block.svg    — 插进画面
 * // block.usedHeight — 已用高度，供下一个区块接着排
 * ```
 */
export function typeset(text: string, options: TypeSetOptions): TypeSetResult {
  const { x = 0, y = 0, width, size, face } = options;
  const latin = options.latin;
  const fallback = options.fallback;
  const latinScale = options.latinScale ?? 1;
  const letterSpacing = options.letterSpacing ?? 0;
  const lineHeight = options.lineHeight ?? size * 1.36;
  const align = options.align ?? 'left';
  const color = options.color ?? '#000000';
  const typo = options.typo ?? true;
  const justify = options.justify ?? false;
  const ellipsis = options.ellipsis ?? true;

  // ---- 字符 → 字体 + 字号（渲染与断行共用同一逻辑）----

  const faceFor = (ch: string): { face: FontFace; size: number } => {
    let chosen = latin !== undefined && LATIN_CHARS.has(ch) ? latin : face;
    let chosenSize = chosen === face ? size : size * latinScale;
    const codePoint = ch.codePointAt(0)!;
    if (!isBlank(ch) && !chosen.metrics.hasGlyph(codePoint)) {
      if (latin !== undefined && chosen !== latin && latin.metrics.hasGlyph(codePoint)) {
        chosen = latin;
        chosenSize = size * latinScale;
      } else if (fallback !== undefined && fallback.metrics.hasGlyph(codePoint)) {
        chosen = fallback;
        chosenSize = size;
      } else {
        throw new Error(
          `typeset: 缺字「${ch}」（U+${codePoint.toString(16).toUpperCase()}）——` +
            '主字体没有这个字形，也没有可用的回退字体',
        );
      }
    }
    return { face: chosen, size: chosenSize };
  };

  const specialOf = (ch: string): TypeSetSpecial | null => {
    if (!typo) {
      return null;
    }
    if (ch === '—') return 'dash';
    if (ch === '…') return 'dots';
    if (ch === '【') return 'bracket-open';
    if (ch === '】') return 'bracket-close';
    if (ch === '·') return 'middot';
    return null;
  };

  const advanceOf = (ch: string): number => {
    const special = specialOf(ch);
    if (special === 'dash') return TYPO.dashAdv * size + letterSpacing;
    if (special === 'dots') return size + letterSpacing;
    if (special === 'bracket-open' || special === 'bracket-close') {
      return TYPO.bracket * size + letterSpacing;
    }
    if (special === 'middot') return TYPO.middot * size + letterSpacing;
    const picked = faceFor(ch);
    return (picked.face.metrics.advanceEm(ch.codePointAt(0)!) ?? 1) * picked.size + letterSpacing;
  };

  const measure = (line: string): number => {
    let total = 0;
    for (const ch of line) {
      total += advanceOf(ch);
    }
    return total;
  };

  // ---- 断行（栏宽留 3% 余量）----

  const wrapWidth = width * 0.97;
  let rows: readonly WrapLine[] = wrapTextDetailed(text, {
    width: wrapWidth,
    measure,
    protect: options.protect,
  });

  // ---- 行数截断 ----

  if (options.maxLines !== undefined && rows.length > options.maxLines) {
    rows = rows.slice(0, options.maxLines);
    const last = rows[rows.length - 1]!;
    let lastText = last.text;
    if (ellipsis) {
      if (measure(`${lastText}…`) <= wrapWidth) {
        lastText = `${lastText}…`;
      } else {
        const chars = [...lastText];
        while (chars.length > 0 && measure(`${chars.join('')}…`) > wrapWidth) {
          chars.pop();
        }
        lastText = `${chars.join('')}…`;
      }
    }
    rows = [...rows.slice(0, -1), { text: lastText, soft: false }];
  }

  // ---- 行内定位 ----

  // 破折号/省略号的垂直中线：`国` 的墨迹中线；无 glyf 表（CFF）时用实测均值 -0.36em。
  const hanBounds = face.metrics.boundsEm('国'.codePointAt(0)!);
  const hanCenterEm = hanBounds !== undefined ? (hanBounds.yMin + hanBounds.yMax) / 2 : -0.36;

  const glyphs: TypeSetGlyph[] = [];
  const glyphRows: TypeSetGlyph[][] = [];
  let usedWidth = 0;

  for (let li = 0; li < rows.length; li += 1) {
    const row = rows[li]!;
    const chars = [...row.text];
    const baseline = y + li * lineHeight + face.metrics.ascentEm * size;
    const advances = chars.map((ch) => advanceOf(ch));
    let rowWidth = advances.reduce((sum, adv) => sum + adv, 0);

    // 两端对齐：只拉软断行，余量均分到字间。
    if (justify && row.soft) {
      rowWidth = justifyRow(chars, advances, rowWidth, wrapWidth, size);
    }

    const offset =
      align === 'center'
        ? Math.max(0, (width - rowWidth) / 2)
        : align === 'right'
          ? Math.max(0, width - rowWidth)
          : 0;

    let pen = x + offset;
    const rowGlyphs: TypeSetGlyph[] = [];
    for (let ci = 0; ci < chars.length; ci += 1) {
      const ch = chars[ci]!;
      const special = specialOf(ch);
      const advance = advances[ci]!;
      let family = face.family;
      let glyphSize = size;
      let shift = 0;

      if (special === 'bracket-open' || special === 'bracket-close' || special === 'middot') {
        const picked = faceFor(ch);
        family = picked.face.family;
        glyphSize = picked.size;
        // 窄排校正：把字体自带的多余侧面留白收掉，让括号/间隔号贴住相邻字。
        const bounds = picked.face.metrics.boundsEm(ch.codePointAt(0)!);
        if (bounds !== undefined) {
          if (special === 'bracket-open') {
            shift =
              advance - letterSpacing - TYPO.bracketMargin * size - bounds.xMax * glyphSize;
          } else if (special === 'bracket-close') {
            shift = TYPO.bracketMargin * size - bounds.xMin * glyphSize;
          } else {
            shift = (advance - letterSpacing) / 2 - ((bounds.xMin + bounds.xMax) / 2) * glyphSize;
          }
        }
      } else if (special === null) {
        const picked = faceFor(ch);
        family = picked.face.family;
        glyphSize = picked.size;
      }

      rowGlyphs.push({
        char: ch,
        x: pen,
        shift,
        baseline,
        advance,
        family,
        size: glyphSize,
        line: li,
        special,
      });
      pen += advance;
    }

    glyphs.push(...rowGlyphs);
    glyphRows.push(rowGlyphs);
    usedWidth = Math.max(usedWidth, rowWidth);
  }

  // ---- 溢出检查 ----

  const usedHeight = rows.length * lineHeight;
  if (options.height !== undefined && usedHeight > options.height + 1) {
    throw new Error(
      `typeset: 文本溢出（${Math.round(usedHeight)}px > ${options.height}px，` +
        `${rows.length} 行）——缩短文本或调整字号/行高，不自动缩字号`,
    );
  }

  // ---- SVG 组装 ----

  const parts: string[] = [];
  for (const rowGlyphs of glyphRows) {
    let run: TypeSetGlyph[] = [];
    const flush = (): void => {
      if (run.length === 0) {
        return;
      }
      const head = run[0]!;
      const xs = run.map((glyph) => fmt(glyph.x + glyph.shift)).join(' ');
      const content = escapeXml(run.map((glyph) => glyph.char).join(''));
      parts.push(
        `<text x="${xs}" y="${fmt(head.baseline)}" font-family="${escapeXml(head.family)}" ` +
          `font-size="${fmt(head.size)}" fill="${color}">${content}</text>`,
      );
      run = [];
    };
    for (const glyph of rowGlyphs) {
      if (glyph.special === 'dash' || glyph.special === 'dots') {
        flush();
        parts.push(specialMarkup(glyph, hanCenterEm, size, color));
      } else {
        // 普通字形与【】· 都在文本 run 里（靠逐字 x + shift 定位）。
        const last = run[run.length - 1];
        if (last !== undefined && (last.family !== glyph.family || last.size !== glyph.size)) {
          flush();
        }
        run.push(glyph);
      }
    }
    flush();
  }

  return {
    svg: svgr`<g>${parts.join('\n')}</g>`,
    lines: rows.map((row) => row.text),
    glyphs,
    usedWidth,
    usedHeight,
    lineCount: rows.length,
    size,
  };
}

/**
 * 两端对齐一行：把余量均分到「可拉字间」。修改 `advances` 并返回新行宽。
 *
 * 规则（移植 render.py）：行尾空格不算；含空格的行只要空格均摊 ≤ 0.50em 就只拉空格；
 * 双拉丁之间、连续「——」「……」内部不拉；均摊量 > 0.05em/字就整体放弃（留参差）。
 */
function justifyRow(
  chars: readonly string[],
  advances: number[],
  rowWidth: number,
  limit: number,
  size: number,
): number {
  let end = chars.length;
  while (end > 0 && isBlank(chars[end - 1]!)) {
    end -= 1;
  }
  if (end < 2) {
    return rowWidth;
  }
  let contentWidth = 0;
  for (let i = 0; i < end; i += 1) {
    contentWidth += advances[i]!;
  }
  const extra = limit - contentWidth;
  if (extra <= 0) {
    return rowWidth;
  }

  const pairable = (a: string, b: string): boolean =>
    !(LATIN_CHARS.has(a) && LATIN_CHARS.has(b)) && !(a === b && (a === '—' || a === '…'));
  let slots: number[] = [];
  for (let i = 0; i < end - 1; i += 1) {
    if (pairable(chars[i]!, chars[i + 1]!)) {
      slots.push(i);
    }
  }
  const innerSpaces: number[] = [];
  for (let i = 1; i < end - 1; i += 1) {
    if (chars[i] === ' ') {
      innerSpaces.push(i);
    }
  }
  if (innerSpaces.length > 0 && extra / innerSpaces.length <= TYPO.justifySpaceMax * size) {
    slots = innerSpaces;
  }
  if (slots.length === 0 || extra / slots.length > TYPO.justifyMax * size) {
    return rowWidth;
  }
  const add = extra / slots.length;
  for (const i of slots) {
    advances[i] = advances[i]! + add;
  }
  return contentWidth + extra;
}

/** 图形字（破折号/省略号）的 SVG：细线段 / 三个等距圆点。 */
function specialMarkup(glyph: TypeSetGlyph, hanCenterEm: number, size: number, color: string): string {
  const cy = glyph.baseline + hanCenterEm * size;
  if (glyph.special === 'dash') {
    const length = TYPO.dashLen * size;
    const thick = Math.max(1.5, TYPO.dashThick * size);
    const startX = glyph.x + (glyph.advance - length) / 2;
    return (
      `<rect x="${fmt(startX)}" y="${fmt(cy - thick / 2)}" ` +
      `width="${fmt(length)}" height="${fmt(thick)}" fill="${color}"/>`
    );
  }
  const radius = (TYPO.dotsD * size) / 2;
  const pitch = TYPO.dotsPitch * size;
  const centerX = glyph.x + glyph.advance / 2;
  return [-1, 0, 1]
    .map(
      (j) =>
        `<circle cx="${fmt(centerX + j * pitch)}" cy="${fmt(cy)}" r="${fmt(radius)}" fill="${color}"/>`,
    )
    .join('');
}
