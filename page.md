# fframes-node Studio — Web 页面详细设计（page.md）

> 本文件是 **fframes-node Studio**（自然语言 → `video.ts` → 渲染 → 预览 的 Web 页面）的
> **单一事实源设计契约**。后续「指挥官模式」开发的生成切片、门禁脚本、交叉评审都引用本文件路径。
> 本轮只交付设计；构建在用户确认后按 §10 切片计划派发。

---

## 0. 背景与目标

`fframes-node` 目前只有 CLI（`node src/cli/main.ts <video.ts> render|frame|svg|timeline|inspect|audio`）。
它已经具备完整的**程序化库 API**（见 §5.1），Studio 只是把这条链路包一层本地 Web 页面：

**一句话目标**：用户在浏览器里输入一句自然语言（例："做一个 5 秒的开场，深蓝渐变背景，中间白字淡入标题 'Hello fframes'，底部有一个青色进度条从左滑到右"），
可选地**上传图片**（供大模型理解内容）或**让大模型生成图片素材**，页面调用 LLM 生成一个符合 `Video` 契约、并能引用这些图片素材的 `video.ts`，即时校验、单帧擦洗预览，满意后一键渲染整片 mp4 并在页面内播放。

**单一 provider 三模型**：全部大模型能力走**同一家 OpenAI 兼容 provider**——一个 `LLM_BASE_URL` + 一个 `LLM_API_KEY`，
下挂三个**分开配置**的模型：`LLM_MODEL`（文本→`video.ts` 代码）、`LLM_VISION_MODEL`（图片理解）、`LLM_IMAGE_MODEL`（文本→图片素材）。
三者按能力独立选用；某个模型未配置时，对应能力在 UI 上禁用并给出提示，不影响其余能力。

**六条主链路**（对应用户诉求）：

1. 自然语言 → `video.ts`（`Video` 类）自动生成（可携带已上传/已生成素材的引用与理解结果）
2. **图片理解**：用户上传图片 → `LLM_VISION_MODEL` 产出内容描述 → 作为素材语义注入生成提示（让 `video.ts` 知道「这张图是什么、怎么用」）
3. **图片生成**：用户描述一个素材 → `LLM_IMAGE_MODEL` 产出 PNG → 存入项目 `media/` → 供 `video.ts` 用 `ctx.getImage('<name>.png')` 引用
4. 生成结果校验（能否 import、能否解析时长/场景、字体媒体是否缺失、首帧能否栅格化）
5. 视频生成（整片 `renderVideo` 出 mp4，带进度）
6. 预览（秒级单帧 PNG 擦洗 + 整片 `<video>` 播放）

**素材落地机制（已核对源码）**：图片一律存进项目 `media/` 目录；`fframes-node` 渲染上下文 `ctx.getImage(file)`
会把 `media/<file>` 读成 base64 `data:` URI（支持 png/gif/jpeg，见 `src/render/resvg-backend.ts` 的 `getImage`），
`video.ts` 在 `renderFrame` 里以 `<image href="${ctx.getImage('logo.png')}" …/>` 引用。上传与生成的图片都走这条既有链路，**不新增任何渲染逻辑**。

**非目标（明确不做，见 §11）**：多用户/鉴权、公网部署、云渲染、`video.ts` 的沙箱隔离、可视化时间轴拖拽编辑器、账号/持久化数据库、多 provider 混用（v1 只支持一家）。

---

## 1. 用户体验流程

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ①  自然语言输入框  [ 生成 ]   示例 chips: hello-world / 进度条 / 字幕淡入   │
│      参考素材(勾选后注入生成): [✓]logo.png [✓]bg.png                        │
├───────────────────────────────┬────────────────────────────────────────────┤
│  ②  video.ts 代码编辑器        │  ③  预览面板                                 │
│      (可手改, [校验并预览])     │      ┌──────────────────────────┐            │
│                                │      │  单帧 <img> (擦洗)         │            │
│                                │      └──────────────────────────┘            │
│                                │      ◄──●──────────────►  帧擦洗条 + spec 输入 │
│                                │      时间轴: 1920x1080 @30fps · 5.00s · 150帧 │
│                                │      场景: #0 Intro 0..150 (0.00s..5.00s)     │
│                                │      校验: ✓ 无缺失字体/媒体 · ✓ 首帧非空      │
├───────────────────────────────┴────────────────────────────────────────────┤
│  ⑥  素材库 (media/)                                                          │
│      [⬆ 上传图片→理解]  拖拽/选择 png·jpg·gif → 缩略图 + VISION 描述          │
│      [✨ 生成素材] 描述[______] 尺寸[1024x1024▾] [生成] → IMAGE_MODEL 出图     │
│      网格: 🖼logo.png(1024²,"蓝色圆形标志…") 🖼bg.png(… )  [删] [用作参考]     │
├──────────────────────────────────────────────────────────────────────────────┤
│  ④  渲染整片: [ ]草稿(半分辨率/ultrafast)  范围[____]  [ 渲染 ]              │
│      进度: ██████████░░░░ 90/150 帧   (SSE 实时)                             │
│      完成: out.mp4  1920x1080  5.0s  用时 4.1s   ▶ <video controls>          │
├──────────────────────────────────────────────────────────────────────────────┤
│  ⑤  状态/日志控制台 (生成、理解、出图、校验、渲染错误逐条打印)                │
└──────────────────────────────────────────────────────────────────────────────┘
```

> 图片理解与图片生成是**独立于「生成 video.ts」的可选步骤**：用户可先攒素材（上传/生成），勾选若干作为「参考素材」，再点 ① 的 `[生成]`；
> 生成时把被勾选素材的**文件名 + VISION 描述**注入提示，LLM 便会在 `renderFrame` 里用 `ctx.getImage('<name>')` 引用它们。
> `LLM_VISION_MODEL` / `LLM_IMAGE_MODEL` 未配置时，⑥ 区对应按钮禁用并提示「未配置视觉/图片模型」。


**状态机**（前端单一 `state`，见 §7.2）：

```
idle ──生成──▶ generating ──成功──▶ validating ──通过──▶ ready
  ▲                                  │失败                │
  │                                  ▼                    │渲染
  └──────────── error ◀──────────────┘                    ▼
                                                      rendering ──▶ rendered(播放)
```

任何阶段的失败都落到 `error`，把结构化信息（LLM 报错 / import 报错 / 渲染报错）打印到 ⑤ 控制台并在对应面板高亮，用户可改 prompt 或改代码后重试。

---

## 2. 架构总览

```
浏览器 (vanilla HTML/CSS/JS, 无构建)
   │  fetch / SSE / <img src> / <video src>
   ▼
