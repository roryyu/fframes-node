/**
 * 字体度量 —— 从字体文件本身读取字宽、字高与字形边界。
 *
 * `@resvg/resvg-js` 不暴露文本测量 API：渲染管线里没有任何东西能回答「这行字有多宽」，
 * 而没有这个数就没有断行。所以这里用一个零依赖的 SFNT 解析器直接读字体表：
 *
 * - `head` / `hhea` / `maxp` —— unitsPerEm（表内单位到 em 的换算）、上升部、字形总数；
 * - `cmap` —— Unicode 码位 → 字形编号（format 4 覆盖 BMP，format 12 覆盖增补平面）；
 * - `hmtx` —— 字形 → 水平步进宽度（advance width）；
 * - `loca` + `glyf`（可选）—— 字形墨迹外接框，排字规则里给「——」「……」找汉字字面中线；
 * - `name` —— 字体族名，提示 `font-family` 该写什么。
 *
 * 测量与渲染读的是同一张 hmtx 表，所以宽度与 resvg（HarfBuzz + fontdb）一致；唯一已知
 * 偏差是拉丁字符对的 kerning 被忽略 —— 测量略偏大，是安全方向（宁可提前换行也不溢出）。
 *
 * 设计配方来自 cy-carousel（chengyi-ai/cy-carousel-skill，MIT）的排版器：那边用 PIL
 * `ImageFont.getlength` 测宽，这里换成表解析 —— Node 里没有 PIL。
 */

import { readFileSync } from 'node:fs';

/** 字形墨迹外接框，em 单位，SVG 方向：基线为 0，上方为负、右侧为正。 */
export interface GlyphBounds {
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
}

export interface FontMetricsOptions {
  /** `.ttc` 字体集合里的子字体下标，默认 0。单字体文件忽略。 */
  readonly index?: number;
}

interface TableRecord {
  readonly offset: number;
  readonly length: number;
}

const TTC_TAG = 0x74746366; // 'ttcf'

const readUint16 = (data: Uint8Array, offset: number): number =>
  (data[offset]! << 8) | data[offset + 1]!;

const readInt16 = (data: Uint8Array, offset: number): number => {
  const value = readUint16(data, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
};

const readUint32 = (data: Uint8Array, offset: number): number =>
  ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;

const readTag = (data: Uint8Array, offset: number): string =>
  String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);

/** 表目录：tag → (offset, length)。找不到的表返回 null。 */
function readTableDirectory(data: Uint8Array, fontOffset: number): Map<string, TableRecord> {
  const numTables = readUint16(data, fontOffset + 4);
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i += 1) {
    const record = fontOffset + 12 + i * 16;
    tables.set(readTag(data, record), {
      offset: readUint32(data, record + 8),
      length: readUint32(data, record + 12),
    });
  }
  return tables;
}

/** `.ttc` 的第一个子字体（或 `index`）相对文件头的位置。 */
function fontStart(data: Uint8Array, index: number): number {
  if (readUint32(data, 0) !== TTC_TAG) {
    return 0;
  }
  const numFonts = readUint32(data, 8);
  if (index < 0 || index >= numFonts) {
    throw new Error(`FontMetrics: .ttc 只有 ${numFonts} 个子字体，index=${index} 越界`);
  }
  return readUint32(data, 12 + index * 4);
}

/**
 * `cmap` 子表查找：返回码位对应的字形编号，缺字为 0。
 *
 * 优先选 Windows UCS-4（platform 3 / encoding 10，format 12），其次 Windows BMP
 * （platform 3 / encoding 1，format 4），再退到任意 Unicode 子表。
 */
