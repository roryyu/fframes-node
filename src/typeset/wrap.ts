/**
 * 语义断行 —— 把一段中文文本按宽度折成多行。
 *
 * 按宽度硬切的中文断行读起来是断的：「今天天气很好」可能断成「今天天气很 / 好」。
 * 这里移植 cy-carousel（chengyi-ai/cy-carousel-skill，MIT）排版器的三层做法：
 *
 * 1. **原子化**（{@link atoms}）—— 人名、日期、数字+单位、书名号、英文词先合成不可拆的
 *    原子；标点贴住前一个词（不能出现在行首），开引号贴住后一个词（不能留在行尾），
 *    外文名间隔号「·」两边连住；
 * 2. **按标点断句** —— 逗号、句号、分号……都是天然断点，先切成分句，放得下的句子不拆，
 *    已用「。！？」收尾且放了大半行的句子不再续接下一句；
 * 3. **评分选断点**（内部 `breakScore`）—— 长句必须在原子之间断开时，从能放下的断点里
 *    挑得分最高的：标点/引号处 3 分、词与词之间 1 分（虚词后、双字词后更自然）、以
 *    「的」「了」等虚字开头或只剩单字的断点直接排除；两行字数越匀称越好，末行将出现
 *    孤字时扣分。断完再用「防孤字」把上一行末尾的原子挪下来补足末行。
 *
 * 测量与断行解耦：本模块只吃一个 `measure(text) => px` 回调，真实场景由
 * `FontMetrics`（或拉丁混排测量函数）提供，单测用任意确定性函数即可。
 */

/** 句读停顿符：逗号、句号、分号等，都是天然断句点。 */
export const CLAUSE_END: ReadonlySet<string> = new Set('，。：；！？…');
/** 开引号/开括号：断行时不能留在行尾。 */
export const OPENING: ReadonlySet<string> = new Set('「『《（(“');
/** 闭引号/闭括号与句读标点：断行时不能出现在行首；间隔号「·」按标点处理。 */
export const CLOSING: ReadonlySet<string> = new Set('，。、：；！？…」』》）)”,.!?:;·');
/** 虚词开头：以这些字开头的行读起来突兀，不作为断点候选。 */
export const NO_START: ReadonlySet<string> = new Set('的了着地得们吗呢吧啊');
/** 自然停顿字：这些字之后断行更顺（词与词之间的加分项）。 */
export const FRIENDLY_AFTER: ReadonlySet<string> = new Set(
  '的了着过在和与及把被是到从给向对为里上中后前时地得也都就还又才再却而并或说道',
);

/** 句号类结尾：一行以「。！？」收尾且已放了大半行时，不再续接下一句。 */
const SENTENCE_END = '。！？';

const firstChar = (text: string): string => text[0] ?? '';
const lastChar = (text: string): string => text.at(-1) ?? '';
const isSpace = (ch: string): boolean => /\s/.test(ch);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 内置原子模式：书名号、引号短句、日期、数字+单位、英文单词。 */
const BUILTIN_PATTERNS: readonly string[] = [
  '《[^》]{1,16}》',
  '「[^」]{1,7}」',
  '\\d{1,4}年(?:\\d{1,2}月(?:\\d{1,2}日)?)?',
  '\\d{1,2}月\\d{1,2}日',
  '\\d[\\d.,]*(?:年代|世纪|万|亿|千|百|厘米|毫米|公里|英寸|英尺|小时|分钟|岁|天|个|倍|号|米|寸|%|％)?',
  "[A-Za-z][A-Za-z'’\\-]*",
];

/** 默认分词：按码点逐字切（含代理对的字符不会被拆开）。 */
const codePoints = (run: string): string[] => [...run];

export interface AtomsOptions {
  /**
   * 保护词：人名、品牌名等，作为整体原子参与断行，绝不被拆开。长词优先匹配
   * （「小明」写在「小」之前）。
   */
  readonly protect?: readonly string[];
  /**
   * 非保护文本的分词器，默认按码点逐字切。想按词断行可注入 `Intl.Segmenter`：
   *
   * ```ts
   * const seg = new Intl.Segmenter('zh', { granularity: 'word' });
   * const segment = (run: string) => [...seg.segment(run)].map((s) => s.segment);
   * wrapText(text, { width, measure, segment });
   * ```
   */
  readonly segment?: (run: string) => readonly string[];
}

