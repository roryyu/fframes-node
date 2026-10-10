/**
 * 中文排版模块 —— 从 cy-carousel（chengyi-ai/cy-carousel-skill，MIT）迁移重构的四件套：
 *
 * - `FontMetrics`：零依赖 SFNT 解析器，从字体文件读字宽 / 字高 / 字形边界
 *   （resvg 不暴露文本测量 API，没有它就没有断行）；
 * - `atoms` / `wrapText`：原子化分词 + 断点评分，中文按语义断行（标点贴前、防孤字）；
 * - `typeset`：把一段文字排成 SVG —— 破折号 / 省略号 / 书名号 / 间隔号的中式排字细节、
 *   拉丁混排、两端对齐、限行截断；
 * - `renderCard` / `cardScene`：竖列图文卡片构建器，档位试排自动适配字号，可直接进视频。
 *
 * 使用示例见 README 的「Typeset：中文图文排版」章节与 `examples/typeset-card/`。
 */

// --- 字体度量 ---
export { FontMetrics } from './font-metrics.ts';
export type { FontMetricsOptions, GlyphBounds } from './font-metrics.ts';

// --- 语义断行 ---
export {
  atoms,
  CLAUSE_END,
  CLOSING,
  FRIENDLY_AFTER,
  NO_START,
  OPENING,
  visibleLength,
  wrapText,
  wrapTextDetailed,
} from './wrap.ts';
export type { AtomsOptions, WrapLine, WrapOptions } from './wrap.ts';

// --- 排字 ---
export { typeset } from './text.ts';
export type { FontFace, TypeSetGlyph, TypeSetOptions, TypeSetResult, TypeSetSpecial } from './text.ts';

// --- 图文卡片 ---
export { cardScene, renderCard } from './card.ts';
export type {
  AppearSpec,
  CardBlock,
  CardImageBlock,
  CardPlacement,
  CardResult,
  CardRuleBlock,
  CardSpacerBlock,
  CardSpec,
  CardTextBlock,
  TextRole,
} from './card.ts';