function makeCmapLookup(data: Uint8Array, record: TableRecord): (codePoint: number) => number {
  const base = record.offset;
  const numSubtables = readUint16(data, base + 2);
  let best = 0;
  let bestRank = -1;
  for (let i = 0; i < numSubtables; i += 1) {
    const subtable = base + 4 + i * 8;
    const platform = readUint16(data, subtable);
    const encoding = readUint16(data, subtable + 2);
    const offset = readUint32(data, subtable + 4);
    const rank = platform === 3 && encoding === 10 ? 4 : platform === 3 && encoding === 1 ? 3 : platform === 0 ? 2 : 1;
    if (rank > bestRank) {
      bestRank = rank;
      best = base + offset;
    }
  }
  if (best === 0) {
    return () => 0;
  }

  const format = readUint16(data, best);
  if (format === 12) {
    const numGroups = readUint32(data, best + 12);
    const groupsStart = best + 16;
    return (codePoint: number): number => {
      let lo = 0;
      let hi = numGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const group = groupsStart + mid * 12;
        const start = readUint32(data, group);
        const end = readUint32(data, group + 4);
        if (codePoint < start) {
          hi = mid - 1;
        } else if (codePoint > end) {
          lo = mid + 1;
        } else {
          return readUint32(data, group + 8) + (codePoint - start);
        }
      }
      return 0;
    };
  }

  if (format === 4) {
    const segCountX2 = readUint16(data, best + 6);
    const segCount = segCountX2 / 2;
    const endCodes = best + 14;
    const startCodes = endCodes + segCountX2 + 2;
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;
    return (codePoint: number): number => {
      if (codePoint > 0xffff) {
        return 0;
      }
      let seg = 0;
      while (seg < segCount && readUint16(data, endCodes + seg * 2) < codePoint) {
        seg += 1;
      }
      if (seg >= segCount || readUint16(data, startCodes + seg * 2) > codePoint) {
        return 0;
      }
      const delta = readInt16(data, idDeltas + seg * 2);
      const rangeOffset = readUint16(data, idRangeOffsets + seg * 2);
      if (rangeOffset === 0) {
        return (codePoint + delta) & 0xffff;
      }
      // idRangeOffset 相对于它自己所在位置的地址偏移，不是表偏移。
      const glyphAt = idRangeOffsets + seg * 2 + rangeOffset + (codePoint - readUint16(data, startCodes + seg * 2)) * 2;
      if (glyphAt + 1 >= data.length) {
        return 0;
      }
      const glyph = readUint16(data, glyphAt);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    };
  }

  return () => 0;
}

/** `name` 表里的字体族名（nameID 1），读不出返回 null。 */
function readFamilyName(data: Uint8Array, record: TableRecord): string | null {
  const base = record.offset;
  const format = readUint16(data, base);
  if (format !== 0 && format !== 1) {
    return null;
  }
  const count = readUint16(data, base + 2);
  const stringOffset = base + readUint16(data, base + 4);
  let windowsName: string | null = null;
  let anyName: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const entry = base + 6 + i * 12;
    const platform = readUint16(data, entry);
    const language = readUint16(data, entry + 4);
    const nameId = readUint16(data, entry + 6);
    if (nameId !== 1) {
      continue;
    }
    const length = readUint16(data, entry + 8);
    const offset = stringOffset + readUint16(data, entry + 10);
    if (platform === 3 && language === 0x409) {
      // Windows 英文（UTF-16BE）—— 最稳定的一份。
      let value = '';
      for (let j = 0; j < length; j += 2) {
        value += String.fromCharCode(readUint16(data, offset + j));
      }
      windowsName = windowsName ?? value;
    } else if (anyName === null && platform === 1) {
      // MacRoman（ASCII 子集）。
      let value = '';
      for (let j = 0; j < length; j += 1) {
        value += String.fromCharCode(data[offset + j]!);
      }
      anyName = value;
    }
  }
  return windowsName ?? anyName;
}

interface HeadTable {
  readonly unitsPerEm: number;
  readonly indexToLocFormat: number;
}

interface HheaTable {
  readonly ascent: number;
  readonly descent: number;
  readonly numberOfHMetrics: number;
}

/** 构造函数参数 —— `buildInit` 的产物，只给类内部用。 */
interface FontMetricsInit {
  readonly data: Uint8Array;
  readonly path: string;
  readonly index: number;
  readonly head: HeadTable;
  readonly hhea: HheaTable;
  readonly family: string | null;
  readonly cmapLookup: (codePoint: number) => number;
  readonly advanceUnits: (glyphId: number) => number;
  readonly loca: Uint32Array | null;
  readonly glyf: TableRecord | null;
}

