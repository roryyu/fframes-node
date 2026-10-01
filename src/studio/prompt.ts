/**
 * prompt.ts — what the model is told, and nothing else (`page.md` §5.4).
 *
 * No network here, no config: `SYSTEM_PROMPT` is a constant that `llm.generateVideoSource` sends as
 * the `system` message, `buildUserPrompt` turns the user's sentence plus the ticked assets into the
 * `user` message, `VISION_INSTRUCTION` is the default of `llm.understandImage`, and `EXAMPLES` is
 * what `/api/config` hands the ① panel for its chips.
 *
 * `SYSTEM_PROMPT` covers all ten elements the contract lists (§5.4 1–10) and the wording keeps every
 * gate-visible marker literal, because the gate greps this file rather than trusting the model:
 * the `Video` contract, the import list, `animate`/`timeline`/`Easing`, the `svgr` rules, the image
 * asset rule *including the null guard*, the erasable-syntax constraints, the font path, the
 * determinism rule, the 10 second ceiling and the single ```ts fence.
 *
 * The golden example is `examples/hello-world/video.ts` **byte for byte**: it is the one example
 * known to load, render and pass `inspect`, so it is the only authority on style. `test/studio/
 * prompt.test.ts` re-reads that file and asserts equality, which is what keeps "verbatim" honest.
 */

import type { AssetRef, ExampleChip } from './types.ts';

/** The one import specifier a generated file has to use (see §5.5, decision D4). */
export const FFRAMES_SPECIFIER = '../../../src/index.ts';

/** The font every example uses; `resvg` only registers the files `fonts()` lists (§7 of §5.4). */
export const DEFAULT_FONT_FILE = '/System/Library/Fonts/Helvetica.ttc';

