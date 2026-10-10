/**
 * 图文卡片构建器 —— 把「标题 / 正文 / 强调 / 注文 / 图片 / 分隔线」按竖列排成一张
 * 完整卡片（SVG），并可直接包成场景（`cardScene`）放进视频。
 *
 * 自动适配机制移植 cy-carousel（chengyi-ai/cy-carousel-skill，MIT）的 `lay_column`：
 *
 * 1. **档位试排**：字号从 `1.08` 倍起逐档下调（1.08 / 1.0 / 0.94 / 0.88 / 0.82 / 0.76），
 *    取第一个放得下的档位 —— 内容少时字大、内容多时字小，不让读者看「半页字」；
 * 2. **间距弹性**：块与块之间的间距在 `gapMin`（默认卡宽 5%）与 `gapMax`（默认 gapMin 的
 *    2.5 倍）之间匀开，把剩余空间摊进间距而不是堆在页底；
 * 3. **图片兜底**：所有档位都放不下且含图片块时，图片高逐次 ×0.85 再试，文字字号不掉档；
 * 4. **明确失败**：仍然放不下就抛错并给出「需要多少 px、只有多少 px」—— 不自动裁字、不缩到
 *    看不清，请作者删字或换版式（与上层的定位一致：宁可报错不给坏画面）。
 *
 * 文本块内部交给 `typeset()` 排字与断行；每块可声明 `appear` 入场动效（fade / rise），
 * `renderCard` 吃 `localTime` 产出该时刻的帧，`cardScene` 把它接成 `Scene`。
 */

import { seconds } from '../core/duration.ts';
import { svgr, type Svgr } from '../core/svgr.ts';
import type { Frame } from '../core/frame.ts';
import type { FFramesContext, Scene } from '../core/types.ts';
import { typeset, type FontFace, type TypeSetResult } from './text.ts';

/** 文本角色：决定默认字号、行高与颜色语义。 */
export type TextRole = 'title' | 'heading' | 'emphasis' | 'body' | 'note' | 'label';

/** 入场动效：`at` 秒开始、持续 `dur` 秒；`rise` 在淡入时上浮一小段。 */
export interface AppearSpec {
  /** 出现时刻（秒，场景内相对），默认 0。 */
  readonly at?: number;
  /** 持续时长（秒），默认 0.5。 */
  readonly dur?: number;
  /** `fade` 只淡入；`rise` 淡入 + 上浮（默认）。 */
  readonly mode?: 'fade' | 'rise';
}

export interface CardTextBlock {
  readonly kind: 'text';
  readonly text: string;
  /** 角色，默认 `body`。 */
  readonly role?: TextRole;
  /** 显式字号（px，卡宽基准），覆盖角色默认；仍参与档位缩放。 */
  readonly size?: number;
  readonly align?: 'left' | 'center' | 'right';
  readonly color?: string;
  readonly justify?: boolean;
  readonly maxLines?: number;
  readonly letterSpacing?: number;
  readonly appear?: AppearSpec;
}

export interface CardImageBlock {
  readonly kind: 'image';
  /** 媒体目录里的文件名（`ctx.getImage(file)`）。 */
  readonly file: string;
  /** 展示高度（px），必填（宽度撑满内容区，超出按 `fit` 裁切或留白）。 */
  readonly height: number;
  /** 圆角（px），默认 0。 */
  readonly radius?: number;
  /** `cover` 裁切填满（默认）；`contain` 完整显示。 */
  readonly fit?: 'cover' | 'contain';
  readonly appear?: AppearSpec;
}

export interface CardRuleBlock {
  readonly kind: 'rule';
  /** 线宽（px），默认内容宽 12%。 */
  readonly width?: number;
  /** 线粗（px），默认 3。 */
  readonly thickness?: number;
  /** 颜色，默认强调色。 */
  readonly color?: string;
  readonly align?: 'left' | 'center' | 'right';
  readonly appear?: AppearSpec;
}

export interface CardSpacerBlock {
  readonly kind: 'spacer';
  /** 固定高度（px）。块自身也吃前后弹性间距。 */
  readonly height: number;
}

export type CardBlock = CardTextBlock | CardImageBlock | CardRuleBlock | CardSpacerBlock;