/**
 * 把文本切成断行用的原子序列。返回的原子是「不可拆开的最小单元」：标点已贴住前词，
 * 开引号已贴住后词，保护词与内置模式（日期、数字+单位、英文词等）各自成整体。
 */
export function atoms(text: string, options: AtomsOptions = {}): string[] {
  const segment = options.segment ?? codePoints;
  const protect = [...(options.protect ?? [])]
    .filter((word) => word.length > 0)
    .sort((a, b) => b.length - a.length);
  const source = [...protect.map(escapeRegExp), ...BUILTIN_PATTERNS]
    .map((pattern) => `(?:${pattern})`)
    .join('|');
  // sticky：从 lastIndex 处精确匹配，等价于 Python 的 `rx.match(text, i)`。
  const rx = new RegExp(source, 'y');

  const out: string[] = [];
  let run = '';
  let i = 0;
  while (i < text.length) {
    rx.lastIndex = i;
    const match = rx.exec(text);
    if (match !== null) {
      out.push(...segment(run));
      run = '';
      out.push(match[0]);
      i = rx.lastIndex;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (CLOSING.has(ch) || OPENING.has(ch)) {
      out.push(...segment(run));
      run = '';
      out.push(ch);
    } else {
      run += ch;
    }
    i += ch.length;
  }
  out.push(...segment(run));

  // 合并：标点贴住前一个原子；开引号、「·」贴住后一个原子。
  const merged: string[] = [];
  for (const atom of out) {
    if (atom.length === 0) {
      continue;
    }
    const last = merged[merged.length - 1];
    if (last !== undefined && CLOSING.has(firstChar(atom))) {
      merged[merged.length - 1] = last + atom;
    } else if (last !== undefined && (OPENING.has(lastChar(last)) || lastChar(last) === '·')) {
      merged[merged.length - 1] = last + atom;
    } else {
      merged.push(atom);
    }
  }
  return merged;
}

/** 可见字数：标点、引号与空白都不算。用来判断行是不是「孤字行」「短行」。 */
export function visibleLength(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (!CLOSING.has(ch) && !OPENING.has(ch) && !isSpace(ch)) {
      count += 1;
    }
  }
  return count;
}

/**
 * 在 `seq[k]` 前断行的得分（null = 这不是候选断点）。
 *
 * 候选排除：下一个原子以虚字开头，或只剩单字且以标点收尾（会把标点甩到下一行）。
 * 得分：标点后/开引号前 3 分，虚词后或双字原子后 1 分，其余 0 分；行首太短（≤2 字，
 * 或不到半行）扣分，末行将出现孤字扣分；再按「两行匀称」或「尽量靠后断」微调。
 */
function breakScore(seq: readonly string[], k: number, kmax: number, cap: number): number | null {
  const next = seq[k]!;
  const previous = seq[k - 1]!;
  if (NO_START.has(firstChar(next)) || (visibleLength(next) <= 1 && CLOSING.has(lastChar(next)))) {
    return null;
  }
  const head = visibleLength(seq.slice(0, k).join(''));
  const tail = visibleLength(seq.slice(k).join(''));
  let score =
    OPENING.has(firstChar(next)) || CLOSING.has(lastChar(previous))
      ? 3
      : FRIENDLY_AFTER.has(lastChar(previous)) || [...previous].length >= 2
        ? 1
        : 0;
  if (head <= 2) {
    score -= 3;
  } else if (head < cap * 0.45) {
    score -= 2;
  }
  if (tail < 3) {
    score -= 2.5;
  }
  score -= head + tail <= 2 * cap ? 0.25 * Math.abs(head - tail) : 0.35 * (kmax - k);
  return score;
}

/** 一个放不下的分句：在能放下的范围里挑得分最高的断点，逐行切下去。 */
function splitLong(seq: readonly string[], fits: (text: string) => boolean, cap: number): string[][] {
  const lines: string[][] = [];
  let rest = [...seq];
  while (rest.length > 0 && !fits(rest.join(''))) {
    let kmax = 0;
    for (let k = 1; k < rest.length; k += 1) {
      if (fits(rest.slice(0, k).join(''))) {
        kmax = k;
      } else {
        break;
      }
    }
    if (kmax === 0) {
      throw new Error(
        `typeset: 单个原子「${rest[0]!}」超过栏宽，无法断行 —— 检查字体度量或栏宽设置`,
      );
    }
    let best = kmax;
    let bestScore: number | null = null;
    for (let k = kmax; k >= 1; k -= 1) {
      const score = breakScore(rest, k, kmax, cap);
      if (score !== null && (bestScore === null || score > bestScore)) {
        best = k;
        bestScore = score;
      }
    }
    lines.push(rest.slice(0, best));
    rest = rest.slice(best);
  }
  if (rest.length > 0) {
    lines.push(rest);
  }
  return lines;
}