/** `examples/hello-world/video.ts`, verbatim — the few-shot golden example. */
export const HELLO_WORLD_EXAMPLE: string = `/**
 * \`hello-world\` — the two scene example, ported from the Rust original.
 *
 * Line by line from \`.source/fframes/examples/hello-world/src/hello_world_multiscene.rs\`:
 * 30 fps, 1920x1080, \`Duration::Auto\`, \`SceneOne\` and \`SceneTwo\` of 15 s each, the same six stop
 * background animation, the same two scenes with the same markup, and the same frame index / second
 * text in the corner.
 *
 * Two deliberate changes, both forced by the port rather than chosen:
 *
 * - \`font-family\` is \`Helvetica\` and \`fonts()\` returns \`/System/Library/Fonts/Helvetica.ttc\`. The
 *   Rust example asks for \`DM Sans\` and \`JetBrains Mono\`, which live in the example's own media
 *   folder; shipping a 2.3 MB font is not something an example should do, and the resvg backend
 *   registers exactly the files \`fonts()\` lists.
 * - \`Easing::Linear(0.2)\` in \`SceneTwo\` is a linear tween with a **duration**; the port spells that
 *   as an explicit \`end\` on the keyframe, which is what \`KeyFramesAnimation::new\` computes from it.
 *
 * \`\`\`sh
 * # from the fframes-node directory
 * node src/cli/main.ts examples/hello-world/video.ts render -o hello.mp4
 * node src/cli/main.ts examples/hello-world/video.ts timeline
 * node src/cli/main.ts examples/hello-world/video.ts inspect --every-frame
 * \`\`\`
 */

import { svgr, Svgr, seconds, timeline, Easing, AudioMap, Color, auto } from '../../src/index.ts';
import type { Scene, Video, FFramesContext, Frame } from '../../src/index.ts';

/** \`SceneOne\` — 15 s, static text and two green rects, one of them rotated. */
class SceneOne implements Scene {
  readonly name = 'SceneOne';

  duration() {
    return seconds(15);
  }

  renderFrame(_frame: Frame, _ctx: FFramesContext): Svgr {
    return svgr\`<text font-family="Helvetica" x="100" y="300" font-size="150">hello scene 1</text>
      <g id="g1" transform="scale(1)">
        <rect id="rect1" x="0" y="0" width="120" height="120" fill="green" />
      </g>
      <g id="g2" transform="rotate(45)" transform-origin="top left">
        <rect id="rect1" x="0" y="0" width="120" height="120" fill="green" />
      </g>\`;
  }
}

/** \`SceneTwo\` — 15 s, the text drifts from y=300 to y=320 over 0.2 s. */
class SceneTwo implements Scene {
  readonly name = 'SceneTwo';

  duration() {
    return seconds(15);
  }

  renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
    return svgr\`<text
        x="100"
        font-size="150"
        font-family="Helvetica"
        y="\${frame.animate(
          timeline<number>(
            { start: 0, end: 0.2, from: 300, to: 320, easing: Easing.linear },
          ),
        )}"
      >Hello Scene 2</text>\`;
  }
}

/**
 * The background: six 5 second stops.
 *
 * \`animation::Easing::Linear(5.)\` in the Rust source is a linear tween of 5 seconds, so every
 * keyframe carries \`end: start + 5\`. The colors are copied from the Rust source verbatim.
 */
const BACKGROUND = timeline<Color>(
  { start: 0, end: 5, from: Color.fromHex('#fff'), to: Color.fromHex('#f8fafc'), easing: Easing.linear },
  { start: 5, end: 10, from: Color.fromHex('#f8fafc'), to: Color.fromHex('#fff7ed'), easing: Easing.linear },
  { start: 10, end: 15, from: Color.fromHex('#fff7ed'), to: Color.fromHex('#fef2f2'), easing: Easing.linear },
  { start: 15, end: 20, from: Color.fromHex('#fef2f2'), to: Color.fromHex('#f7fee7'), easing: Easing.linear },
  { start: 20, end: 25, from: Color.fromHex('#f7fee7'), to: Color.fromHex('#ecfdf5'), easing: Easing.linear },
  { start: 25, end: 30, from: Color.fromHex('#ecfdf5'), to: Color.fromHex('#faf5ff'), easing: Easing.linear },
);

class HelloWorld implements Video {
  readonly fps = 30;
  readonly width = 1920;
  readonly height = 1080;

  /** \`Duration::Auto\` is a value in Rust too — the unit variant, not a constructor call. */
  duration() {
    return auto;
  }

  audio(): AudioMap {
    return AudioMap.none();
  }

  defineScenes(): readonly Scene[] {
    return [new SceneOne(), new SceneTwo()];
  }

  /** The only font the renderer loads; \`loadSystemFonts\` is off (see PORTING.md). */
  fonts(): string[] {
    return ['/System/Library/Fonts/Helvetica.ttc'];
  }

  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    return svgr\`<svg xmlns="http://www.w3.org/2000/svg" width="\${this.width}" height="\${this.height}">
      <rect width="\${this.width}" height="\${this.height}" x="0" y="0" fill="\${frame.animate(BACKGROUND)}" />
      \${ctx.renderScenes(frame)}
      <text font-weight="500" font-family="Helvetica" x="100" y="440" font-size="74" fill="#4b5563">This frame index: \${frame.index}, second: \${frame.seconds().toFixed(2)}</text>
    </svg>\`;
  }
}

export default new HelloWorld();
`;

/**
 * The minimal fragment that shows how to place a project asset (§5.4 6, §5.4 9's second example).
 *
 * It is a fragment, not a file: the three guard styles are all shown because a model that picks one
 * at random still has to null-check, which is the part that decides whether the frame rasterizes.
 */