export interface CardSpec {
  readonly width: number;
  readonly height: number;
  /** 底色，默认 `#ffffff`。 */
  readonly background?: string;
  /** 底层装饰（渐变、纹理等），插在底色之上、内容之下。 */
  readonly backdrop?: Svgr;
  /** 内容边距，默认卡宽 8%。 */
  readonly padding?: number;
  /** 主字体（中文）。 */
  readonly face: FontFace;
  /** 拉丁/数字字体；缺省用主字体。 */
  readonly latin?: FontFace;
  /** 缺字回退字体。 */
  readonly fallback?: FontFace;
  /** 标题字体（title / heading 用）；缺省用主字体。 */
  readonly titleFace?: FontFace;
  /** 强调色（emphasis 文字、分隔线），默认 `#c2410c`。 */
  readonly accent?: string;
  /** 正文色，默认 `#1a1a1a`。 */
  readonly color?: string;
  /** 次要色（note / label / 页脚），默认 `#6b7280`。 */
  readonly muted?: string;
  /** 全局两端对齐；块可覆盖，默认 false。 */
  readonly justify?: boolean;
  /** 断行保护词。 */
  readonly protect?: readonly string[];
  /** 块间最小间距，默认卡宽 5%。 */
  readonly gapMin?: number;
  /** 块间最大间距，默认 `gapMin × 2.5`。 */
  readonly gapMax?: number;
  /** 内容块（顶对齐依次向下）。 */
  readonly blocks: readonly CardBlock[];
  /** 页脚小字（右下角）。 */
  readonly footer?: string;
}

/** 一个块最终摆放的位置。 */
export interface CardPlacement {
  readonly kind: CardBlock['kind'];
  readonly y: number;
  readonly height: number;
}

export interface CardResult {
  /** 整卡 SVG（不含 `<svg>` 根）。 */
  readonly svg: Svgr;
  /** 内容占用的总高（含上下边距，px）。 */
  readonly usedHeight: number;
  /** 实际采用的档位（1.08 / 1.0 / …）。 */
  readonly scale: number;
  readonly placements: readonly CardPlacement[];
}

/** 角色默认字号（相对卡宽）。 */
const ROLE_SIZE: Record<TextRole, number> = {
  title: 0.082,
  heading: 0.062,
  emphasis: 0.066,
  body: 0.039,
  note: 0.033,
  label: 0.024,
};

/** 角色字号上下限（相对卡宽，防档位缩放走极端）。 */
const ROLE_RANGE: Record<TextRole, readonly [number, number]> = {
  title: [0.06, 0.1],
  heading: [0.048, 0.075],
  emphasis: [0.054, 0.08],
  body: [0.032, 0.046],
  note: [0.027, 0.039],
  label: [0.019, 0.03],
};

/** 角色行高倍数。 */
const ROLE_LINE_HEIGHT: Record<TextRole, number> = {
  title: 1.3,
  heading: 1.34,
  emphasis: 1.38,
  body: 1.46,
  note: 1.46,
  label: 1.4,
};

/** 自动适配的档位序列（从大到小）。 */
const SCALES: readonly number[] = [1.08, 1.0, 0.94, 0.88, 0.82, 0.76];

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const clamp01 = (value: number): number => clamp(value, 0, 1);

const hashString = (value: string): string => {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
};

/** 试排后的一个块 —— 选定档位直接复用，不再重排。 */
interface TrialBlock {
  readonly block: CardBlock;
  readonly height: number;
  /** text 块的排版结果（本地坐标：x 从 pad 起、y 从 0 起）。 */
  readonly text?: TypeSetResult;
}

interface CardContext {
  readonly pad: number;
  readonly contentWidth: number;
  readonly imgScale: number;
  readonly accent: string;
}

/**
 * 排版一张卡片。`localTime` 用于 `appear` 动效（缺省 = 全部呈现的最终帧）。
 * `ctx` 仅在卡片含图片块时需要（`ctx.getImage`）；纯文字卡片可以不传。
 */
