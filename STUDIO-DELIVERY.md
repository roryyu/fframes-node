# fframes-node Studio · 交付说明（指挥官模式）

契约单一事实源：[`page.md`](./page.md)。本文件记录**运行方式**、**与契约/子 Agent 产物的差异**、**双评审收敛**与**证据链归档**。

开发方式：外部 Agent 作**指挥官**，通过 OpenCode CLI（`opencode run --auto`，模型 `space-bunny-free`）派遣子 Agent 生成产物；子 Agent 权限 `edit=allow / bash=deny / webfetch=deny`，**不能自测**，所有 `tsc` / 单测 / 门禁 / 对抗验证一律由指挥官外部裁决。

---

## 1. 运行文档

前置：Node ≥ 24（原生 type-stripping 直跑，无构建）、`ffmpeg` 与 `ffprobe` 在 PATH。

```bash
cd fframes-node
cp .env.example .env          # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 等
npm run studio                # = node --env-file-if-exists=.env src/studio/server.ts
# 打开 http://127.0.0.1:8799
```

- **单 provider 三模型**：一个 `LLM_BASE_URL` + `LLM_API_KEY`，下挂 `LLM_MODEL`（生成 video.ts）/ `LLM_VISION_MODEL`（图片理解）/ `LLM_IMAGE_MODEL`（图片生成）。未配置的能力调用时返回 `501 MODEL_UNSET`，前端据 `/api/config` 的 `vision`/`image` 布尔位禁用对应控件并提示。
- **离线 mock 模式**：设 `LLM_MOCK_DIR` 指向 fixture 目录（见 `.studio/mock/`），不发真实 LLM 请求、不需真实 key——门禁正是走此模式。
- **安全边界**：服务**仅绑定 127.0.0.1**；它会执行传入的 `video.ts`，切勿暴露到公网。`api_key` / `base_url` 绝不出现在任何响应体、错误消息或启动日志中。

验收门禁（离线确定性，S0–S19）：

```bash
bash ../gates/verify-studio.sh    # 全绿 → exit 0；任一 FAIL → exit 1
```

---

## 2. 产物清单

| 归属 | 文件 |
| --- | --- |
| STUDIO-1 后端底座 | `src/studio/{config,types,prompt,llm,projects}.ts` |
| STUDIO-2 编排+服务 | `src/studio/{pipeline,jobs,server}.ts` |
| STUDIO-3 前端 | `src/studio/public/{index.html,app.js,styles.css}`（vanilla，无构建） |
| 单测（子 Agent） | `test/studio/{prompt,projects,llm,pipeline,jobs}.test.ts`（72 用例） |
| **指挥官预置**（§7.14.7 单一写者纪律） | `.env.example`、`.env.test`、`.env.test.novision`、`.gitignore`、`.studio/mock/{video.ts,vision.txt,asset.png}`、`../gates/verify-studio.sh`、`../scripts/dispatch-studio-{gen,reviewers}.sh`、`package.json` 的 `scripts.studio` |

> 契约 §4 把 `gates/`、`scripts/`、`.env.example`、`.gitignore`、README 列在 STUDIO-3，属**笔误**：按 §7.14.7「门禁/调度/文档归指挥官」，这些由指挥官维护，子 Agent 不写。

---

## 3. 差异说明（指挥官对子 Agent 产物的修正）

子 Agent 无 bash、不能自测，交付物存在若干缺陷，均由指挥官定位并修复（每处修复都以「先复现红、后转绿」验证）：

### STUDIO-1（2 处）
1. **`projects.ts` `normalizeImports` 丢失 `from` 关键字**：正则捕获了 `from ` 前缀但重写时未回放，`import { svgr } from '../../src/index.ts'` 被改成 `import { svgr } '../../../src/index.ts'`（语法错）。修复：为两个替换正则加 `prefix` 捕获组并在重写时回放。
2. **`projects.ts` `isSafeName` 不拒绝 `..evil`**：原实现只拒 `.` / `..`，放过 `..evil` 这类「与根同字符串前缀」的名字。修复：`!name.includes('..')`（防御纵深；合法 id `p-<ms>-<6hex>` 从不含 `..`）。

### STUDIO-2（3 处）
3. **`server.ts` 块注释提前闭合**：第 401 行 JSDoc 里的 `content-range: bytes */<size>` 的 `*/` 提前闭合块注释，导致 403–459 行被当作代码解析，级联 13 个 tsc 语法错。修复：改写该行文案为 `` `bytes *` + `/<size>` ``。
4. **`server.ts` 导入错误**：`realpathSync` 被从 `node:url` 导入（应属 `node:fs`）。修复：移到 `node:fs` 导入，`fileURLToPath` 保留在 `node:url`。
5. **`jobs.ts` `submitRender` 违反自身契约**：同步调用 `startSlotIfFree` 会在返回前把 `record.status` 置为 `running`，使返回快照不是 `queued`（违反 §5.7「入队, 返回 job（立即）」）。修复：先 `snapshot` 冻结 `queued` 视图，再用 `queueMicrotask` 延迟取槽——同时让调用方能在首个 `progress` 前挂上 SSE 监听。
6. **`projects.ts` `listProjects` 排序非确定**：id 形如 `p-<ms>-<6hex>`，同毫秒创建的两个项目 ms 前缀相同、由随机 hex 决定次序，违反「newest id first」保证（同毫秒约 50% 概率翻序，测试偶发红）。修复：`newProjectId` 改为**同毫秒内后缀单调自增**（首个随机、后续 +1，固定 6 位小写 hex 保证字符串降序 == 数值降序），跨进程/重启仍唯一。
7. **`pipeline.test.ts` 断言了错误的库消息**：测试假设坏帧规格 `nonsense!!` 报 `can not parse`，但库 `TimelineIndex` 对「有场景的视频里未知的场景名」实际报 `no scene "..."`；只有 `#nope` 这类畸形语法才报 `can not parse`。实现忠实透传库消息（符合 §5.6/§5.8），是**测试期望错**。修复：分别断言 `#nope → /can not parse/`、`nonsense!! → /no scene/`、`99999 → /outside the video/`。