export const ASSET_REFERENCE_SNIPPET: string = `import { svgr, Svgr } from '${FFRAMES_SPECIFIER}';
import type { FFramesContext, Frame } from '${FFRAMES_SPECIFIER}';

renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
  // Three ways to null-check; pick one. ctx.getImage() is null when media/<name> does not exist.
  const href = ctx.getImage('logo.png') ?? '';            // 1. null-coalesce to an empty href
  const exists = ctx.hasMedia('logo.png');                // 2. ask first
  const picked = ctx.getImage('logo.png');                // 3. check the value
  const image = exists && picked !== null
    ? svgr\`<image href="\${picked}" x="\${(1920 - 400) / 2}" y="120" width="400" height="400" preserveAspectRatio="xMidYMid meet" />\`
    : svgr\`<text font-family="Helvetica" x="960" y="960" font-size="48" fill="#94a3b8" text-anchor="middle">logo.png is missing</text>\`;
  return svgr\`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <rect width="1920" height="1080" x="0" y="0" fill="#0b1220" />
    \${href === '' ? '' : image}
    <text font-family="Helvetica" x="960" y="720" font-size="96" fill="#ffffff" text-anchor="middle">\${frame.index}</text>
  </svg>\`;
}`;

const ROLE = `你是 fframes-node 的视频作者：把用户的一句中文自然语言变成一个能被 loadVideo 直接加载的 video.ts。
fframes-node 用「逐帧 SVG 树」渲染：每一帧都完整画出，不做增量更新，所以画面状态必须由 frame 的时间推导出来。`;

const VIDEO_CONTRACT = `## 1. Video 契约（逐条实现，签名照抄）

生成的类写 \`implements Video\`，成员固定为：

  readonly fps: number;                                  // 帧率，通常 30
  readonly width: number;                                // 画布宽，通常 1920
  readonly height: number;                               // 画布高，通常 1080
  duration(): Duration;                                  // 时长；优先 seconds(n)
  audio(): AudioMap;                                     // 音轨；无音频写 AudioMap.none()
  fonts(): string[];                                     // 字体文件绝对路径，见第 6 节
  defineScenes(): readonly Scene[] | null;               // 必需方法；没有场景时 return null
  renderFrame(frame: Frame, ctx: FFramesContext): Svgr;  // 画这一帧
  readonly defaultOutput?: string;                       // 可选，render 时的默认文件名

文件末尾 \`export default new X();\` 导出实例（或导出返回 Video 的工厂函数）。
\`Video\` 与 \`Scene\` 是 interface，用 \`implements\`，不要把成员写成对象字面量以外的形态。`;

const IMPORTS = `## 2. 可用导入（唯一入口）

  值：svgr, seconds, frames, auto, fromAudio, timeline, Easing, Color, Transform, AudioMap, audioTrack, Svgr, Scenes
  类型：Video, Scene, Frame, FFramesContext, Duration

全部从 '${FFRAMES_SPECIFIER}' 导入，ESM 相对导入必须带 \`.ts\` 扩展名。
不要 import 任何其它模块（无 node:fs / 无 fetch / 无第三方包）。

**Svgr 永远当值导入，绝不放进 \`import type\`**：它带 \`.empty()\` / \`.group()\` 静态方法，
一旦调用 \`Svgr.empty()\` 就必须是值导入；而 \`import type\` 会被 Node 类型擦除，运行时会
\`Svgr is not defined\`。即便只用作返回类型标注，值导入也一样可用，所以统一写
\`import { svgr, Svgr } from '…'\`，不要把 Svgr 挪到 type 那一行。`;

const ANIMATION = `## 3. 动画

  frame.animate(timeline<T>({ start, end?, from, to, easing }, ...))

  - T 只能是可动画类型：number、Color、Transform
  - easing：Easing.linear | Easing.easeIn | Easing.easeOut | Easing.easeInOut |
    Easing.cubicBezier(x1, y1, x2, y2) | Easing.spring({ mass, stiffness, damping })
  - 有 duration 的 linear 补一个 end；spring 用 easing: Easing.spring({ … })
  - frame.animateLoop(timeline<T>(...)) 做循环动画
  - 关键帧共用一个 timeline 常量，在 renderFrame 里 frame.animate(常量) 取当前值
  - frame.index（帧号）、frame.seconds()（秒）、frame.fps 可直接用`;