export function renderCard(
  spec: CardSpec,
  ctx?: FFramesContext,
  options: { readonly localTime?: number } = {},
): CardResult {
  const localTime = options.localTime ?? Number.POSITIVE_INFINITY;
  const { width, height, face } = spec;
  const pad = spec.padding ?? width * 0.08;
  const contentWidth = width - 2 * pad;
  const gapMin = spec.gapMin ?? width * 0.05;
  const gapMax = spec.gapMax ?? gapMin * 2.5;
  const accent = spec.accent ?? '#c2410c';
  const color = spec.color ?? '#1a1a1a';
  const muted = spec.muted ?? '#6b7280';

  // ---- 页脚预留 ----

  const footerSize = ROLE_SIZE.label * width;
  const footerHeight = spec.footer !== undefined ? footerSize * 1.5 + pad * 0.35 : 0;
  const available = height - 2 * pad - footerHeight;

  const roleFace = (role: TextRole): FontFace =>
    role === 'title' || role === 'heading' ? (spec.titleFace ?? face) : face;

  const roleColor = (block: CardTextBlock): string => {
    if (block.color !== undefined) {
      return block.color;
    }
    const role = block.role ?? 'body';
    if (role === 'emphasis') return accent;
    if (role === 'note' || role === 'label') return muted;
    return color;
  };

  // ---- 试排（档位 × 图片兜底）----

  const layoutTrial = (scale: number, imgScale: number): TrialBlock[] =>
    spec.blocks.map((block): TrialBlock => {
      if (block.kind === 'text') {
        const role = block.role ?? 'body';
        const base = block.size ?? ROLE_SIZE[role] * width;
        const size = clamp(
          Math.round(base * scale),
          ROLE_RANGE[role][0] * width,
          ROLE_RANGE[role][1] * width,
        );
        const result = typeset(block.text, {
          x: pad,
          y: 0,
          width: contentWidth,
          size,
          face: roleFace(role),
          latin: spec.latin,
          fallback: spec.fallback,
          lineHeight: size * ROLE_LINE_HEIGHT[role],
          align: block.align,
          color: roleColor(block),
          justify: block.justify ?? spec.justify ?? false,
          maxLines: block.maxLines,
          letterSpacing: block.letterSpacing,
          protect: spec.protect,
        });
        return { block, height: result.usedHeight, text: result };
      }
      if (block.kind === 'image') {
        return { block, height: block.height * imgScale };
      }
      if (block.kind === 'rule') {
        return { block, height: block.thickness ?? 3 };
      }
      return { block, height: block.height };
    });

  const blockCount = spec.blocks.length;
  const gapTotal = gapMin * Math.max(0, blockCount - 1);
  const hasImage = spec.blocks.some((block) => block.kind === 'image');

  let imgScale = 1;
  let chosen: { scale: number; blocks: TrialBlock[]; total: number } | null = null;
  let lastTrial: TrialBlock[] = [];
  for (let attempt = 0; attempt < 4 && chosen === null; attempt += 1) {
    for (const scale of SCALES) {
      const blocks = layoutTrial(scale, imgScale);
      const total = blocks.reduce((sum, item) => sum + item.height, 0);
      lastTrial = blocks;
      if (total + gapTotal <= available + 1e-6) {
        chosen = { scale, blocks, total };
        break;
      }
    }
    if (chosen === null && hasImage) {
      imgScale *= 0.85;
    }
  }
  if (chosen === null) {
    const total = lastTrial.reduce((sum, item) => sum + item.height, 0);
    throw new Error(
      `renderCard: 文字太多放不下（最小档也需要 ${Math.round(total + gapTotal)}px，` +
        `只有 ${Math.round(available)}px）——删减文字或提高卡片高度，不自动裁字`,
    );
  }

  // ---- 间距弹性 + 摆放 ----

  const gap =
    blockCount > 1
      ? Math.min(gapMax, Math.max(gapMin, (available - chosen.total) / (blockCount - 1)))
      : 0;

  const positions: number[] = [];
  let cursor = pad;
  const placements: CardPlacement[] = [];
  for (const item of chosen.blocks) {
    positions.push(cursor);
    placements.push({ kind: item.block.kind, y: cursor, height: item.height });
    cursor += item.height + gap;
  }
  const contentBottom = cursor - gap;
  const usedHeight = contentBottom + pad;

  // ---- 逐块渲染 ----

  const cardCtx: CardContext = {
    pad,
    contentWidth,
    imgScale,
    accent,
  };
  const defs: string[] = [];
  const layers: string[] = [];

  for (let index = 0; index < chosen.blocks.length; index += 1) {
    const item = chosen.blocks[index]!;
    const block = item.block;
    const y = positions[index]!;
    const inner = renderBlock(block, item, index, cardCtx, ctx, defs);
    if (inner === null) {
      continue;
    }
    layers.push(wrapAppear(block, y, inner, localTime, height));
  }

  // ---- 页脚 ----

  if (spec.footer !== undefined) {
    const footer = typeset(spec.footer, {
      x: pad,
      y: height - pad - footerSize * 1.4,
      width: contentWidth,
      size: footerSize,
      face,
      latin: spec.latin,
      fallback: spec.fallback,
      lineHeight: footerSize * 1.4,
      align: 'right',
      color: muted,
    });
    layers.push(footer.svg.value);
  }

  // ---- 组装 ----

  const background = `<rect width="${width}" height="${height}" fill="${spec.background ?? '#ffffff'}"/>`;
  const svg = svgr`<g>
${background}
${spec.backdrop ?? ''}
${defs.length > 0 ? `<defs>${defs.join('')}</defs>` : ''}
${layers.join('\n')}
</g>`;

  return {
    svg,
    usedHeight,
    scale: chosen.scale,
    placements,
  };
}