export interface WrapOptions extends AtomsOptions {
  /** 排版栏宽（px），与 measure 返回的宽度同单位。 */
  readonly width: number;
  /**
   * 测量一行文本的宽度（px）。真实场景用 `FontMetrics.width` 或按字体选择的混排
   * 测量函数；单测可用任意确定性函数（如每字 40px）。
   */
  readonly measure: (text: string) => number;
  /**
   * 一行大约能放几个全角字，供「两行匀称」「短行」启发式使用。
   * 默认 `width / measure('国')`。
   */
  readonly capacity?: number;
}

export interface WrapLine {
  readonly text: string;
  /** 行是因栏宽不足断开（软断）而非段末；两端对齐只拉软断行。 */
  readonly soft: boolean;
}

/**
 * 把文本折成行数组。文本里手动写的 `\n` 保留（只对放不下的行再断），放得下的整段不动。
 *
 * ```ts
 * const lines = wrapText('太极空间，让每一次呼吸都值得记录。', {
 *   width: 880,
 *   measure: (t) => metrics.width(t, 40),
 * });
 * ```
 */
export function wrapText(text: string, options: WrapOptions): string[] {
  return wrapTextDetailed(text, options).map((line) => line.text);
}

/** 同 {@link wrapText}，但每行附带「是否软断」标记。 */
export function wrapTextDetailed(text: string, options: WrapOptions): WrapLine[] {
  const fits = (line: string): boolean => options.measure(line) <= options.width;
  const unit = options.measure('国');
  const cap = options.capacity ?? (unit > 0 ? options.width / unit : 1);

  if (text.includes('\n')) {
    const out: WrapLine[] = [];
    for (const line of text.split('\n')) {
      out.push(...(fits(line) ? [{ text: line, soft: false }] : wrapTextDetailed(line, options)));
    }
    return out;
  }
  if (fits(text)) {
    return [{ text, soft: false }];
  }

  // 1. 原子化，按标点分句。
  const clauses: string[][] = [];
  let clause: string[] = [];
  for (const atom of atoms(text, options)) {
    clause.push(atom);
    if (CLAUSE_END.has(lastChar(atom))) {
      clauses.push(clause);
      clause = [];
    }
  }
  if (clause.length > 0) {
    clauses.push(clause);
  }

  // 2. 逐句塞行：放得下的句子先凑一行，长句才拆。
  const lines: string[][] = [];
  let current: string[] = [];
  for (const next of clauses) {
    const ended =
      current.length > 0 &&
      SENTENCE_END.includes(lastChar(current[current.length - 1]!)) &&
      visibleLength(current.join('')) > cap * 0.4;
    if (current.length > 0 && !ended && fits([...current, ...next].join(''))) {
      current.push(...next);
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = [];
    }
    if (fits(next.join(''))) {
      current = [...next];
    } else {
      const parts = splitLong(next, fits, cap);
      lines.push(...parts.slice(0, -1));
      current = parts[parts.length - 1]!;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }

  // 3. 防孤字：末行不足 3 个实字，就从上一行末尾挪原子下来。
  while (
    lines.length >= 2 &&
    visibleLength(lines[lines.length - 1]!.join('')) < 3 &&
    lines[lines.length - 2]!.length > 1
  ) {
    const before = lines[lines.length - 2]!;
    const last = lines[lines.length - 1]!;
    const candidateBefore = before.slice(0, -1);
    const candidateLast = [...before.slice(-1), ...last];
    if (visibleLength(candidateBefore.join('')) < 3 || !fits(candidateLast.join(''))) {
      break;
    }
    lines[lines.length - 2] = candidateBefore;
    lines[lines.length - 1] = candidateLast;
  }

  return lines.map((line, i) => ({ text: line.join(''), soft: i < lines.length - 1 }));
}