const SVGR_RULES = `## 4. svgr 规则

  - 用 tagged template：svgr\`<svg …>…</svg>\`，标签与属性照常写
  - 插值 \${} 只能是字符串 / 数字 / Color / Transform / Svgr，不要自己拼字符串
  - 根节点自己写全：
    svgr\`<svg xmlns="http://www.w3.org/2000/svg" width="\${this.width}" height="\${this.height}">…</svg>\`
  - 有场景时用 \${ctx.renderScenes(frame)} 把场景内容拼进来
  - 这一帧确实没有内容时返回 Svgr.empty()，不要返回空字符串或空标签
  - 旋转/缩放用 <g transform="rotate(45)" transform-origin="top left"> 这类 SVG 属性`;

const ASSET_RULES = `## 5. 图片素材引用（素材已经在项目的 media/ 里）

引用一个素材：\`<image href="\${ctx.getImage('logo.png')}" x="…" y="…" width="…" height="…" preserveAspectRatio="xMidYMid meet" />\`

  - ctx.getImage(name) 读 media/<name>，返回 base64 data URI；**文件不存在时返回 null**
  - 必须判空兜底，任选一种写法：
      href="\${ctx.getImage('logo.png') ?? ''}"
      if (ctx.hasMedia('logo.png')) { … }
      const href = ctx.getImage('logo.png'); href === null ? '' : svgr\`<image href="\${href}" … />\`
  - null 时不要渲染破图：跳过该元素，或用 Svgr.empty() 兜底，不要抛错
  - 只支持 png / gif / jpg / jpeg
  - 不得引用 media/ 之外的路径，不得拼绝对路径，不得自己造 data: URI
  - 素材是渲染时按文件读取的，增删素材不需要改代码
  - 用户勾选的素材见 user 消息里的清单，按需选用，不要臆造清单里没有的文件名`;

const HARD_CONSTRAINTS = `## 6. 硬约束（违反会渲染失败，不是风格问题）

  - 只用可擦除语法：禁 enum、禁 namespace、禁构造函数参数属性（constructor(private x) y)）、禁装饰器；
    需要枚举时用「联合类型 + 字面量 kind 字段」
  - ESM 相对导入必须带 .ts 扩展名
  - fonts() 必须返回**真实存在的字体文件绝对路径**，示例统一写 ['${DEFAULT_FONT_FILE}']，
    SVG 里对应写 font-family="Helvetica"（resvg 不开 loadSystemFonts，不读系统字体）
  - renderFrame 内禁止网络请求、禁止文件 IO、禁止随机数（Math.random() / Date.now()）：
    渲染必须确定性，逐帧可复现
  - ctx.getImage 是唯一合法的媒体读取口
  - 缺媒体或缺字体时不要抛错：用 Svgr.empty() 兜底或跳过该元素
  - 不要读环境变量、不要用 process、不要 spawn 子进程`;

const DURATION_RULE = `## 7. 时长纪律

  除非用户明确要求，duration() ≤ 10 秒（预览和渲染成本）；优先用 seconds(n)，例如 seconds(5)。
  用户明确给了时长就照做，但超过 30 秒要先说明。`;

const EXAMPLES_SECTION = `## 8. 黄金样例（examples/hello-world/video.ts 全文）

这是一个真实能加载、能渲染、能通过 inspect 的 video.ts，照它的写法来：

\`\`\`ts
${HELLO_WORLD_EXAMPLE}
\`\`\`

注意：样例在 examples/hello-world/ 下，所以导入写的是 '../../src/index.ts'；
Studio 生成的 video.ts 落在 .studio/projects/<id>/ 下，请直接写 '${FFRAMES_SPECIFIER}'
（写成别的深度 Studio 也会自动归一化，但请一次写对）。

素材引用的最小片段（把 renderFrame 换成像这样，media/<name> 就在项目目录里）：

\`\`\`ts
${ASSET_REFERENCE_SNIPPET}
\`\`\``;