/** 渲染一个块的内部 SVG（本地坐标：x 从 pad 起，y 从 0 起）。 */
function renderBlock(
  block: CardBlock,
  item: TrialBlock,
  index: number,
  ctx: CardContext,
  frames: FFramesContext | undefined,
  defs: string[],
): string | null {
  if (block.kind === 'spacer') {
    return null;
  }
  if (block.kind === 'text') {
    // 试排即最终：文本 SVG 的本地坐标（x 从 pad 起、y 从 0 起）已就绪，外层 translate 定位。
    if (item.text === undefined) {
      throw new Error('renderCard: 内部错误 —— text 块的试排结果缺失');
    }
    return item.text.svg.value;
  }
  if (block.kind === 'rule') {
    const ruleWidth = block.width ?? ctx.contentWidth * 0.12;
    const thickness = block.thickness ?? 3;
    const align = block.align ?? 'left';
    const x =
      align === 'center'
        ? ctx.pad + (ctx.contentWidth - ruleWidth) / 2
        : align === 'right'
          ? ctx.pad + ctx.contentWidth - ruleWidth
          : ctx.pad;
    return (
      `<rect x="${round(x)}" y="0" width="${round(ruleWidth)}" height="${round(thickness)}" ` +
      `rx="${round(thickness / 2)}" fill="${block.color ?? ctx.accent}"/>`
    );
  }
  // image
  const uri = frames?.getImage(block.file) ?? null;
  if (uri === null) {
    throw new Error(
      `renderCard: 图片「${block.file}」不在媒体目录里（或未传 ctx）——把文件放进视频的 media/`,
    );
  }
  const imageHeight = block.height * ctx.imgScale;
  const radius = block.radius ?? 0;
  const fit = block.fit ?? 'cover';
  let clip = '';
  if (radius > 0) {
    const clipId = `cardclip-${hashString(`${block.file}:${index}:${radius}`)}`;
    defs.push(
      `<clipPath id="${clipId}"><rect x="${round(ctx.pad)}" y="0" ` +
        `width="${round(ctx.contentWidth)}" height="${round(imageHeight)}" rx="${round(radius)}"/></clipPath>`,
    );
    clip = ` clip-path="url(#${clipId})"`;
  }
  return (
    `<image x="${round(ctx.pad)}" y="0" width="${round(ctx.contentWidth)}" height="${round(imageHeight)}" ` +
    `href="${uri}" preserveAspectRatio="xMidYMid ${fit === 'contain' ? 'meet' : 'slice'}"${clip}/>`
  );
}

/** 入场动效包装：`localTime` 为 Infinity（静态帧）时原样返回。 */
function wrapAppear(
  block: CardBlock,
  y: number,
  inner: string,
  localTime: number,
  cardHeight: number,
): string {
  const appear = block.kind === 'spacer' ? undefined : block.appear;
  if (appear === undefined || !Number.isFinite(localTime)) {
    return `<g transform="translate(0,${round(y)})">${inner}</g>`;
  }
  const at = appear.at ?? 0;
  const dur = appear.dur ?? 0.5;
  const mode = appear.mode ?? 'rise';
  const progress = clamp01((localTime - at) / dur);
  if (progress <= 0) {
    return '';
  }
  const eased = progress * progress * (3 - 2 * progress);
  const rise = mode === 'rise' ? (1 - eased) * cardHeight * 0.015 : 0;
  return (
    `<g transform="translate(0,${round(y + rise)})" opacity="${eased.toFixed(3)}">` +
    `${inner}</g>`
  );
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * 把卡片包成 `Scene`：`duration` 秒的静态卡片画面，配合块上的 `appear` 做入场。
 *
 * ```ts
 * const video: Video = {
 *   fps: 30, width: 1080, height: 1440,
 *   duration: () => auto,
 *   audio: () => AudioMap.none(),
 *   defineScenes: () => [cardScene(spec, 5)],
 *   fonts: () => [songPath],
 *   renderFrame: (frame, ctx) =>
 *     svgr`<svg xmlns="…" width="1080" height="1440">${ctx.renderScenes(frame)}</svg>`,
 * };
 * ```
 */
export function cardScene(spec: CardSpec, durationSeconds: number, name = 'Card'): Scene {
  return {
    name,
    duration: () => seconds(durationSeconds),
    renderFrame: (frame: Frame, ctx: FFramesContext) =>
      renderCard(spec, ctx, { localTime: frame.seconds() }).svg,
  };
}