/**
 * 一个字体文件的度量视图。用 {@link load} 按路径加载（带缓存），或 {@link fromBuffer}
 * 从内存里的字体字节构造（供测试与合成字体使用）。
 *
 * ```ts
 * const f = FontMetrics.load('/System/Library/Fonts/PingFang.ttc');
 * f.width('\u4e2d\u6587排版', 48);        // px
 * f.advanceEm('\u6587'.codePointAt(0)!); // ≈ 1（全角字 1em）
 * ```
 */
export class FontMetrics {
  /** 加载来源路径（`fromBuffer` 构造时为空字符串）。 */
  readonly path: string;
  /** `.ttc` 子字体下标。 */
  readonly index: number;
  /** 表内单位每 em 的数量（1000 / 2048 等）。 */
  readonly unitsPerEm: number;
  /** 上升部（em，正数）：第一行基线离块顶的距离。 */
  readonly ascentEm: number;
  /** 下降部（em，正数）。 */
  readonly descentEm: number;
  /** 字体族名（`name` 表），读不出时为 null。 */
  readonly family: string | null;

  private readonly cmapLookup: (codePoint: number) => number;
  private readonly advanceUnits: (glyphId: number) => number;
  private readonly loca: Uint32Array | null;
  private readonly glyf: TableRecord | null;
  private readonly data: Uint8Array;

  private constructor(init: FontMetricsInit) {
    this.data = init.data;
    this.path = init.path;
    this.index = init.index;
    this.unitsPerEm = init.head.unitsPerEm;
    this.ascentEm = Math.max(0, init.hhea.ascent) / init.head.unitsPerEm;
    this.descentEm = Math.max(0, -init.hhea.descent) / init.head.unitsPerEm;
    this.family = init.family;
    this.cmapLookup = init.cmapLookup;
    this.advanceUnits = init.advanceUnits;
    this.loca = init.loca;
    this.glyf = init.glyf;
  }

  /** 按路径加载字体（按 path + index 缓存，同一个文件只解析一次）。 */
  static load(fontPath: string, options: FontMetricsOptions = {}): FontMetrics {
    const index = options.index ?? 0;
    const key = `${fontPath}\u0000${index}`;
    const cached = fontMetricsCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(fontPath);
    } catch (error) {
      throw new Error(`FontMetrics: 读不到字体文件 ${fontPath}（${(error as Error).message}）`);
    }
    const metrics = FontMetrics.fromBuffer(new Uint8Array(bytes), index);
    fontMetricsCache.set(key, metrics);
    return metrics;
  }

  /** 从内存里的字体字节构造。同样按字节解析，但**不**进缓存。 */
  static fromBuffer(bytes: Uint8Array, index = 0): FontMetrics {
    return new FontMetrics(buildInit(bytes, '', index));
  }

  /** 清空加载缓存（测试用）。 */
  static clearCache(): void {
    fontMetricsCache.clear();
  }

  /** 码位 → em 宽度；字体里没有这个字形时返回 `undefined`。 */
  advanceEm(codePoint: number): number | undefined {
    const glyphId = this.cmapLookup(codePoint);
    if (glyphId === 0) {
      return undefined;
    }
    return this.advanceUnits(glyphId) / this.unitsPerEm;
  }

  /** 字体是否覆盖这个码位。 */
  hasGlyph(codePoint: number): boolean {
    return this.cmapLookup(codePoint) !== 0;
  }

  /**
   * 字形墨迹外接框（em，SVG 方向）。只有带 `glyf` + `loca` 表（TrueType 轮廓）的字体
   * 可查；CFF/OTF 返回 `undefined`，调用方需自备近似值。
   */
  boundsEm(codePoint: number): GlyphBounds | undefined {
    if (this.loca === null || this.glyf === null) {
      return undefined;
    }
    const glyphId = this.cmapLookup(codePoint);
    if (glyphId === 0 || glyphId + 1 >= this.loca.length) {
      return undefined;
    }
    const start = this.loca[glyphId]!;
    const end = this.loca[glyphId + 1]!;
    if (end - start < 10) {
      return undefined; // 空字形（空格等）没有 header。
    }
    const at = this.glyf.offset + start;
    const unitsPerEm = this.unitsPerEm;
    // 字体坐标 y 向上，SVG y 向下：交换 yMin/yMax 并取反。
    return {
      xMin: readInt16(this.data, at + 2) / unitsPerEm,
      yMin: -readInt16(this.data, at + 8) / unitsPerEm,
      xMax: readInt16(this.data, at + 6) / unitsPerEm,
      yMax: -readInt16(this.data, at + 4) / unitsPerEm,
    };
  }

  /**
   * 一串文本的宽度（em）。缺字按 1em 近似 —— 真正的排版会先做字体选择（见
   * `typeset`），这个函数是给「字体一定覆盖」的场景与粗算用的。
   */
  widthEm(text: string): number {
    let width = 0;
    for (const ch of text) {
      width += this.advanceEm(ch.codePointAt(0)!) ?? 1;
    }
    return width;
  }

  /** 一串文本的宽度（px）。 */
  width(text: string, size: number): number {
    return this.widthEm(text) * size;
  }
}