### 双评审 A（契约符合性）阻塞项（3 处，见 §4）
8. **`server.ts` `/media` 分组白名单原型键绕过**（评审 A [FAIL 1]）：`MEDIA_GROUPS[group]` 对 `group=toString`/`constructor`/`valueOf` 命中 `Object.prototype` 得到真值函数，随后 `.has(...)` 抛 `TypeError` → `500` 且泄漏内部消息（契约要求 404）。修复：`Object.hasOwn(MEDIA_GROUPS, group)` 后再取值；并在门禁 S13 增补 `E4` 回归探针（原型键分组必须 4xx，绝不 5xx）。
9. **`app.js` 无视觉模型时整体禁用上传**（评审 A [FAIL 2]）：`dom.upload.disabled = !config.vision || rendering` 与 §7.2「理解失败不阻断入库」、自身提示文案「只能上传入库」、以及拖拽路径（仅告警仍上传）三者互相矛盾。修复：改为 `dom.upload.disabled = rendering`——视觉能力只决定 `understand` 请求位与提示，不阻断入库。
10. **`looksLikeVideo` / `videoFromDefault` 在 `projects.ts` 与 `pipeline.ts` 各复制一份**（评审 A [FAIL 3]）：与 §5.1「禁止重写」及 `pipeline.ts` 头注释「exactly one implementation」自相矛盾。修复：两函数从 `projects.ts` 导出为唯一实现，`pipeline.ts` 改为 `import { videoFromDefault }`，删除重复副本（36 行）。

---

## 4. 双评审收敛

### 评审 A（契约符合性）— VERDICT: FAIL(3) → 已全部修复
逐条核对 §3/§4/§5/§6/§8，3 个阻塞项即上表 8/9/10，均已修复并复验。另 9 条非阻塞观察（O1–O9，如 415/503/504 语义细化、上传上限 `⌈4·max/3⌉+64KiB` 的技术修正、失败后残留空项目目录等）判定为可接受，未改。完整报告：`.verify/studio/logs/review-studio-A-195829.md`。

### 评审 B（对抗挑刺）— 子 Agent 卡死，改由指挥官亲自经验验证
B（`space-bunny-free`）在生成最终综述时**卡死**：进程存活但日志在单个 `build` 步骤静默 9 分钟、无 VERDICT、未落盘 `.md`。指挥官果断终止，改以 **bash 实跑攻击向量**（比纯静态审阅更强）覆盖 B 的 6 个高发区，全部通过：

| 区域 | 探针 | 结果 |
| --- | --- | --- |
| 路径逃逸 / 原型键 | `media/../config.ts`、`%2e%2e`、`--path-as-is ../../`、`group=toString`/`constructor`、`projectId=%2e%2e%2f` | 全 4xx（404/400），无 5xx/2xx |
| 信息泄漏 | `/api/config`、错误体 | 无 `key`/`base_url`/`stack`/绝对路径 |
| Range 边界 | none/`0-1`/`100-`/`-50`/`999999999-`/`abc`/多区间 | 200/206/206/206/416/416/416，`content-range`+`accept-ranges` 正确 |
| 请求体上限 | `/api/generate` 灌 1.2MB | 413，服务不崩（后续 `/api/config` 仍 200） |
| 并发单槽 | 连提两个 render，高频采样 | 同时 `running` 最大值 = **1**，二者均 `done`；`submitRender` 即时返回 `queued` |
| 类型欺骗 / 可擦除语法 | grep | `as any` = 0；无 enum/namespace/装饰器；`erasableSyntaxOnly` tsc 通过 |

SSE 头正确（`text/event-stream`、`no-cache, no-transform`、`keep-alive`）；缓存击穿 `?v=rev`、SSRF 同域回源、`MODEL_UNSET` 先于 mock 由单测 + 门禁 S17/S19 覆盖。

---

## 5. 证据链归档（`.verify/studio/logs/`）

- 门禁最终跑：`PASS=20 FAIL=0`，`GATE RESULT: PASS`（S0 tsc 零错误 / S1 单测 72 全绿 / S2–S19 端到端）。S13 现含 4 探针 `404/400/404/404`（含原型键 E4）。
- 门禁跑红基线（产物生成前）：`PASS=2 FAIL=18` —— 证明门禁真会失败，非空转。
- 评审 A：`review-studio-A-195829.md`（VERDICT: FAIL(3)，全修）。
- 评审 B：`review-studio-B-195829.log`（末尾附指挥官批注：卡死终止，改经验验证）。
- 派遣日志：`dispatch-all.log`、`dispatch-reviewers.log`、`gen-studio-slice{1,2,3}-*.log`。

指挥官亲验复跑：`npx tsc --noEmit` = 0 错误；`node --test test/studio/*.test.ts` = 72/72；`bash gates/verify-studio.sh` = 20/0；`node --check src/studio/public/app.js` = OK。