node:http 服务器 (src/studio/server.ts, TS 直跑, 无框架无新依赖)
   ├── 静态资源         src/studio/public/{index.html,app.js,styles.css}
   ├── /api/generate    → llm.generateVideoSource(LLM_MODEL, 含参考素材描述) → projects 落盘 → pipeline 校验
   ├── /api/upload      → projects.saveAsset(media/) → llm.understandImage(LLM_VISION_MODEL) → assets.json
   ├── /api/asset/gen   → llm.generateImage(LLM_IMAGE_MODEL) → projects.saveAsset(media/) → assets.json
   ├── /api/assets      → projects.listAssets()  (素材网格数据)
   ├── /api/validate    → projects 覆写 → pipeline 校验 (手改代码后用)
   ├── /api/timeline    → pipeline.timeline()   ┐
   ├── /api/inspect     → pipeline.inspect()    │  全部复用 fframes-node 库 API
   ├── /api/frame(PNG)  → pipeline.framePng()   │  (§5.1)，不重写任何渲染逻辑
   ├── /api/svg         → pipeline.frameSvg()   │
   ├── /api/render      → jobs.ts 队列 → pipeline.render() (SSE 进度)
   └── /media/*         → 静态伺服 .studio/projects/<id>/{out/*.mp4|*.wav, media/*.png|jpg|gif}
                              │
        ┌─────────────────────┴───────────────────────┐
        ▼                                               ▼
  单一 OpenAI 兼容 provider                       projects 存储
  (LLM_BASE_URL + LLM_API_KEY)                    .studio/projects/<id>/
   ├ /chat/completions  ← LLM_MODEL      (代码)      ├ video.ts
   ├ /chat/completions  ← LLM_VISION_MODEL(多模态)    ├ media/  (上传+生成的图片素材)
   └ /images/generations← LLM_IMAGE_MODEL(出图)       ├ assets.json (素材名→描述/尺寸/来源)
                                                     └ out/    (渲染产物 mp4/wav)
```

**分层职责**：

| 层 | 文件 | 职责 | 不负责 |
| --- | --- | --- | --- |
| HTTP/路由 | `server.ts` | 请求解析、路由、静态伺服、SSE、错误→HTTP 状态 | 业务逻辑 |
| 编排 | `pipeline.ts` | 把「已加载的 `Video`」跑成 timeline/inspect/frame/render 结果 | 直接触碰 HTTP、LLM |
| 项目存储 | `projects.ts` | 建目录、写/读 `video.ts`、import 归一化、动态加载(缓存击穿)、**素材(media/)读写与 assets.json 清单**、列表 | 渲染 |
| LLM 客户端 | `llm.ts` | 单一 provider 三能力：`generateVideoSource`(代码)/`understandImage`(视觉)/`generateImage`(出图)；代码围栏抽取、mock 模式 | 提示词内容(在 prompt.ts) |
| 提示词 | `prompt.ts` | 系统提示全文（契约 + API 面 + 黄金样例 + 素材引用规则 + 输出规则）、视觉指令、参考素材注入 | 网络 |
| 任务 | `jobs.ts` | 单槽渲染队列、jobId、SSE 广播 | 渲染实现 |
| 配置 | `config.ts` | 读 `process.env`，给默认值，导出只读配置对象（含三模型） | — |
| 类型 | `types.ts` | 跨模块共享接口（可擦除语法） | — |

---

## 3. 继承的技术红线（不可违反）

Studio 是 `fframes-node` 的一部分，**必须遵守该项目已固化的约束**（见 `README.md` / `PORTING.md` / 移植契约）：

1. **Node ≥ 24，TypeScript 靠原生 type-stripping 直跑，无构建步骤**。只用**可擦除语法**：
   禁 `enum`、禁 `namespace`、禁构造函数参数属性（`constructor(private x)`）、禁装饰器。
   联合类型 + 字面量 `kind` 字段代替 enum。
2. **ESM**，相对导入**必须带 `.ts` 扩展名**：`import { x } from './pipeline.ts'`。
3. **零新增运行时依赖**。唯一运行时依赖仍是 `@resvg/resvg-js`。HTTP 用 `node:http`，
   LLM 调用用 Node 24 全局 `fetch`，子进程用 `node:child_process`，路径/文件系统用 `node:*`。
   **禁止改 `package.json` 的 `dependencies`**（只允许新增 `scripts.studio`）。
4. **ffmpeg / ffprobe 在 PATH**（渲染与音频解码已由现有库依赖）。
5. `tsc --noEmit`（strict）零错误——门禁会跑（§9）。
6. **不修改 `src/index.ts` 对 `cli/main.ts` 的「刻意不 re-export」**（模块图死锁约束，见 index.ts 末尾 normative 注释）。
   Studio 需要 `loadVideo`/`mediaDirFor` 时，**按 sanctioned 方式从 `'../cli/main.ts'` 直接 import**（README「Using it as a library」已许可此路径）。

---

## 4. 目录与文件清单（契约级，防自由发挥）

```
fframes-node/
  src/studio/                       # ★ 新增：Studio 全部后端
    server.ts                       # node:http 入口 + 路由 + 静态伺服 + SSE；顶部 #!/usr/bin/env node
    config.ts                       # env → 只读配置 (LLM_BASE_URL/API_KEY + 三模型 + STUDIO_* + mock)
    types.ts                        # 共享接口: GenerateRequest/AssetInfo/ValidationResult/JobEvent/... (可擦除)
    llm.ts                          # 单一 provider 三能力: 代码生成/图片理解(视觉)/图片生成 + 围栏抽取 + mock
    prompt.ts                       # 系统提示: Video 契约 + API 面 + 黄金样例 + 素材引用规则 + 视觉指令 + 输出规则
    projects.ts                     # 项目存储 + import 归一化 + 动态加载(缓存击穿) + 素材(media/)读写 + assets.json + 列表
    pipeline.ts                     # 编排: load→session→timeline/inspect/framePng/frameSvg/render
    jobs.ts                         # 单槽渲染队列 + jobId + SSE 订阅广播
    public/                         # ★ 新增：前端静态资源 (vanilla, 无构建)
      index.html
      app.js
      styles.css
  test/studio/                      # ★ 新增：单测 (node:test)
    prompt.test.ts                  # 提示词含关键契约标记(含 getImage 素材规则)；代码围栏抽取正确
    projects.test.ts                # import 归一化；缓存击穿；素材保存/名称消毒；目录逃逸拒绝
    llm.test.ts                     # mock 模式三能力各返回 fixture；围栏剥离；错误映射
    pipeline.test.ts                # 用 examples/hello-world 跑 timeline/inspect/framePng
    jobs.test.ts                    # 队列入队/串行/事件序列
  .studio/                          # ★ 运行时产物根 (gitignore)：projects/<id>/{video.ts,media/,assets.json,out/}
  .env.example                      # ★ 新增：LLM_BASE_URL/API_KEY/MODEL/VISION_MODEL/IMAGE_MODEL/STUDIO_*
  page.md                           # 本文件
gates/verify-studio.sh              # ★ 新增 (工作区 gates/ 下)：确定性验收门禁 (§9)
scripts/dispatch-studio-gen.sh      # ★ 新增：生成切片派遣 (§10)
scripts/dispatch-studio-reviewers.sh# ★ 新增：并行双评审 (§10)
```

**边界**：只新增上述文件；**不改** `src/core|audio|render|encode|inspect|media|cli/**` 与 `src/index.ts`
（Studio 纯消费库 API）。`package.json` 只允许加一行 `scripts.studio`。`.gitignore` 追加 `.studio/` 与 `.env`。

---

## 5. 后端设计

### 5.1 复用的库 API（已核对签名，禁止重写）

| 用途 | 符号 | 来源 | 签名要点 |
| --- | --- | --- | --- |
| 加载视频模块 | `loadVideo(modulePath, cwd?)` | `../cli/main.ts` | `Promise<Video>`；default export 可为 `Video` 或 (async)工厂；失败抛 `UsageError` |
| 媒体目录 | `mediaDirFor(modulePath, cwd?, override?)` | `../cli/main.ts` | 返回 `MediaDirectory \| null`（`media/` sibling 或 `--media-dir`） |
| 建会话 | `createRenderSession(video, options)` | `index.ts` | `options: PipelineOptions{fps,width,height,scale?,fontFiles?,mediaDir?,sampleRate?,mixerOptions?}` → `RenderSession` |
| 单帧 SVG | `renderFrameSvg(session, globalFrame)` | `index.ts` | → `string` |
| 单帧 PNG | `renderFramePng(session, globalFrame)` | `index.ts` | → `Buffer`（image/png） |
| 整片渲染 | `renderVideo(session, options)` | `index.ts` | `options{range,output,draft?,scale?,crf?,preset?,floatAudio?,onProgress?}` → `Promise<RenderReport>` |
| 时间轴报告 | `timelineReport(session)` | `index.ts` | → `TimelineReport{fps,width,height,durationFrames,durationSeconds,scenes[],audio{sampleRate,tracks[]}}` |
| 体检 | `inspectVideo(session, {range, ...InspectOptions})` | `index.ts` | → `InspectResult{findings[{frame,severity,kind,message,count}],checkedFrames,exitCode}` |
| 响度(可选) | `analyzeAudio(input)` | `index.ts` | 音频面板 LUFS/true-peak，v1 可后置 |
| 帧号/范围解析 | `session.index.resolveFrame(spec)` / `resolveRange(spec)` / `fullRange()` | `RenderSession` | 复用 TimeSpec 语法（`1.2s`/`50%`/`Intro@end`/`a..b`） |

`RenderSession` 关键字段：`video`、`durationInFrames`、`index`、`scenes`、`audioMap`、`audioResolveError`、`context`、`size`。

**图片素材链路（生成代码内使用，Studio 不直接调）**：`FFramesContext.getImage(file)` 从会话的 `mediaDir`
（= 项目 `media/` 目录）读取图片并返回 base64 `data:` URI（`null` 表示文件不存在）；支持的扩展名 `png/gif/jpg/jpeg`
（`IMAGE_EXTENSIONS`）。因此 Studio 只要把上传/生成的图片写进 `.studio/projects/<id>/media/`，
`createRenderSession` 时把 `mediaDirFor(videoPath)` 传进 `PipelineOptions.mediaDir`，生成的 `video.ts` 即可用
`<image href="${ctx.getImage('logo.png')}" …/>` 引用——**无需任何新渲染代码**。

### 5.2 `config.ts` — 配置

从 `process.env` 读取（用 `node --env-file=.env` 注入，**不引 dotenv**）。**单一 provider**：一个 base_url + 一个 api_key，
下挂三个**分开配置**的模型。导出一个冻结的只读对象：

```ts
export interface StudioConfig {
  readonly host: string;            // STUDIO_HOST, 默认 '127.0.0.1'（安全红线：仅本地回环）
  readonly port: number;            // STUDIO_PORT, 默认 8787
  readonly llmBaseUrl: string;      // LLM_BASE_URL, OpenAI 兼容根 (…/v1)，末尾斜杠归一；三能力共用
  readonly llmApiKey: string;       // LLM_API_KEY，三能力共用（缺失时非 mock 模式启动即报错，不静默）
  readonly model: string;           // LLM_MODEL        文本→video.ts 代码（必填）
  readonly visionModel: string | null; // LLM_VISION_MODEL 图片理解；null=未配置→该能力禁用
  readonly imageModel: string | null;  // LLM_IMAGE_MODEL  图片生成；null=未配置→该能力禁用
  readonly imageSize: string;       // LLM_IMAGE_SIZE, 默认 '1024x1024'（出图默认尺寸，前端可覆盖）
  readonly llmTimeoutMs: number;    // LLM_TIMEOUT_MS, 默认 120000（出图/视觉可各自更久，见下）
  readonly imageTimeoutMs: number;  // LLM_IMAGE_TIMEOUT_MS, 默认 180000（出图通常更慢）
  readonly projectsRoot: string;    // 默认 <repo>/.studio/projects（绝对路径）
  readonly repoRoot: string;        // fframes-node 绝对根（import 归一化用）
  readonly mockDir: string | null;  // LLM_MOCK_DIR：非空则 llm.ts 走 fixture，不发网络（门禁用）
  readonly maxProjects: number;     // STUDIO_MAX_PROJECTS, 默认 50（超限拒绝新建，提示清理）
  readonly maxUploadBytes: number;  // STUDIO_MAX_UPLOAD_BYTES, 默认 8MB（上传图片体积上限）
}
```

**能力可用性**：`model` 必填（核心链路）；`visionModel`/`imageModel` 可为空——为空时对应端点返回
`{ error:'vision/image model not configured', code:'MODEL_UNSET' }`（HTTP 501），`/api/config` 回传
`{ vision:boolean, image:boolean }` 供前端禁用按钮。**三模型共用同一 base_url 与 api_key**（用户明确只要一家 provider）。

`.env.example`：
```
# —— 单一 provider（OpenAI 兼容）——
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
# —— 三个模型分开配置 ——
LLM_MODEL=gpt-4o-mini                 # 文本 → video.ts 代码（必填）
LLM_VISION_MODEL=gpt-4o-mini          # 图片理解（多模态 chat）；留空则禁用上传理解
LLM_IMAGE_MODEL=gpt-image-1           # 文本 → 图片素材（/images/generations）；留空则禁用出图
LLM_IMAGE_SIZE=1024x1024
LLM_TIMEOUT_MS=120000
LLM_IMAGE_TIMEOUT_MS=180000
STUDIO_HOST=127.0.0.1
STUDIO_PORT=8787
# 门禁/离线演示：指向含 canned 响应的目录后，llm.ts 不发真实请求
# LLM_MOCK_DIR=.studio/mock
```
`.env` 与 `.studio/` 均入 `.gitignore`；**任何真实密钥不得写入代码/文档/日志**（继承项目安全红线）。

### 5.3 `llm.ts` — 单一 provider 三能力客户端

同一家 OpenAI 兼容 provider（`cfg.llmBaseUrl` + `cfg.llmApiKey`），按能力选不同模型：

```ts
// ① 文本 → video.ts 代码（LLM_MODEL），可携带参考素材(名+描述)
export async function generateVideoSource(input: { prompt: string; references?: AssetRef[] }, cfg: StudioConfig): Promise<CodeResult>
export interface CodeResult  { readonly source: string; readonly raw: string; readonly model: string; readonly usage?: Usage }

// ② 图片理解（LLM_VISION_MODEL，多模态 chat/completions）
export async function understandImage(input: { dataUrl: string; instruction?: string }, cfg: StudioConfig): Promise<VisionResult>
export interface VisionResult { readonly description: string; readonly model: string; readonly usage?: Usage }

// ③ 文本 → 图片素材（LLM_IMAGE_MODEL，/images/generations）
export async function generateImage(input: { prompt: string; size?: string }, cfg: StudioConfig): Promise<ImageResult>
export interface ImageResult { readonly bytes: Uint8Array; readonly mime: string; readonly model: string }

export interface AssetRef { readonly name: string; readonly description: string; readonly width?: number; readonly height?: number }
```

**① 代码生成**：`POST {base}/chat/completions`，`model: cfg.model`，
`messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:buildUserPrompt(prompt, references)}]`，`temperature:0.2`，`stream:false`，`signal:AbortSignal.timeout(cfg.llmTimeoutMs)`。
响应取 `choices[0].message.content`，`extractCodeFence()` 剥离 ```` ```ts … ``` ```` 围栏（无围栏则整体当源码）。

**② 图片理解（视觉）**：`POST {base}/chat/completions`，`model: cfg.visionModel`，多模态 content 数组：
```json
{ "model": "<visionModel>", "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "<instruction，默认: 描述这张图的主体/配色/风格/可用作文案或图形的要点，≤120字>" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,<...>" } }
]}], "max_tokens": 300 }
```
取 `choices[0].message.content`（纯文本描述）。`cfg.visionModel===null` → 抛 `LlmError{code:'MODEL_UNSET'}`。

**③ 图片生成**：`POST {base}/images/generations`，`model: cfg.imageModel`，
`{ prompt, size: input.size ?? cfg.imageSize, n:1, response_format:'b64_json' }`，`signal:AbortSignal.timeout(cfg.imageTimeoutMs)`。
- 首选 `data[0].b64_json` → 解码为 PNG 字节。
- 若 provider 只回 `data[0].url`：**受控回源**——仅当 URL 协议为 http/https 且**主机与 `llmBaseUrl` 同域**时才 `fetch`（防 SSRF），
  限 `maxUploadBytes` 大小与超时；否则抛 `LlmError{code:'IMAGE_URL_UNSUPPORTED'}`，提示用户该 provider 需支持 `b64_json`。
- `cfg.imageModel===null` → 抛 `LlmError{code:'MODEL_UNSET'}`。

**mock 模式**（`cfg.mockDir` 非空，三能力都走本地 fixture，**不发任何网络请求**，门禁/离线用，§9）：
- 代码：读 `${mockDir}/video.ts`；视觉：读 `${mockDir}/vision.txt`；出图：读 `${mockDir}/asset.png`。

**通用错误映射**：网络失败/超时/非 2xx/缺 `choices`|`data` → 抛 `LlmError{ status?, code?, message }`；
`server.ts` 转 HTTP（502 上游错 / 501 `MODEL_UNSET` / 400 用法），JSON `{error, code?}`；**绝不泄漏 api_key**。
**重试**：仅对 5xx/超时做 1 次退避重试；4xx（含 401/429）不重试。

### 5.4 `prompt.ts` — 系统提示（生成的质量核心）

`export const SYSTEM_PROMPT: string`，内容必须包含以下**全部**要素（门禁 grep 校验关键标记，§9）：

1. **角色**：你是 fframes-node 视频作者，输出一个可被 `loadVideo` 直接加载的 `video.ts`。
2. **`Video` 契约**（逐条）：`readonly fps/width/height`（number）、`duration(): Duration`、
   `audio(): AudioMap`、`fonts(): string[]`、`renderFrame(frame: Frame, ctx: FFramesContext): Svgr`；
   可选 `readonly defaultOutput?: string`、`defineScenes(): readonly Scene[] | null`；
   `export default new X()`（或工厂）。
3. **可用导入**（固定从 `'../../../src/index.ts'`，见 §5.5 归一化）：
   值 `svgr, seconds, frames, auto, fromAudio, timeline, Easing, Color, Transform, AudioMap, audioTrack, Svgr, Scenes`；
   类型 `Video, Scene, Frame, FFramesContext, Duration, Svgr`。
4. **动画**：`frame.animate(timeline<T>({start,end?,from,to,easing}, …))`；可动画类型 number/Color/Transform；
   `Easing.linear|easeIn|easeOut|easeInOut|cubicBezier(x1,y1,x2,y2)|spring({mass,stiffness,damping})`；`frame.animateLoop(tl)`。
5. **svgr 规则**：`svgr\`<svg …>…</svg>\`` tagged template，插值 `${}` 只能是字符串/数字/Color/Transform/Svgr；
   「本帧无内容」返回 `Svgr.empty()`；`ctx.renderScenes(frame)` 拼接场景。
6. **图片素材引用规则**（关键，配合 §5.5 素材库）：项目 `media/` 里的图片用
   `<image href="${ctx.getImage('logo.png')}" x="…" y="…" width="…" height="…" preserveAspectRatio="xMidYMid meet" />` 引用；
   `ctx.getImage(name)` 返回 base64 data URI 或 `null`。**必须**判空兜底：`${ctx.getImage('x.png') ?? ''}` 或先判 `ctx.hasMedia('x.png')`，
   `null` 时不要渲染破图；只支持 png/gif/jpg/jpeg；不得引用 `media/` 之外的路径。
7. **硬约束**：可擦除语法（禁 enum/namespace/参数属性/装饰器）；ESM 相对导入带 `.ts`；
   `fonts()` **必须返回真实存在的字体文件绝对路径**，示例统一用 `['/System/Library/Fonts/Helvetica.ttc']` 且 `font-family="Helvetica"`（resvg 不开 `loadSystemFonts`）；
   `renderFrame` 内**禁止**网络/文件 IO/随机数（渲染需确定性，`ctx.getImage` 是唯一合法的媒体读取口）；缺媒体用 `Svgr.empty()` 兜底而非抛错。
8. **时长纪律**：除非用户明确要求，`duration()` ≤ 10 秒（预览/渲染成本）；优先 `seconds(n)`。
9. **黄金样例**：内嵌 `examples/hello-world/video.ts` 全文作为 few-shot（唯一权威范例）；
   另附一个**含 `<image href="${ctx.getImage(...)}">` 的最小片段**演示素材引用。
10. **输出规则**：**只输出一个 ```` ```ts ```` 代码围栏**，内含完整 `video.ts`，不要解释文字、不要多文件、不要 markdown 标题。

`prompt.ts` 另导出：
- `buildUserPrompt(nl: string, references?: AssetRef[]): string` —— 把用户自然语言 + **被勾选参考素材**拼成 user 消息。
  有 references 时追加一段：`可用素材（已在 media/ 中，用 ctx.getImage('<name>') 引用）：\n- logo.png（1024x1024）：蓝色圆形标志…\n- bg.png：…`，
  并提示「按需选用，不要臆造不存在的素材名」。
- `VISION_INSTRUCTION: string` —— 图片理解的默认指令（见 §5.3 ②）。
- `EXAMPLES: {name, prompt}[]` —— 前端示例 chips 数据源。

### 5.5 `projects.ts` — 项目存储与动态加载（关键难点）

**项目布局**：`.studio/projects/<id>/video.ts`（+ 可选 `media/`、`out/`）。`<id>` = `p-<时间戳>-<随机6位>`，只允许 `[A-Za-z0-9._-]`。

**为什么固定深度**：生成的 `video.ts` 相对导入 `'../../../src/index.ts'` 才能命中真实 `src/index.ts`
（`.studio/projects/<id>/` 相对 `fframes-node/` 恰好上溯 3 级）。

```ts
export interface Project { readonly id: string; readonly dir: string; readonly videoPath: string; readonly mediaDir: string; readonly assetsPath: string }
export function createProject(cfg): Project                 // 建目录(含 media/), 受 maxProjects 限制
export function writeSource(p: Project, source: string): void // 归一化 import 后落盘 video.ts
export function readSource(p: Project): string
export function listProjects(cfg): Project[]
export async function loadProject(p: Project, cfg): Promise<{ video: Video; session: RenderSession }>  // createRenderSession 传 mediaDirFor(videoPath)
export function resolveProject(cfg, id: string): Project      // 拒绝目录逃逸 (../ / 绝对路径)
// —— 素材库 (media/ + assets.json) ——
export function saveAsset(p: Project, input: { suggestedName: string; bytes: Uint8Array; mime: string; source: 'upload'|'generated'; description?: string; width?: number; height?: number }): AssetInfo
export function listAssets(p: Project): AssetInfo[]          // 读 assets.json（与 media/ 实际文件对齐）
export function deleteAsset(p: Project, name: string): void  // 删 media/<name> + 更新 assets.json
export function getAssetRefs(p: Project, names: string[]): AssetRef[]  // 供 generate 注入参考素材
export interface AssetInfo { readonly name: string; readonly mime: string; readonly bytes: number; readonly source: 'upload'|'generated';
                             readonly description: string | null; readonly width: number | null; readonly height: number | null; readonly createdAt: number }
```

**import 归一化**（`normalizeImports(source, cfg)`）：LLM 常把导入写成 `'../../src/index.ts'` / `'./src/index.ts'` / `'fframes'`。
用正则把**任意**指向 fframes 公共 API 的说明符统一改写为规范相对路径 `'../../../src/index.ts'`：
- 匹配 `from '<spec>'`，当 `<spec>` 以 `src/index.ts` 结尾、或等于 `fframes`/`./src/index.ts` 等 → 替换为 `'../../../src/index.ts'`。
- 幂等：已规范的不动。单测覆盖各种畸形写法（§9）。

**素材存储（media/ + assets.json）**：上传与生成的图片都写进 `.studio/projects/<id>/media/`，元信息记在同目录 `assets.json`
（`AssetInfo[]`，供素材网格与参考注入）。`saveAsset` 规则：
- **名称消毒**：`suggestedName` 只保留 `[A-Za-z0-9._-]`，去路径分隔符；空/非法则回退 `asset-<时间戳>.<ext>`；重名自动加 `-1/-2` 后缀。
- **扩展名由 mime 决定**：`image/png→.png`、`image/jpeg→.jpg`、`image/gif→.gif`（与 `IMAGE_EXTENSIONS` 一致；其他 mime 拒绝）。
- **魔数校验**：写入前校验文件头（PNG `\x89PNG`、JPEG `\xFF\xD8\xFF`、GIF `GIF8`）与声明 mime 一致，防「伪扩展名」；不一致拒绝。
- **体积上限** `cfg.maxUploadBytes`；`width/height` 可选，用 `ffprobe`（已在 PATH）探测后写入，失败则留 `null`（非致命）。
- `assets.json` 与 `media/` 以文件为准对齐：`listAssets` 过滤掉已被手动删除的条目。

**动态加载 + 缓存击穿**（ESM 按 URL 缓存，同名文件二次 `import` 拿旧模块）：
`loadProject` 用 `import(pathToFileURL(videoPath).href + '?v=' + rev)`，`rev` 为「该 project 的写入计数器」（每次 `writeSource` 自增，存内存 Map）。
query 不同 → Node 视作不同模块实例 → 拿到最新代码。**注意**：这会累积模块注册表，本地工具可接受；
`config` 提供 `maxProjects`，并在文档注明「长时间高频生成建议重启服务」（§11 风险）。
> 图片素材**不进** ESM 缓存（运行时由 `ctx.getImage` 读文件），故新增/删除素材**无需** `rev` 自增；只有 `video.ts` 变更才需要。

**安全**：`resolveProject` 对 `id` 做白名单校验，`resolve()` 后必须仍在 `projectsRoot` 内；素材名同样消毒 + `resolve()` 前缀校验（防 `media/../../`）。
`loadProject` 会**执行**生成的 TS（`renderFrame` 是任意 JS）——这是既定 RCE 面，靠「仅绑定 127.0.0.1 + 单用户本地工具」缓解，见 §8。

### 5.6 `pipeline.ts` — 编排（复用库 API，不重写渲染）

```ts
export async function buildSession(p: Project, cfg): Promise<RenderSession>   // loadProject + createRenderSession(mediaDirFor)
export async function validate(p, cfg): Promise<ValidationResult>            // 见下
export function timeline(session): TimelineReport                            // 直接 timelineReport
export function inspect(session, rangeSpec?): InspectResult                  // inspectVideo(session,{range,...})
export function framePng(session, spec): Buffer                              // renderFramePng(session, session.index.resolveFrame(spec))
export function frameSvg(session, spec): string                              // renderFrameSvg(...)
export async function render(session, opts): Promise<RenderReport>           // renderVideo(session, {...opts, onProgress})
```

`ValidationResult`（前端 ③ 面板与 §6 契约）：
```ts
export interface ValidationResult {
  readonly ok: boolean;
  readonly stage: 'import' | 'session' | 'probe-frame' | 'inspect' | 'ok';  // 失败停在哪一步
  readonly error: string | null;             // import/渲染抛错信息
  readonly timeline: TimelineReport | null;  // session 建成即有
  readonly findings: InspectFinding[];       // inspect 结果（缺字体/缺媒体/空帧…）
  readonly probeFramePngBytes: number;       // 首帧(或中间帧)栅格化字节数, 0=失败
}
```
校验顺序（**短路**，任一步失败即返回带 `stage`/`error`）：
1. `import`：`loadProject`（捕获 `UsageError`/语法错/相对导入错）。
2. `session`：`createRenderSession`（解析 duration/scenes；`audioResolveError` 记为 finding 不致命）。
3. `inspect`：`inspectVideo(session,{range: fullRange 或抽样})`（缺字体/媒体/空帧）。
4. `probe-frame`：`renderFramePng(session, midFrame)` 试栅格化一帧（捕捉 `renderFrame` 运行时抛错/空帧被 rasterize 拒绝）。
5. 全过 → `ok:true, stage:'ok'`。

> 注意 `empty-frame` 是 **warning**（首帧可能是 `Svgr.empty()` 合法值但 rasterize 拒绝）——probe-frame 对
> `renderFramePng` 抛错要区分「空帧」与「真错误」：空帧只在 inspect findings 里提示，不使 `ok:false`（沿用 CLI 语义）。

### 5.7 `jobs.ts` — 渲染队列与 SSE

渲染是 CPU 密集且帧循环串行（见 `code-review.md`：全程串行）。**单槽队列**：同一时刻只跑一个 render job，其余排队。

```ts
export interface RenderJob { readonly id: string; readonly projectId: string; readonly status: 'queued'|'running'|'done'|'error';
                             readonly progress: {done:number; total:number}; readonly report?: RenderReport; readonly error?: string; readonly outputUrl?: string }
export function submitRender(deps, req): RenderJob        // 入队, 返回 job（立即）
export function subscribe(jobId, listener): () => void     // SSE 广播订阅, 返回取消函数
export function getJob(jobId): RenderJob | undefined
```
- job 完成把 mp4 写到 `.studio/projects/<id>/out/<jobId>.mp4`，`outputUrl = /media/<id>/out/<jobId>.mp4`。
- 事件类型（SSE `event:` 字段）：`progress`（`{done,total}`，节流每 10 帧，对齐 CLI `PROGRESS_EVERY`）、`done`（`{report,outputUrl}`）、`error`（`{message}`）。
- 进程内内存态；服务重启即丢（本地工具可接受，§11）。

### 5.8 `server.ts` — HTTP 路由与 API 契约

`node:http` `createServer`；手写极简路由（`URL` + `switch`），JSON body 用 `await readJson(req)`（限 1MB）。
入口：`if (isEntryPoint()) startServer()`（对齐 `cli/main.ts` 的 `process.argv[1]` 比对法，Node 24 无 `import.meta.main`）。
`npm run studio` = `node --env-file=.env src/studio/server.ts`（无 `.env` 时用 `node src/studio/server.ts` + 环境已导出的变量）。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/` | — | `index.html` |
| GET | `/static/*` | — | 前端静态（app.js/styles.css），正确 `content-type` |
| GET | `/api/config` | — | `{ hasKey:boolean, model:string, vision:boolean, image:boolean, imageSize:string, mock:boolean, examples:EXAMPLES }`（**绝不回传 key**；vision/image 为对应模型是否已配置） |
| POST | `/api/generate` | `{ prompt:string, projectId?:string, references?:string[] }`（references=素材名数组） | `{ projectId, source, validation:ValidationResult }`；LLM 失败 → 502 `{error}` |
| POST | `/api/upload` | `{ projectId, name:string, dataBase64:string, mime:string, understand?:boolean }` | `{ asset:AssetInfo }`（存 media/；`understand` 且有 vision 模型则附 `description`）；无 vision → 501 `{error,code:'MODEL_UNSET'}` |
| POST | `/api/asset/gen` | `{ projectId, prompt:string, name?:string, size?:string }` | `{ asset:AssetInfo }`（IMAGE_MODEL 出图存 media/）；无 image 模型 → 501 |
| GET | `/api/assets` | `?projectId&` | `{ assets: AssetInfo[] }` |
| DELETE | `/api/assets/:name` | `?projectId&` | `{ ok:true }`（删 media/<name> + 更新 assets.json） |
| POST | `/api/validate` | `{ projectId, source }` | `{ validation }`（覆写 video.ts 后重校验，供手改代码） |
| GET | `/api/timeline` | `?projectId&` | `TimelineReport` JSON |
| GET | `/api/inspect` | `?projectId&range=` | `InspectResult` JSON |
| GET | `/api/frame` | `?projectId&spec=` | **image/png** 二进制（供 `<img src>` 擦洗；spec 走 TimeSpec 语法） |
| GET | `/api/svg` | `?projectId&spec=` | `text/plain` SVG（可选「查看源码」） |
| POST | `/api/render` | `{ projectId, draft?:boolean, range?:string, crf?, preset? }` | `{ jobId }`（202） |
| GET | `/api/render/:jobId/stream` | — | **text/event-stream**（SSE：progress/done/error） |
| GET | `/api/render/:jobId` | — | `RenderJob` 快照 JSON（SSE 断线重连兜底） |
| GET | `/media/:id/*` | — | 伺服 `.studio/projects/<id>/` 下 `out/*.mp4\|*.wav` 与 `media/*.png\|jpg\|gif`（素材缩略图/播放；路径逃逸校验；`Range` 支持 `<video>` seek） |
| GET | `/api/projects` | — | `{ projects:[{id, createdAt, hasVideo}] }` |

错误约定：所有 API 失败返回 `{ error: string, code?: string }` + 合适状态码
（400 用法/404 不存在/413 上传超限/500 内部/501 `MODEL_UNSET` 该能力未配置模型/502 LLM 上游错）；
成功返回上表 JSON。**绝不**在响应里回传 `LLM_API_KEY`、绝对文件系统路径之外的敏感信息、或完整堆栈（只给 `message`）。

`/media` 需支持 HTTP `Range`（`<video>` 拖动进度条依赖 206）：读 `range` 头 → `fs.createReadStream(path,{start,end})` + `content-range`/`accept-ranges: bytes`。
上传走 **JSON base64**（`{name,dataBase64,mime}`）而非 multipart——零依赖免解析 multipart；故 `readJson` 上限对上传端点放宽到 `cfg.maxUploadBytes`（其余端点仍 1MB）。

---

## 6. 数据契约（前端消费的关键 JSON 形状）

`POST /api/generate` 成功：
```json
{
  "projectId": "p-1730000000000-a1b2c3",
  "source": "import { svgr, seconds, ... } from '../../../src/index.ts';\n...",
  "validation": {
    "ok": true, "stage": "ok", "error": null,
    "timeline": { "fps":30,"width":1920,"height":1080,"durationFrames":150,"durationSeconds":5,
                  "scenes":[{"index":0,"name":"Intro","fullName":"Intro","startFrame":0,"endFrame":150,"startSeconds":0,"endSeconds":5}],
                  "audio":{"sampleRate":44100,"tracks":[]} },
    "findings": [],
    "probeFramePngBytes": 48213
  }
}
```
SSE `progress`：`event: progress\ndata: {"done":90,"total":150}\n\n`
SSE `done`：`event: done\ndata: {"report":{...RenderReport},"outputUrl":"/media/p-.../out/job-....mp4"}\n\n`

`AssetInfo`（`/api/upload`、`/api/asset/gen`、`/api/assets` 共用；缩略图 URL = `/media/<projectId>/media/<name>`）：
```json
{ "name":"logo.png","mime":"image/png","bytes":20481,"source":"generated",
  "description":"蓝色圆形标志，中心留白，扁平风格","width":1024,"height":1024,"createdAt":1730000000000 }
```
`POST /api/upload` 请求（JSON base64，非 multipart）：
```json
{ "projectId":"p-...","name":"logo.png","dataBase64":"iVBORw0...","mime":"image/png","understand":true }
```
`POST /api/asset/gen` 请求 → 响应：`{ "projectId":"p-...","prompt":"蓝色圆形标志，扁平风","size":"1024x1024" }` → `{ "asset": AssetInfo }`。
能力未配置模型：`{ "error":"image model not configured","code":"MODEL_UNSET" }`（HTTP 501）。

---

## 7. 前端设计（vanilla，无构建）

### 7.1 组件（`index.html` + `app.js`）

- **① 生成区**：`<textarea id=nl>`、`[生成]` 按钮、示例 chips（来自 `/api/config.examples`，点击填入 textarea）、
  **参考素材勾选条**（列出已选素材名的 checkbox，生成时作为 `references` 传给 `/api/generate`）。
- **② 代码区**：`<textarea id=code spellcheck=false>`（等宽字体；v1 不引 CodeMirror，保持零依赖）、`[校验并预览]`。
- **③ 预览区**：`<img id=frame>`、擦洗条 `<input type=range id=scrub>`（`max = durationFrames-1`）、
  spec 文本框（支持 `50%`/`Intro@1.2s`）、时间轴/场景/校验只读展示、findings 列表（severity 着色）。
- **⑥ 素材区**：
  - 上传：`<input type=file accept=image/png,image/jpeg,image/gif>` + 拖拽区 → 前端 `FileReader.readAsDataURL` 取 base64 → `POST /api/upload{understand:true}`；
  - 生成：描述输入 + 尺寸下拉（默认 `/api/config.imageSize`）+ `[生成]` → `POST /api/asset/gen`；
  - 网格：每个素材一张缩略图（`<img src=/media/<id>/media/<name>>`）+ 名称 + VISION 描述 + `[删]`（`DELETE /api/assets/:name`）+ `[用作参考]`（切换 ① 勾选）；
  - 视觉/图片模型未配置（`/api/config.vision|image === false`）→ 对应控件禁用并提示「未配置视觉/图片模型」。
- **④ 渲染区**：`草稿`checkbox、`范围`输入、`[渲染]`、进度条、`<video id=player controls>`。
- **⑤ 控制台**：`<pre id=log>`，逐条 append（时间戳 + 级别 + 文本）。

### 7.2 状态与交互

- 全局 `state = { projectId, status, timeline, job, assets:[], refs:Set<string> }`；`status` 见 §1 状态机。UI 按 `status` 启/禁按钮。
- **项目引导**：`projectId` 惰性创建——首个「上传/生成素材」或「生成 video.ts」到达时，若 `state.projectId` 为空，
  服务端自动 `createProject` 并在响应里回传 `projectId`，前端存下后续复用（故 `/api/upload`、`/api/asset/gen`、`/api/generate` 的 `projectId` 均可选）。
- **上传素材**：选文件/拖拽 → `FileReader` 取 base64 → `POST /api/upload{understand:true}` → 返回 `asset` 推入 `state.assets` 并刷新网格；
  理解失败（无 vision 模型/上游错）不阻断入库，`asset.description` 留 `null`，控制台黄字提示。
- **生成素材**：填描述 + 尺寸 → `POST /api/asset/gen` → 同上入库；生成中禁用按钮防重复提交。
- **用作参考**：网格 `[用作参考]` 切换 `state.refs`；① 勾选条据此渲染。
- **生成**：`[生成]` → `status=generating` → `POST /api/generate {prompt, projectId, references:[...state.refs]}` → 回填 `code`、`state.timeline`、`projectId`；
  `validation.ok` → `status=ready` 并渲染首帧；否则 `status=error` 打印 `stage/error/findings`。
- **手改校验**：`[校验并预览]` → `POST /api/validate {projectId, source:code.value}` → 同上处理 validation。
- **擦洗**（§7.3）：`scrub` 的 `input` 事件（防抖 120ms）→ 设 `frame.src = /api/frame?projectId&spec=<帧号>`；
  spec 文本框改动同理。切换 `img.src` 前取消上一个未完成请求（`AbortController` 或直接靠浏览器覆盖）。
- **渲染**（§7.4）：`[渲染]` → `POST /api/render` → 拿 `jobId` → `new EventSource('/api/render/'+jobId+'/stream')`；
  `progress` 更新进度条；`done` → `player.src = outputUrl; player.play()`，`status=rendered`；`error` → 打印。
- 所有 `fetch` 失败统一 catch → ⑤ 控制台红字 + `status=error`（不弹 alert）；`code:'MODEL_UNSET'` 特化为「未配置对应模型」提示。

### 7.3 擦洗预览（秒级）实现要点

- 单帧走 `GET /api/frame`（服务端 `renderFramePng` 只栅格化 1 帧，几十毫秒级），`<img>` 直接吃 PNG 响应，无需 base64。
- 防抖 + 只在 `status∈{ready,rendered}` 时启用；渲染中禁用擦洗避免抢 CPU。
- 帧号 → spec：直接用整数字符串（TimeSpec 里 `120` = 帧 120）。

### 7.4 渲染进度与播放

- SSE 单向、原生、零依赖；断线用 `GET /api/render/:jobId` 快照兜底恢复进度。
- `done` 后 `<video controls src=outputUrl>`；`/media` 支持 Range → 可拖动。
- 草稿模式默认勾选（半分辨率 + ultrafast），显著缩短首次出片等待。

---

## 8. 安全与边界（红线）

1. **仅本地回环**：`STUDIO_HOST` 默认且强烈建议 `127.0.0.1`；文档明示「不要暴露到公网」。
2. **RCE 面**：生成/手改的 `video.ts` 会被 `import` 并执行（`renderFrame` 是任意 JS）。这是**既定风险**，
   v1 不做沙箱（`vm`/worker 隔离列为未来工作 §11）。缓解：本地单用户、绑定回环、`maxProjects` 限制、路径逃逸校验。
3. **密钥**：`LLM_API_KEY` 只存 `.env`（gitignore），三能力共用，只在 `llm.ts` 的 `authorization` 头使用；
   `/api/config` 只回传 `hasKey:boolean` 与各模型**是否已配置**（`model/vision/image`），绝不回传 key 明文或 base_url；日志/错误不含 key。
4. **路径逃逸**：`projectId`、素材名、`/media` 子路径均白名单 + `resolve()` 后前缀校验，拒绝越界读写（素材名防 `media/../../`）。
5. **上传校验**（图片理解 / 生成入库共用）：
   - **体积上限** `maxUploadBytes`（默认 8MB），超限 → 413；base64 解码前先按长度粗筛，再按解码字节精校。
   - **魔数校验**：只接受 PNG(`\x89PNG\r\n\x1a\n`)/JPEG(`\xFF\xD8\xFF`)/GIF(`GIF8`)，`mime` 必须与魔数一致，否则 400（防伪造扩展名塞任意文件）。
   - **名称消毒**：`[A-Za-z0-9._-]` 白名单 + 强制正确扩展名（由 mime 推导），拒绝 `.`/`..`/绝对路径/控制字符；同名覆盖前二次确认由前端负责。
6. **出图 SSRF 防护**：`/images/generations` 优先 `response_format:'b64_json'`（不回源）；仅当上游只回 `url` 时才受控回源，且**必须同 `LLM_BASE_URL` 域**（`new URL(url).origin === new URL(base).origin`），否则 `IMAGE_URL_UNSUPPORTED` 拒绝——防服务端被诱导拉取内网地址。
7. **请求体上限**：普通端点 1MB；上传端点放宽到 `maxUploadBytes`（§5.8）。SSE 连接数上限（防泄漏）；渲染单槽队列防 CPU 打满；图片生成/理解各自超时（`imageTimeoutMs`/`llmTimeoutMs`）+ 1 次退避重试。
8. 不记录/上传用户 prompt 与图片到第三方（除所选 LLM API 本身）；`.studio/` 产物（含上传/生成素材）纯本地。视觉理解只发送单张图片的 data URI，不夹带文件系统其它内容。

---

## 9. 验收门禁设计（`gates/verify-studio.sh`，确定性裁决，先红后绿）

**前置**：门禁跑前必须先「跑红」（产物未生成时 FAIL），证明门禁真的在检查。

**离线确定性**：门禁用 `LLM_MOCK_DIR` fixture（预置 `video.ts`、`vision.txt`、`asset.png`），
**不发真实 LLM 请求、不需要 API key**；ffmpeg/ffprobe 需在 PATH。三能力各自可 mock，缺哪个 fixture 则该能力检查跳过而非 FAIL（但 MODEL_UNSET 降级路径必测）。

检查项（逐项 PASS/FAIL，任一 FAIL → exit 1）：

| # | 检查 | 手段 |
| --- | --- | --- |
| S0 | `tsc --noEmit` 零错误 | `npm run typecheck` |
| S1 | 单测全绿 | `node --test test/studio/` |
| S2 | 服务能启动并监听 | 后台起 `node --env-file=.env.test src/studio/server.ts`，轮询 `GET /` |
| S3 | `GET /` 返回含关键标记的 HTML | grep `<textarea id=nl`、`id=player`、`id=scrub`、素材区标记（`id=assets`/`type=file`） |
| S4 | `/api/config` 不回传 key | 响应 grep 不含 `sk-`/`LLM_API_KEY` 值/`base_url` 明文；含 `hasKey`、`model`、`vision`、`image` 布尔/字符串 |
| S5 | mock 生成产出可加载 video.ts | `POST /api/generate {prompt}` → `validation.ok:true` 且 `source` 含 `implements Video` |
| S6 | import 归一化生效 | 返回 source 的导入说明符为 `'../../../src/index.ts'` |
| S7 | 时间轴 JSON 正确 | `GET /api/timeline` → `jq` 校验 `fps>0 && durationFrames>0` |
| S8 | 单帧 PNG 魔数正确 | `GET /api/frame?spec=0` → 前 8 字节 = PNG signature (`\x89PNG\r\n\x1a\n`) |
| S9 | inspect 返回结构 | `GET /api/inspect` → 含 `findings` 数组、`checkedFrames` |
| S10 | 整片渲染产出可探测 mp4 | `POST /api/render{draft:true}` → SSE 收到 `done` → `ffprobe` 校验有 video 流、时长>0 |
| S11 | SSE 进度事件序列合法 | stream 至少 1 个 `progress` + 结尾 `done`（或 `error`） |
| S12 | `/media` 支持 Range | `curl -H 'Range: bytes=0-1'` → 206 + `content-range` |
| S13 | 路径逃逸被拒 | `GET /media/../config.ts` / `projectId=../../` → 4xx，不泄漏文件 |
| S14 | 无新增运行时依赖 | `package.json.dependencies` 仍只有 `@resvg/resvg-js` |
| S15 | 上传入库 + 视觉理解（mock） | `POST /api/upload{name,dataBase64(合法 PNG),mime,understand:true}` → 200 `{asset}`，`asset.description` = `vision.txt` 内容；`media/<name>` 落盘且魔数为 PNG |
| S16 | 图片生成入库（mock） | `POST /api/asset/gen{prompt}` → 200 `{asset.source:"generated"}`，`asset.png` 字节落盘、`assets.json` 追加记录 |
| S17 | MODEL_UNSET 降级 | 置空 `LLM_VISION_MODEL`/`LLM_IMAGE_MODEL` 重启 → `/api/upload{understand:true}`、`/api/asset/gen` 返回 501 `{code:"MODEL_UNSET"}`；`/api/config` 对应 `vision/image:false` |
| S18 | 上传魔数/体积拒绝 | 伪造 `mime:image/png` 但字节非 PNG → 400；超 `maxUploadBytes` → 413；`name:"../../x"` → 4xx 不越界 |
| S19 | 出图 SSRF 防护 | mock 上游只回异域 `url` → 拒绝（`IMAGE_URL_UNSUPPORTED`），不发起回源；同域 `url`/`b64_json` 才入库 |

**门禁维护纪律**：断言用的 grep/jq/ffprobe 模式必须先用真实输出验证（吸取 verify-fframes 门禁两次假阴性教训）；
门禁误判时修门禁要有理由、可复查，**禁止为放行而放宽阈值**。

**单元测试清单**（`test/studio/*.test.ts`，`node:test` + `node:assert`，合成/本地 fixture，不打真实网络）：
`prompt`（含契约标记、围栏抽取、幂等、参考素材注入）、`projects`（归一化各畸形写法、缓存击穿 rev 递增、逃逸拒绝、`saveAsset` 魔数/名称消毒/体积上限、`listAssets`/`deleteAsset`/`getAssetRefs`）、
`llm`（三能力 mock：代码围栏剥离、`understandImage` 读 `vision.txt`、`generateImage` 读 `asset.png` 且异域 url 触发 SSRF 拒绝、MODEL_UNSET 映射、错误码）、`pipeline`（用 `examples/hello-world` 跑 timeline/inspect/framePng，断言 PNG 魔数）、
`jobs`（入队串行、事件序列 queued→running→done）。

---

## 10. 指挥官模式开发计划（切片计划）

沿用工作区已实证的四轮模式（契约单一事实源 = 本 `page.md`；生成切片 → 确定性门禁 → 并行双评审 → 指挥官亲验）。

**派遣前置**：指挥官预置 `.env.example`、`.env.test`（mock 配置）、`.studio/mock/{video.ts,vision.txt,asset.png}` fixture、
`gates/` 与 `scripts/` 目录、`package.json` 的 `scripts.studio`；子 Agent 无 bash，只 read/edit/grep，**增量落盘**（每文件写完立即 Write）。

**切片划分（依赖序，串行派遣）**：

| 切片 | 产出文件 | 依赖 | 要点 |
| --- | --- | --- | --- |
| STUDIO-1 后端底座 | `config.ts, types.ts, prompt.ts, llm.ts, projects.ts` + `test/studio/{prompt,projects,llm}.test.ts` | 库 API（已存在） | 纯逻辑，可单测；单 provider 三模型 config；`llm` 三能力（生成/视觉/出图）+ import 归一化 + 缓存击穿 + mock；`projects` 素材管理（saveAsset 魔数/消毒/限额）是重点；黄金样例从 `examples/hello-world/video.ts` 逐字内嵌 |
| STUDIO-2 编排+服务 | `pipeline.ts, jobs.ts, server.ts` + `test/studio/{pipeline,jobs}.test.ts` + `package.json` scripts | STUDIO-1 | 复用 §5.1 库 API；SSE + Range + 路由（含 upload/asset/gen/assets 与 MODEL_UNSET 降级）+ 单槽队列；`isEntryPoint` 守卫 |
| STUDIO-3 前端+门禁+文档 | `public/{index.html,app.js,styles.css}`、`gates/verify-studio.sh`、`scripts/dispatch-studio-*.sh`、README 追加「Studio」段、`.env.example`、`.gitignore` | STUDIO-1/2 | vanilla 无构建；⑥ 素材区（上传/生成/网格/用作参考）；门禁先跑红；示例 chips 与能力可用性对齐 `/api/config` |

**验证回环**：门禁 FAIL → 先归因（产物 vs 门禁）→ 小问题指挥官直修（改后重跑门禁，不搞双标）→ 大问题带证据重派（≤3 次）→ 触红线（需真实 key/联网）则停并升级。

**双评审（并行扇出）**：A=契约符合性（是否严格实现 §4/§5/§6/§8 的 API 与红线）、B=对抗挑刺（RCE/路径逃逸/SSE 泄漏/缓存击穿失效/依赖偷加/渲染并发/上传魔数伪造/出图 SSRF 回源/MODEL_UNSET 未降级）。
子 Agent 无 bash，其「完成」自述不作数；`tsc`/单测/门禁一律指挥官复跑（机械证据 > 自述）。

**交付物** = 产物 + 门禁 S0–S19 全绿 + 双评审结论 + 差异说明 + 一段「如何运行」：
```bash
cd fframes-node
cp .env.example .env      # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（可选 LLM_VISION_MODEL / LLM_IMAGE_MODEL）
npm run studio            # → http://127.0.0.1:8787
```

---

## 11. 风险与未来工作

| 项 | 说明 | 处置 |
| --- | --- | --- |
| 生成代码 = RCE | `import` 执行任意 JS | v1 绑定回环 + 单用户；未来：`node:vm`/worker 隔离、只读 FS 白名单 |
| ESM 缓存击穿累积 | `?v=rev` 使模块注册表增长 | `maxProjects` 限制；文档注明长时高频生成建议重启 |
| LLM 质量波动 | 生成可能不合契约 | prompt 黄金样例 + 强校验(§5.6) + 前端手改重校验闭环 |
| 免费/远端 API 延迟 | 生成慢 | 超时 + 1 次退避重试；mock 模式离线演示 |
| 视觉/出图模型能力参差 | 不同 provider 的多模态/出图接口差异大（有的不支持 `b64_json`、有的只回 url） | 单 provider 三模型分开配置，未配则 501 降级 + UI 禁用；出图优先 `b64_json`，url 回源仅同域（SSRF 防护，§8.6） |
| 出图/上传 = 大体积入库 | 图片进 `media/` 占磁盘、拖慢渲染读图 | `maxUploadBytes` 限额 + 魔数校验；素材不进 ESM 缓存；文档注明定期清理 `.studio/projects/<id>/media/` |
| 上传伪造文件 | 假扩展名/mime 塞任意字节 | 魔数强校验 + mime 一致性 + 名称消毒（§8.5）；仅本地回环 |
| 渲染串行 CPU 打满 | 见 `code-review.md` | 单槽队列；默认草稿预览；`rawvideo` 快路径未 exposed（越出本设计范围） |
| 无持久化 DB | 项目/ job 存文件系统+内存 | 本地工具定位；重启丢 job（产物 mp4 仍在磁盘） |
| 字体依赖系统路径 | `Helvetica.ttc` 仅 macOS | prompt 允许用户指定字体；跨平台字体列为未来工作 |

**明确不做（v1）**：可视化时间轴拖拽、多片段拼接 UI、音频波形、协作/账号、公网部署、Docker 化、`video.ts` 沙箱；
多 provider / 多套 key、图片编辑（inpainting/局部重绘/抠图）、素材库分类检索与标签、生成素材的自动版权校验。

---

## 12. 决策记录

| # | 决策 | 理由 | 备选(否决) |
| --- | --- | --- | --- |
| D1 | 生成引擎用 OpenAI 兼容 HTTP API | 用户选定；质量稳；`fetch` 原生零依赖 | opencode run（免费但质量波动） |
| D2 | 预览 = 单帧擦洗 + 按需整片 | 用户选定；秒级反馈 + 成本可控 | 仅整片(慢)/仅帧(无动态) |
| D3 | 后端 `node:http`，前端 vanilla | 继承项目「零依赖无构建」红线 | Express/Next（引入依赖与构建，违背红线） |
| D4 | 生成文件固定 `.studio/projects/<id>/video.ts` + import 归一化 | 相对导入深度确定，命中真实 `src/index.ts` | 重写为绝对 file URL（脆弱）；LLM 自由放（不可控） |
| D5 | `?v=rev` 缓存击穿加载 | ESM 按 URL 缓存，必须换 URL 拿新代码 | `delete require.cache`（CJS，不适用 ESM） |
| D6 | 门禁走 `LLM_MOCK_DIR` fixture | 确定性、免 key、可离线跑红绿 | 真实 API（不可复现、需密钥、违反 deny 联网） |
| D7 | 单槽渲染队列 + SSE | 渲染串行且重；SSE 原生单向零依赖 | WebSocket（需依赖/握手复杂） |
| D8 | 从 `../cli/main.ts` import `loadVideo`/`mediaDirFor` | index.ts 刻意不 re-export main.ts（死锁约束）；README 许可此路径 | 让 index.ts re-export（会重现模块图死锁） |
| D9 | 单 provider + 三模型分开配置（`LLM_MODEL`/`VISION_MODEL`/`IMAGE_MODEL` 共用一套 base_url/key） | 用户选定；一套凭据最省心；文本必填、视觉/出图可空并 501 降级 | 每能力独立 provider（配置复杂）；写死单一多模态模型（限制选择） |
| D10 | 上传/生成图片直接落 `.studio/projects/<id>/media/`，生成的 video.ts 用 `ctx.getImage('x.png')` 引用 | 复用现成渲染机制（§5.1），零新渲染代码；素材不进 ESM 缓存故无需 rev | 新建独立素材服务/DB（过度工程，违零依赖） |
| D11 | 上传走 JSON base64 而非 multipart | 零依赖免写 multipart 解析器；`readJson` 上限按端点放宽即可 | multipart（需引 busboy 或手写解析，违红线） |
| D12 | 出图优先 `b64_json`，仅同域 url 才受控回源 | 规避 SSRF；多数 OpenAI 兼容出图接口支持 b64 | 无条件回源任意 url（SSRF 风险）；只允许 b64（部分 provider 不支持会直接失败） |

---

_本设计为 v1。构建按 §10 切片派发；任何与库 API/项目红线的冲突，以现有 `src/**` 源码与 `README.md`/`PORTING.md` 为准，并在实现时回填本文件。_