function buildInit(bytes: Uint8Array, path: string, index: number): FontMetricsInit {
  const fontOffset = fontStart(bytes, index);
  const tables = readTableDirectory(bytes, fontOffset);
  const headRecord = tables.get('head');
  const hheaRecord = tables.get('hhea');
  const maxpRecord = tables.get('maxp');
  const hmtxRecord = tables.get('hmtx');
  const cmapRecord = tables.get('cmap');
  if (!headRecord || !hheaRecord || !maxpRecord || !hmtxRecord || !cmapRecord) {
    throw new Error(
      'FontMetrics: 不是可解析的 SFNT 字体（缺 head/hhea/maxp/hmtx/cmap 中的表）；' +
        'WOFF/WOFF2 需要先解包成 ttf/otf',
    );
  }

  const unitsPerEm = readUint16(bytes, headRecord.offset + 18);
  if (unitsPerEm === 0) {
    throw new Error('FontMetrics: head.unitsPerEm 为 0，字体损坏');
  }
  const head: HeadTable = {
    unitsPerEm,
    indexToLocFormat: readInt16(bytes, headRecord.offset + 50),
  };
  const hhea: HheaTable = {
    ascent: readInt16(bytes, hheaRecord.offset + 4),
    descent: readInt16(bytes, hheaRecord.offset + 6),
    numberOfHMetrics: readUint16(bytes, hheaRecord.offset + 34),
  };

  // hmtx：前 numberOfHMetrics 个字形各存 (advanceWidth, lsb)，其余字形复用最后一个 advance。
  const hmtxBase = hmtxRecord.offset;
  const numGlyphs = readUint16(bytes, maxpRecord.offset + 4);
  const lastAdvance =
    hhea.numberOfHMetrics > 0 ? readUint16(bytes, hmtxBase + (hhea.numberOfHMetrics - 1) * 4) : 0;
  const advanceUnits = (glyphId: number): number => {
    if (glyphId >= numGlyphs) {
      return lastAdvance;
    }
    return glyphId < hhea.numberOfHMetrics ? readUint16(bytes, hmtxBase + glyphId * 4) : lastAdvance;
  };

  // loca（可选）：indexToLocFormat 0 = uint16 值 ×2，1 = uint32。
  const locaRecord = tables.get('loca');
  const glyfRecord = tables.get('glyf') ?? null;
  let loca: Uint32Array | null = null;
  if (locaRecord && glyfRecord) {
    loca = new Uint32Array(numGlyphs + 1);
    for (let i = 0; i <= numGlyphs; i += 1) {
      loca[i] =
        head.indexToLocFormat === 0
          ? readUint16(bytes, locaRecord.offset + i * 2) * 2
          : readUint32(bytes, locaRecord.offset + i * 4);
    }
  }

  return {
    data: bytes,
    path,
    index,
    head,
    hhea,
    family: readFamilyName(bytes, tables.get('name') ?? { offset: 0, length: 0 }),
    cmapLookup: makeCmapLookup(bytes, cmapRecord),
    advanceUnits,
    loca,
    glyf: glyfRecord,
  };
}

const fontMetricsCache = new Map<string, FontMetrics>();