const OUTPUT_RULES = `## 9. 输出规则

  - **只输出一个 \`\`\`ts 代码围栏**，围栏里是完整的 video.ts
  - 不要任何解释文字、不要 markdown 标题、不要第二个文件、不要 \`\`\`html 或 \`\`\`json 围栏
  - 代码要能被 loadVideo 直接加载：default export 一个 Video（或返回 Video 的工厂）
  - 自检：import 路径、defineScenes() 存在、fonts() 路径真实、每帧无 IO/随机数`;

const SHAPE = `## 0. 用户会怎么描述

用户给的是一句中文，例如"做一个 5 秒的开场，深蓝渐变背景，中间白字淡入标题 'Hello fframes'，底部有一个青色进度条从左滑到右"。
从中提取 fps / 宽高 / 时长 / 场景 / 配色 / 文案 / 动画节奏，其余按黄金样例的默认值补齐（30fps、1920x1080）。`;

/** The system prompt, as one string: the ten elements of §5.4, in order. */
export const SYSTEM_PROMPT: string = [
  SHAPE,
  ROLE,
  VIDEO_CONTRACT,
  IMPORTS,
  ANIMATION,
  SVGR_RULES,
  ASSET_RULES,
  HARD_CONSTRAINTS,
  DURATION_RULE,
  EXAMPLES_SECTION,
  OUTPUT_RULES,
].join('\n\n');

/**
 * The user message: the sentence, plus the assets the user ticked in ① (§5.4).
 *
 * With no references the prompt is the sentence alone — an empty "available assets" section would
 * only invite the model to invent file names. With references it appends the exact format the
 * contract shows, including the instruction not to invent names that are not listed.
 */
export function buildUserPrompt(nl: string, references?: readonly AssetRef[]): string {
  const prompt = nl.trim();
  if (references === undefined || references.length === 0) {
    return prompt;
  }
  const lines: string[] = [];
  for (const ref of references) {
    const size = ref.width !== undefined && ref.height !== undefined ? `（${ref.width}x${ref.height}）` : '';
    const description = ref.description.trim() === '' ? '（无描述）' : ref.description.trim();
    lines.push(`- ${ref.name}${size}：${description}`);
  }
  return [
    prompt,
    '',
    `可用素材（已在 media/ 中，用 ctx.getImage('<name>') 引用）：`,
    ...lines,
    '',
    '按需选用，不要臆造不存在的素材名；引用时必须判空兜底（ctx.getImage(name) ?? \'\'）。',
  ].join('\n');
}

/** The default instruction of `llm.understandImage` (§5.3 ②): one description, 120 characters. */
export const VISION_INSTRUCTION: string =
  '描述这张图的主体、配色、风格，以及可用作文案或图形的要点，≤120字；' +
  '最后一句说明它适合在视频里怎么用（例如"作为居中 logo 角标"、"作为全屏背景"）。';

/** The ① panel's chips (`page.md` §7.1): each one is a prompt a first time user can send as is. */
export const EXAMPLES: readonly ExampleChip[] = [
  {
    name: 'hello-world',
    prompt:
      "做一个 5 秒的开场，深蓝渐变背景，中间白字淡入标题 'Hello fframes'，底部有一个青色进度条从左滑到右",
  },
  {
    name: '进度条',
    prompt:
      '3 秒 loading 动画：深色背景，中间一个白色圆环匀速旋转，下方小字 "加载中…" 淡入再淡出，进度环用青色描边',
  },
  {
    name: '字幕淡入',
    prompt:
      '6 秒标题卡：纯黑背景，居中大标题 "fframes-node" 从下方 40 像素淡入并轻微上移，副标题小一号灰字延迟 0.3 秒淡入',
  },
  {
    name: '用素材做片头',
    prompt:
      '4 秒片头：深蓝渐变背景，把 logo.png 放在中间淡入，下方白字标题 "Studio" 淡入，最后 logo 轻微缩小；logo 缺失时跳过不报错',
  },
];
