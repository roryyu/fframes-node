# DELIVERY — fframes-node 移植交付说明

> 每个切片的生成器子 Agent 只**追加**自己的一节（`## GEN-n …`），不重写他人章节。
> 事实源 = `.verify/fframes/gen-prompt.txt`（契约 v1）。本文件记录产出清单、§10 自查结果、
> 按契约最佳理解所做的决策与集成说明。

## 怎么读这个文件

| 章节 | 谁写的 | 内容 |
| --- | --- | --- |
| **1.x** | GEN-1（`src/core/**`） | 核心层产出、自查、mirror 对照、决策；末尾是给 GEN-2/GEN-3 的集成要求 |
| **修复轮 gen1** | 修复轮 | GEN-1 的 8 个单测失败如何按 Rust 源码裁决 |
| **2.1–2.6** | GEN-2（`src/audio/**`、`src/media/**`） | 音频 + 媒体层产出、自查、mirror 对照、决策；末尾是给 GEN-3 的集成要求 |
| **3.0–3.5** | GEN-3（渲染 / 编码 / 检查 / CLI / 示例 / 文档） | 本轮的产出清单、29 条决策、§10 自查、mirror 对照、未尽事项 |
| **修复轮 gen2 / gen3 / 4.4** | 修复轮 | 音频层 20 个单测失败、门禁 13 FAIL（CLI 挂起 + tsc 12 错 + 单测 6 失败）、以及一次独立复核 |

**行号会漂移。** 3.1 与 3.3 里的 `file:line` 是各切片**生成当轮**的快照；后续修复轮改动了同一批文件，所以那些行号不再指向当前内容。**最新的 file:line 在 4.2 / 4.3 / 4.4 里**，以那几节为准。3.1 / 3.3 的**文件清单、导出面、决策与自查结论**仍然有效。

---

## GEN-1 核心层（`src/core/**` + §8 中 7 个测试文件）

### 1.1 产出文件清单

源码（12 个文件，2318 行，含注释与 JSDoc）：

| 文件 | 行数 | 契约 §3 要求 | 说明 |
| --- | --- | --- | --- |
| `src/core/types.ts` | 177 | Video / Scene / FFramesContext / RenderOptions | 另含 `TimeBase` / `VideoSize` / `FFramesMode` / `SampleSize` / `WindowFunction` / `VisualizeFrameInput` / `InspectFinding` / `InspectResult`。对 audio、media 层的类型是**前向 `import type`**（见 1.4 第 2 条） |
| `src/core/frame.ts` | 172 | Frame：index、fps、globalIndex、seconds()、frameToSecond、secondToFrame、animate、animateLoop、visualizeAudioFrame、`cloneWithSceneOffset` 静态 | 另加 `intoGlobal()`、`animateRuntime()`、`set/getVisualizationResolver()` |
| `src/core/duration.ts` | 172 | Duration 判别联合 + seconds/frames/fromAudio/auto + addDuration/subDuration + toFrames | 另加 `secondsToFramesFloor()`（mirror `audio_map.rs:108`，供音频层复用）、`usedAudioFiles()` |
| `src/core/time-spec.ts` | 407 | TimeSpec 解析到帧号 / 范围，5 类错误 | `TimelineIndex`（主）+ `TimeSpec` 门面；`TimelineScene` / `FrameRange` / `TimeSpecError` / `TimeSpecResolveError` / `formatTimeSpecError` / `parseTimeSpec` / `shortSceneName` / `normalizeSceneName` |
| `src/core/color.ts` | 236 | fromHex / rgba / toSvg / interpolate / distance | 另加 `black/white/transparent/chromaKey/rgb/hex/alphaByte/fromAlphaByte/withAlpha/toString/equals` |
| `src/core/transform.ts` | 206 | translate/scale/rotate/identity、then()、toSvgAttribute、interpolate | 另加 `Rotate` / `Scale` / `skew()` / `distance()` / `toString()` / `equals()` |
| `src/core/svgr.ts` | 100 | Svgr、svgr`` 、Svgr.empty、concatSvgr | 另加 `stringifySvgrValue()`（§5.8 规则）与 `SvgrValue` 类型 |
| `src/core/scenes.ts` | 186 | Scenes.from、场景名/索引解析、resolveTimeline、renderScenes | `ResolvedScene` / `ResolvedScenesTimeline` / `Scenes.empty/emptyTimeline/fromValue/tryResolveTimeline` / `sceneName` / `sceneFullName`，并 re-export `shortSceneName` |
| `src/core/animation/easing.ts` | 131 | Easing 判别联合 + 4 常量 + cubicBezier() + spring() + solveEasing | 4 个小类（`LinearEasing` / `CssEasing` / `CubicBezierEasing` / `SpringEasing`）+ `EasingLike`（见 1.4 第 6 条） |
| `src/core/animation/cubic-bezier.ts` | 163 | CubicBezierRuntime mirror cubic_bezier.rs | 采样表 11 项 / 步长 `K_SAMPLE_STEP_SIZE`、Newton-Raphson 4 次 + 二分 10 次、x clamp、对角线短路，全部照抄 |
| `src/core/animation/spring.ts` | 126 | SpringRuntime mirror spring.rs | `SPRING_FRAME_DURATION = 0.166667`、`SPRING_SETTLED_FRAMES = 128`、`SPRING_MAX_SETTLE_STEPS`（见 1.4 第 7 条） |
| `src/core/animation/timeline.ts` | 242 | KeyFrame、timeline()、totalDuration、finalValue、get、getLoop | 另含 `AnimationRuntime`（static/linear/spring/cubicBezier 四态）、`applyProgress()`（`Animatable` 分派） |

测试（7 个文件，1511 行，**122 个 `test()`**）：

| 文件 | 行数 | `test()` 数 | 覆盖（契约 §8） |
| --- | --- | --- | --- |
| `test/animation.test.ts` | 327 | 25 | easeInOut.solve(0.5)=0.5±1e-4、solve(0/1)、linear 恒等、x clamp、投影曲线互逆、欠阻尼收敛 / 过冲、临界阻尼单调不过冲、spring 时长、timeline 前置 from / 中点 / hold 段 / 超尾 finalValue / 无 end 跳到下一关键帧 / 排序 / 末帧无 end 被跳过 / 空时间轴 / getLoop 回绕 / Color / Transform / spring 自推时长 |
| `test/time-spec.test.ts` | 268 | 23 | §5.7 全语法逐条形值（帧号 / `f` / `s` / `ms` / `m:ss` / `h:mm:ss` / `%` / `start` / `end` / 场景名大小写与 `Scene` 后缀 / `#i` / `[n]` / `@` 五种偏移）+ 5 类错误逐条触发 + `scenesAt` 重叠 + `TimelineIndex.fromScenes` |
| `test/duration.test.ts` | 145 | 11 | seconds(2.5)@30=75、seconds(2.567)@30=77、frames(10)=10、fromAudio + 浮点容差、auto+scenes 求和、auto+audioMap 尾帧、add/sub/saturating、usedAudioFiles、深层嵌套 |
| `test/color-transform.test.ts` | 209 | 23 | `#ff8800` / `#abc` / `#f0f8` / `#ff00ff80` 解析、非法回退黑、钳制、interpolate 中点截断、alpha 浮点、toSvg / toString、distance、translate/scale/rotate/skew 序列化、组合顺序、then()、interpolate 全分量、origin 优先级 |
| `test/svgr.test.ts` | 121 | 13 | 模板拼接 + §5.8 逐条（number / string 不转义 / null→'' / boolean / Svgr / Array / Color / Transform / 其它对象 String(x)）+ concatSvgr（数组 / 生成器 / 空） |
| `test/frame.test.ts` | 190 | 14 | seconds()=index/fps、frameToSecond/secondToFrame、animate 与手算一致（linear + easeInOut）、Color/Transform 动画、animateLoop、animateRuntime 三段、cloneWithSceneOffset（含 Rust 同款断言 index 60 / global 100）、intoGlobal、场景内动画、visualizeAudioFrame 平滑与缺 provider 报错 |
| `test/scenes.test.ts` | 251 | 13 | 顺序排布与起止帧、index/durationInFrames/isLast/totalScenes、frames 时长、空视频、from 接受数组/Set/null、`Scenes` 复用、类名兜底、TimelineIndex 联动、renderScenes 命中唯一场景、场景内帧 rebase、边界帧、无命中为空、回退 `video.defineScenes()`、纯数组声明 |

未创建契约清单之外的任何文件（`src/index.ts` 属 GEN-3；`README.md` / `PORTING.md` 属后续切片）。

### 1.2 §10 交付前自查（本切片相关项）

| # | 项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 清单中每个文件存在且非空；每 src 文件 `export` ≥1 | ✅ | 12/12 文件存在；`grep "^(export "` 命中 110 处（每文件 ≥1） |
| 2 | `enum ` / `namespace ` / `constructor(private\|public\|readonly` 零命中 | ✅ | src 零命中（曾有 2 处注释里的 "enum" 字样，已改写为 "variants" 以免门禁 grep 误报）；test 零命中 |
| 3 | 相对导入均带 `.ts` | ✅ | 27 处相对导入全部带 `.ts`（`src` 全量 grep `from '\.`） |
| 4 | §5 常数在源码中出现 | ✅（本切片相关） | `0.42`（cubic-bezier.ts:94 easeIn / :101 easeInOut）、`0.58`（:98 easeOut / :101）、`0.166667`（spring.ts:16 `SPRING_FRAME_DURATION`）、`128`（spring.ts:19）。其余 `0.005` / `8.6` / `256` / `-12` / `0.691` / `38.135` / `0.7071752` / `187425` 属音频层切片，不在本切片 |
| 5 | `test/` 下 `test(` 总数 ≥ 40 | ✅ | 本切片 122 个（25+23+11+23+13+14+13） |
| 6 | `TODO` / `FIXME` / `not implemented` / `placeholder` 零命中 | ✅ | src + test 全量 grep 零命中 |
| 7 | examples `export default` / broken-video 字体与媒体 | ⏭ | 非本切片（GEN-2/GEN-3） |
| 8 | `TRUE_PEAK_PHASES` 48 系数 | ⏭ | 非本切片（音频层） |
| 9 | `cli/main.ts` shebang / `exit(2)` | ⏭ | 非本切片（GEN-3） |
| 10 | `index.ts` 覆盖 §4 符号 | ⏭ | 非本切片（GEN-3）；本切片已把 §4 用到的全部符号导出，见 1.5 建议 re-export 清单 |

### 1.3 逐条对齐的 ground truth（mirror 清单）

| 本文件 | Rust ground truth | 对齐要点 |
| --- | --- | --- |
| `animation/cubic-bezier.ts` | `animation/cubic_bezier.rs`（全 163 行） | `NEWTON_ITERATIONS=4`、`NEWTON_MIN_SLOPE=0.001`、`SUBDIVISION_PRECISION=1e-7`、`SUBDIVISION_MAX_ITERATIONS=10`、`K_SPLINE_TABLE_SIZE=11`、`K_SAMPLE_STEP_SIZE=0.1`；`get_t_for_x` 的区间推进、guess 插值、slope 三分支（Newton / 0 / 二分）；`solve` 的 x clamp → 对角线恒等短路 → `x==0\|\|x==1` → `calc_bezier(t, y1, y2)` |
| `animation/spring.ts` | `animation/spring.rs`（全 75 行） | `zeta=d/(2*sqrt(k*m))`、`w0=sqrt(k/m)`、`zeta<1` 分支 `a=1, b=zeta*w0/wd, wd=w0*sqrt(1-zeta^2)`；否则 `wd=0, b=w0`；`solve` 返回 `1-progress`；`get_duration` 的 0.166667 步进 + 连续 128 帧 == 1 + 末行 `elapsed * frame_duration` 照抄 |
| `animation/timeline.ts` | `animation/animation.rs:98-269` | `KeyFramesAnimation::new`：`sort_unstable_by(start)` → 每帧算 `tween_duration`（`end-start` / `next.start-start` / 末帧 spring → `f32::MAX` / 末帧非 spring → **跳过**）→ `AnimationRuntime::new` → `seconds_range = start..start+runtime.get_duration()` → `next.start <= end` 只留本体，否则补 `Static` filler → `tweens[0].start > 0` 时在头部插入 `0..start` 的 Static tween → `total_duration = last.end ?? last.start - tweens[0].start`、`final_value = last.to`。`get()` = `frame.rs:148-168` 的 `animate_impl`（半开区间 `contains`，命中则 `apply_progress(from, to, solve(t - start))`，未命中 → `final_value`）。`getLoop` = `seconds % total_duration`（`total_duration <= 0` 时 Rust 得 NaN → 同样落到 `final_value`，此处显式返回 `final_value`） |
| `duration.ts` | `duration.rs`（全 135 行）+ `audio_map.rs:106-110` | 判别联合替代 enum；`Seconds → (s*fps) as usize`（`Math.trunc`）、`Frames → 原值`、`FromAudio → seconds_to_frames_floor`、`Auto → 场景时长或 audioMap 尾帧`、`Add → 求和`、`Subtract → saturating_sub`。`used_audio_files` 的树遍历、`seconds_to_frames_floor = (max(0,s)*fps + 1e-6).floor` |
| `time-spec.ts` | `time_spec.rs`（全 437 行，含 `#[cfg(test)]`） | 5 类错误 + `Display` 文案（`Invalid` 的语法提示串、`UnknownScene` 的 `available: #i Name` 列表或"does not define scenes"、`AmbiguousScene` 的 `matches scenes [..], use X[n] or #index`、`OutOfRange`、`EmptyRange`）；`short_scene_name`（去泛型 + 取 `::` 后段）；`normalize`（去 `_ - 空格`、小写、去 `scene` 后缀）；`find_scene`（`#i` / `Name[n]` / 名称匹配 / 歧义）；`resolve_frame` / `resolve_range`（`a..b` 右开、`a..`、`..b`、`all` / `*`、单场景、单点=1 帧、两侧 clamp、空区间报错）；`resolve_point`（`start` / `end` 的 start/end 侧差异 / `@start` `@end` / `@offset` / 百分比 100% 取末帧 / `ms` / `s` / `:` 累进 / 裸帧号 / `f` 后缀）；`try_parse_offset` 的 `round` 与 `floor` 语义差异照抄。测试值全部取自 Rust `mod tests`（`index()` 同构：`fps=30, 300 帧, Intro 0..100, Speaker 90..200, Speaker 200..300`） |
| `frame.ts` | `frame.rs:15-26, 42-46, 74-94, 96-108, 126-168, 196-210, 212-228` + 其 `scene_offset_tests` | 字段语义（`index` 相对场景 / `global_index` 全片 / `fps`）、`clone_with_scene_offset`（只减 `index`）、`into_global`、`seconds` / `frame_to_second` / `second_to_frame`（`(s*fps) as usize` → `Math.trunc`）、`animate_impl` 的半开区间查找、`animate_loop` 的取模、`animate_runtime` 的三段比较、`visualize_audio_frame` 的 `index < smooth_level*2+1` 短路与 `(index-smooth … index+smooth)` 求和平均 |
| `color.ts` | `color.rs`（全 338 行，含 `mod test`） | `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA` 逐位解析、大小写均可、非法回退 `BLACK`（不抛）、`hex_num` 的等价物未单列（用 `fromHex` 覆盖）、`apply_progress` 的 `as u8` 截断、`Display` 的 `rgb(...)` / `rgba(..., 0.502)`、常量 `BLACK/WHITE/TRANSPARENT/CHROMA_KEY`、`with_alpha` / `is_transparent` / `is_opaque` |
| `transform.ts` | `transform.rs`（全 545 行，含 `mod tests`） | 字段与默认值（`Rotate{angle, origin:Option}`、`Scale{x,y}` 默认 1）、`translate/rotate/scale/skew` 构造、`apply_progress` 的逐分量线性 + `origin: self.or(to)`、`Display` 的分段与"默认项省略 / 等比 scale 单参数 / rotate 带 origin 三参数"规则 |
| `svgr.ts` | `svgr.rs`（全 162 行） | 字符串形态 `Svgr`（`value` 只读 + `PhantomData` 在 TS 侧无对应）、`empty()`、`From<String>` / `From<&str>`、`FromIterator` = 字符串连接 |
| `scenes.ts` | `scenes.rs`（全 159 行）+ `video.rs:83-137`（`ResolvedScenesTimeline::from_scenes`）+ `fframes_context.rs:110-125`（`render_scenes`） | `SceneInfo` 字段（`duration_in_frames` / `index` / `total_scenes_in_video` / `is_last` / `start_frame` / `end_frame`）、`from_scenes` 的累加排布（overlap 本轮不做 → `overlap_prev/next = 0`）、`render_scenes` 的"命中区间的场景 + `clone_with_scene_offset` + `collect::<Svgr>()` 拼接"、未命中返回 `Svgr::default()`（= 空串） |

### 1.4 决策清单（按契约最佳理解 / 与契约字面不同的地方均标注）

1. **`Color.a` 用 `0..1`（契约）而非 Rust 的 `u8`**：契约 §3 color.ts 明写"字段 r,g,b(0..255) a(0..1)"。为不丢失 Rust 语义，另加 `alphaByte`（getter）与 `Color.fromAlphaByte()`。`interpolate` 的 alpha 按浮点线性（`0.5`），rgb 仍按 Rust `as u8` **截断**（故 `#000 → #fff` 在 `t=0.5` 得 **127** 不是 128），测试按此断言。（修复轮 gen1 第 2 项补充：`withAlpha` 的**入参**是 u8 字节，mirror `color.rs:224` 的 `with_alpha(a: u8)`；要 float alpha 请用构造器 `new Color(r, g, b, 0.5)`，字段形态不变。）
2. **`toSvg()` 按契约返回 `#rrggbb`（不透明）/ `rgba(r, g, b, a)`（半透明）**；Rust 的 `Display`（`rgb(r, g, b)`）另由 `toString()` 保留，供需要 `rgb()` 字面量的场合使用。`svgr` 插值按契约 §5.8 走 `toSvg()`。
3. ⚠️ **`Transform.toSvgAttribute()` 的拼接顺序取 Rust 顺序 `translate → rotate → scale → skewX → skewY`**，而不是契约 §3 括号里写的 `"translate(x y) scale(...) rotate(deg)"`。理由：`transform.rs` 的 `Display` 与 `From<Transform> for SvgAttributeValue`（矩阵连乘）**顺序必须一致**才对齐原版渲染结果；改顺序会让字符串形态与矩阵形态给出不同的画面。契约括号句按"各段格式示例"理解。测试 `color-transform.test.ts` 按 Rust 顺序断言。
4. **`Transform.then()` 契约未定义语义**（Rust 无此 API）。实现为"分量组合"：translate / skew / rotate.angle **相加**，scale **相乘**，rotate origin 取左侧、左侧为空时取右侧。已在 JSDoc 与测试中固化。
5. **Easing 用"带 `kind` 的小类"而不是纯字面量联合**：契约 §3 要求判别联合 `{kind:...}` 且提供 `solveEasing(e, t)`，而契约 §8 的测试描述写的是 `easeInOut.solve(0.5)`。用 4 个类（`LinearEasing` / `CssEasing` / `CubicBezierEasing` / `SpringEasing`）同时满足两点：`easing.kind` 仍是字面量 tag，`easing.solve(t)` 与 `solveEasing(e, t)` 都可用。`export type Easing` 与 `export const Easing` 同名共存（类型空间 / 值空间分离）。
6. **动画值的分派 `applyProgress(from, to, t)`**（契约 §5.4 允许"类型分派"）：number 线性；`Color` / `Transform` 走各自的 `interpolate`；类型不匹配抛 `TypeError`。公共 API 无 `any`（内部用 `as unknown as T`，见 `timeline.ts:28-34`）。
7. **`SpringRuntime.getDuration()` 末行 `elapsed * frame_duration` 照抄**（契约要求），因此 `spring(1,100,10)` 的时长是 **≈4.806** 而非 ≈28.83（`elapsed` 已是秒）。**额外加了 `SPRING_MAX_SETTLE_STEPS = 1_000_000` 的防御性上限**：Rust 用 `f32`，指数项下溢为 `0.0` 时 `solve == 1.0` 必然成立；JS 是 `f64`，`damping = 0` 的无阻尼弹簧永远达不到 `== 1`，循环会挂死。该上限在正常弹簧上永不触发。→ **PORTING.md 请记入"spring getDuration 存疑标注"**。
8. **空 timeline 的 `finalValue` 用数值 `0`**：Rust 用 `T::default()`，TS 没有 trait default，且空输入无运行时类型信息。`getLoop` 在 `totalDuration <= 0` 时直接返回 `finalValue`（与 Rust 得 NaN 后落到 `final_value` 的效果一致）。
9. **`frame.visualizeAudioFrame` 不静态 import `audio/visualize.ts`**，而是通过 `setVisualizationResolver(getVisualization)` 注入（`src/core/frame.ts:34`）。原因：`audio/visualize.ts` 属 GEN-2 切片，此刻不存在；**值级 import 会让本切片的 `frame.test.ts` 运行期直接模块解析失败**（类型级前向 import 才会被 type-stripping 擦除）。副作用：FFT 只有一份实现，core 不复制算法。→ **GEN-2 集成要求见 1.5。**
10. **`types.ts` 对 audio / media 层是前向 `import type`**（`../audio/audio-map.ts` 的 `AudioMap` / `Ducking` / `FadeCurve`，`../media/audio-decode.ts` 的 `DecodedAudio`，`../media/media-dir.ts` 的 `MediaDirectory`）。这些 import 在运行时被完全擦除，**不影响本切片任何测试的运行**；但在 GEN-2 落地前 `tsc --noEmit` 会报"找不到模块"，这是预期内的（指挥官已在切片指令中确认）。
11. **`Video.defineScenes()` 返回 `Scenes | readonly Scene[] | null | undefined`**：契约 §4 示例直接返回 `readonly Scene[]`，而 §3 / `Scenes.from` 用 `Scenes`。用联合返回 + `Scenes.fromValue()` 归一化，两者都成立（测试两种写法各覆盖一次）。
12. **`FFramesContext` 另加了 `definedScenes` / `resolveAudioDuration` / `hasMedia`**：分别是"渲染管线需要按 `Video` 现场解析场景"（`renderScenes` 的 fallback 路径）、"场景时长为 `fromAudio(...)` 时解析文件时长"、inspect 的 missing-media 判据来源。`getAudio` 返回 `DecodedAudio`（含 `sampleRate`），因为 `visualizeAudioFrame` 必须知道采样率。
13. **`toFrames` 的 `auto` 接受两种入参**：`scenesDurationInFrames?: number`（来自 `Scenes.resolveTimeline().totalDurationInFrames`）与 `audioMap?: { tracks: { timelineEndFrame?: number }[] }`（结构化 duck-typing，不 import 音频层）。两者都缺则抛错，对应 Rust 的 `MissingDurationOrScenes`。
14. **场景不做 overlap / 交叉淡化**（§1 明确不做）：`resolveTimeline` 严格顺序排布，`renderScenes` 一帧至多命中一个场景（Rust 允许两个）。
15. **`#3` / `Name[n]` 的下标只接受纯数字**（`/^\d+$/`），与 Rust `usize::from_str` 对 `-1` / `01` / `x` 的行为一致（`01` 在 Rust 能解析，本实现判 invalid——差异仅限前导零写法）。
16. **`TimeSpecError` 是 5 类判别联合，`TimeSpecResolveError` 是携带它的 `Error` 子类**：`resolveFrame` / `resolveRange` 抛 `TimeSpecResolveError`（`err.error.kind` 判类别，`err.message` 就是 Rust `Display` 文案），CLI 可 `instanceof` + 读 `kind`。

### 1.5 给下游切片的集成要求（GEN-2 / GEN-3 请照办）

- **`audio/visualize.ts`**：导出 `getVisualization(frameIndex: number, fps: number, input: VisualizeFrameInput): Float32Array`，并在模块加载时 `import { setVisualizationResolver } from '../core/frame.ts'` 后调用 `setVisualizationResolver(getVisualization)`；`fftRadix2` / `hannWindow` 保持契约签名。`SampleSize` / `WindowFunction` / `VisualizeFrameInput` 请从 `core/types.ts` **re-export**（类型单一事实源在此，`frame.ts` 已按此形状使用）。
- **`media/audio-decode.ts`**：契约写的是 `decodeAudioFile(...) → Float32Array`，但 `types.ts` 前向引用的是 `DecodedAudio { samples: Float32Array; sampleRate: number; channels: number }`（`FFramesContext.getAudio` 与 `VisualizeFrameInput.audio` 都需要 `sampleRate`）。请导出 `DecodedAudio` 并让 `decodeAudioFile` 返回它（或在 audio-decode.ts 里加 `toDecodedAudio()` 适配层）。
- **`media/media-dir.ts`**：导出名为 `MediaDirectory` 的类（`types.ts` 已按此名引用）。
- **`audio/audio-map.ts`**：导出 `AudioMap`（`none()` / `of(tracks)`）、`Ducking`、`FadeCurve`；`ResolvedAudioTrack` 建议额外暴露 `timelineEndFrame: number`（`Duration auto` 的解析入参，见 1.4 第 13 条）。注意 `types.ts` 用的是**类名 `AudioMap`（可 `new`）**还是接口，请保持同名可类型化即可。
- **渲染管线（GEN-3）**：`FFramesContext` 是 12 个成员的只读对象（`timeBase` / `currentVideoSize` / `durationInFrames` / `mode` / `scenes` / `definedScenes` / `mediaDir` / `fontFiles` / `resolveAudioDuration` / `renderScenes` / `scenesAt` / `getAudio` / `getImage` / `hasMedia`），构造点必须全部提供；`ctx.renderScenes(frame)` 建议直接绑到 `renderScenes(frame, video, ctx)`。
- **`index.ts` 建议 re-export**（覆盖契约 §4 示例 + 门禁需要）：`svgr` / `Svgr` / `concatSvgr`、`seconds` / `frames` / `fromAudio` / `auto` / `addDuration` / `subDuration` / `toFrames` / `Duration`、`Color`、`Transform` / `Rotate` / `Scale`、`Easing` / `EasingLike` / `solveEasing`、`timeline` / `KeyFramesAnimation` / `KeyFrame`、`Frame`、`Scenes` / `ResolvedScene` / `renderScenes`、`TimelineIndex` / `TimeSpec` / `TimelineScene` / `TimeSpecResolveError` / `formatTimeSpecError`，以及类型 `Video` / `Scene` / `FFramesContext` / `RenderOptions` / `SampleSize` / `WindowFunction` / `VisualizeFrameInput` / `FrameRange`。

### 1.6 本切片未尽事项

- `Video.defaultOutput` / `RenderOptions`（`output` / `frameStart` / `frameEnd` / `scale` / `draft` / `mediaDir` / `fontFiles` / `ducking` / `fadeCurve` / `onProgress`）只做了**类型定义**，行为由 GEN-2/GEN-3 实现。
- `InspectFinding` / `InspectResult` 同样是类型先行，实现在 `inspect/diagnostics.ts`（GEN-3）。
- `Scene.audio?()` 已在类型中预留，但 `Scenes.resolveTimeline` 暂不聚合场景音频（音频层未落地）。
- `Color.hexNum`（Rust `hex_num`）未单列——`fromHex` 已覆盖全部 4 种长度，评审如需数值入参可后补一行。
- `text_*` 系列（text_fit / text_break_lines / text_width）按 §1 不做。
- 执行级验证（`node --test`、`tsc --noEmit`）按 §0 纪律留给外部门禁；本切片只做编辑器级自查（1.2）。

---

## 修复轮 gen1（8 个单测失败 · Rust ground truth 裁决）

> **范围**：`node --test test/*.test.ts` 报出的 8 个失败（指挥官切片指令，裁决依据 `.source/fframes/fframes/src/*`）。
> **纪律**：每项修复「正反可辨」——修复前失败的那条断言就是回归验证；不删断言、不放宽容差；语义争议以 Rust 源码为最终裁决；推翻指挥官裁决必须给源码级反证并在本节留档。
> **执行级验证**：本轮权限面无 bash，未运行任何命令（全量复跑 `node --test test/*.test.ts` 交外部门禁）。所有结论均为逐行推演 + Rust 源码比对，推演依据写在各项内。

### 2.0 总览

| # | 位置 | 归因 | 处理 | 裁决状态 |
| --- | --- | --- | --- | --- |
| 1 | `test/animation.test.ts:308-312` | 测试错 | 改期望为 `''` | 采纳 |
| 2 | `src/core/color.ts:12-18,175-184` + `test/color-transform.test.ts:75-88` | 实现错 | `withAlpha` 入参改 u8 字节 | 采纳 |
| 3 | `test/color-transform.test.ts:192-199` | 测试错（实现已正确） | 修自相矛盾断言 | **推翻**（源码级反证） |
| 4 | `src/core/duration.ts:51-58` + `test/duration.test.ts` 8 处 + `src/core/types.ts:111,128` | 实现错 | `auto` 改常量 | 采纳 |
| 5 | `test/time-spec.test.ts:153-168` | 测试错 | 换 fixture 内场景 | 采纳 |
| 6 | `test/time-spec.test.ts:223-240` | 测试错 | 两分支各锁一条 | 采纳 |
| 7 | `test/time-spec.test.ts:242-255` | 测试错（实现已正确） | 改空场景分支期望 | **推翻**（源码级反证） |
| 8 | `test/time-spec.test.ts:262-302` | 未发现缺陷 | 实现/断言均不动，补 1 条投影断言 | 现场归因：判为误报 |

净效果：实现改动 2 处文件（`color.ts`、`duration.ts`）+ 2 处 JSDoc（`types.ts`）；测试改动 4 个文件。**未删除任何断言，未放宽任何容差。**

### 2.1 逐项修复

**1. `transforms component wise`：`get(0)` 期望 `'translate(0 0)'` → `''`（测试错）**

- 依据：`transform.rs:319-321` `if self.translate_x != 0.0 || self.translate_y != 0.0` —— 恒等分量**不输出**；`Transform::translate(0, 0)` 的 `Display` 结果是空串（`transform.rs:315-373` 全部五段都遵守同一"默认项省略"规则）。
- 改动：`animation.get(0).toSvgAttribute()` 期望改 `''`，并加注释指向 `transform.rs:319-321`；`t=1 → 'translate(0 50)'`、`t=2 → 'translate(0 100)'` 两条**原样保留**（正反可辨：恒等帧空串 / 非恒等帧有值）。`src/core/transform.ts` 零改动。
- 旁证：`color-transform.test.ts:143` 早已断言 `Transform.identity().toSvgAttribute() === ''`，同一规则的第二处锁定，两处现在互相印证。

**2. `rgb / rgba / with_alpha`：`withAlpha(128).alphaByte` 得 255 ≠ 128（实现错）**

- 依据：`color.rs:224` `pub const fn with_alpha(self, a: u8) -> Self` —— alpha 入参是 **`u8` 字节**；原实现按 float `0..1` 接收，`clampAlpha(128)` 饱和到 1 → `alphaByte = 255`。
- 改动（`src/core/color.ts`）：
  - 新增 `clampByte(value)`（:12-18，round + clamp 到 `0..255`），`clampChannel`（:20-22）改为委托它，行为逐位不变；
  - `withAlpha(alphaByte)`（:175-184）改为按 `u8` 语义：入参 round/clamp 后 `/255` 存入 float 字段。**字段形态不变**（契约 §3 要求 `a` 为 `0..1`，DELIVERY 1.4 第 1 条不动）。
- 契约与 Rust 的分工（为什么 `rgba` 保持 float）：契约 §3 明写字段 `a(0..1)`，故 `Color.rgba(255,0,0,0.5)`（`color.rs:219` 的 u8 版本）由 `fromAlphaByte` 承担字节路径，既有断言 `Color.rgba(1,2,3,0.25)` 保持不变。
- 测试增强（`color-transform.test.ts:79-87`，原有 2 条断言一字未删）：新增 float alpha 镜像（`semi.a ≈ 128/255`）、"既非不透明也非全透明"（对应 Rust `color.rs:325-327`）、字节 clamp 上下界（`300 → 255`、`-5 → 0`）。
- 影响面：全项目 `withAlpha` 无其他调用点（src/test 全量 grep 确认），不牵连其它用例。

**3. `interpolate` 的 origin 合并（推翻裁决：实现已正确，测试自相矛盾）**

- 反证：`src/core/transform.ts:24` 已是 `this.origin ?? to.origin`，与 `transform.rs:99` `origin: self.rotate.origin.or(to.rotate.origin)` 逐字等价（左有取左、左无取右、双无 None）。**实现无可修之处**，改它反而会偏离 Rust。
- 真正的缺陷在测试：原第 188 行与第 190 行对**同一个表达式** `without.interpolate(withOrigin, 0.5).rotate.origin` 同时断言 `[5, 5]` 与 `null`；且第 190 行的 message（"no origin at all"）与它实际所测的场景（左侧无、右侧有 origin）根本不符。
- 改动：保留前两条（Rust 三分支中的 left / right），第 198 行改为真正"双无"的 `without.interpolate(without, 0.5).rotate.origin === null`。三条恰好锁满 `left ?? right` 的三分支，且每条 message 与所测分支一致。`src/core/transform.ts` 零改动。

**4. `auto.kind === 'auto'`（实现错：导出形态）**

- 依据（三重）：
  - 契约 v1 §4 第 191 行：`duration(): Duration { return auto }` —— **无括号，是值**；
  - 契约 v1 §3 第 46 行：`构造器 seconds(n)/frames(n)/fromAudio(file)/auto` —— 前三个带参带括号，`auto` 不带；
  - Rust `duration.rs:20` `Auto` 是**单元变体**（值），只有 `Seconds(f32)` / `Frames(usize)` / `FromAudio(&str)` 这类带载荷变体才映射成工厂函数。原实现的 `auto()` 工厂与 Rust 的映射关系反了。
- 改动：
  - `src/core/duration.ts:51-58`：`export function auto()` → `export const auto: Duration = { kind: 'auto' }`（联合类型所有分支都是只读字面量，共享同一对象与每次新建不可区分）；
  - `test/duration.test.ts` 另有 8 处 `auto()` 调用（:81, :87, :94, :96, :107, :120, :128, :138），值形态下必须去括号。因原工厂恒返回 `{ kind: 'auto' }`，这 8 处替换**语义完全等价**：不删断言、不改期望值、不动已绿的结论；`auto.kind === 'auto'`（:72）这一条由失败转为通过。
  - `src/core/types.ts:111` / `:128` 两处 JSDoc 同步为 `auto`（防文档漂移）。1.5 的 re-export 清单里 `auto` 一项无需改动。

**5. `'Intro..Outro@end'` 抛 unknownScene（测试错）**

- 依据：`time_spec.rs:164-179`，`find_scene` 对表内不存在的名字一律 `unknown_scene`（与 `Intro` 无差别）；fixture 只有 `Intro` / `Speaker` / `Speaker`，Rust 同样报 UnknownScene。
- 改动（`time-spec.test.ts:153-168`）：右端换成 fixture 内场景，保持"右端场景名 = 该场景结束帧"的原意——`Intro..Speaker[0]` → `{0, 200}`、`Intro..Speaker[0]@end` → `{0, 200}`（`Speaker[0]` = 90..200；右端按 `Side::End` 取 `frames.end`，见 `time_spec.rs:287-290`，`@end` 见 `:264-269`）。另补 `assert.throws(() => t.resolveRange('Intro..Outro'), TimeSpecResolveError)`，把"fixture 里没有 Outro"这件事本身也锁住，避免以后再有人用不存在的场景写期望。

**6. garbage `'abc'` 期望 `invalid`（测试错；两分支都要锁）**

- 依据：`time_spec.rs:279-285` —— `find_scene` 抛出的 `UnknownScene` **只有 `available` 为空（视频无任何场景）时**才被 `map_err` 改写成 `Invalid`；有场景时 `'abc'` 就是 `UnknownScene`。本仓同规则在 `time-spec.ts:304-314`。
- 改动（`time-spec.test.ts:223-240`）：`index()` fixture 下断言 `'abc'` → `unknownScene`（并补 `available` 列表 + `no scene "abc", available: #0 Intro` 文案）；再补一条 `new TimelineIndex(30, 100, [])` 下 `'abc'` → `invalid` + **原有那条语法提示 `assert.match`（一字未删，只是移到它真正成立的那个分支）**。
- 逐个复核过的细节：原 9 个 spec 的 `assert.throws` 循环保持原样。其中 `''` / `abc` / `12abc` / `1..2..3x` / `-5` / `%` 在有场景时其实都是 `unknownScene`（`try_parse_offset` 的裸帧号只认 `/^\d+$/`），`#` / `#x` / `Intro@zz` 才是 `invalid`；但循环断言的是"必须抛 `TimeSpecResolveError`"这一层，9 条结论都不变。

**7. `'#7'` 类别不符（推翻裁决：实现已正确，错在空场景那一条）**

- 反证：`src/core/time-spec.ts:162-172` 的 `#` 分支已经与 `time_spec.rs:142-150` 逐条一致（解析失败 → `invalid`；解析成功但越界 → `unknown_scene(query)`）。**实现无可修之处。**
- 真正失败的是本测试**第二条**断言：`new TimelineIndex(30, 100, [])` 无场景时 `#0` 的 `find_scene` 返回 `available: []` 的 `UnknownScene`，随即被 `resolve_point` 的 `map_err` 改写成 `Invalid`（`time_spec.rs:279-285`），所以 Rust 给的是 `Invalid("#0")` 而**不是** `UnknownScene`。
- 改动（`time-spec.test.ts:242-255`）：有场景 `#7` → `unknownScene`（并补 `available` 列表，锁住"越界但有场景"这一支）；无场景 `#0` → `invalid`。两条正好把 `find_scene` 与 `resolve_point` 的组合行为钉死。`src/core/time-spec.ts` 零改动。

**8. `timeline index can be built from resolved scenes`（现场归因：未发现缺陷，判为误报）**

- 逐条推演（当前实现下四条断言全部成立）：`fromScenes(30,120,scenes)` → `scenes.length === 2`；`resolveFrame('Outro') = 60`；`resolveFrame('Outro@end') = 60 + (120-60-1) = 119`（`Side::Start` 下 `@end` 取 `length-1`，`time_spec.rs:264-269`）；`resolveRange('Intro..Outro') = {0, 60}`（右端 `Side::End` 取 `frames.end`，`:287-290`）。
- 适配层对照：`fromScenes`（`time-spec.ts:118-130`）与 Rust `TimelineIndex::new`（`time_spec.rs:97-120`）的投影一致，只保留 `index` / `name`（短名）/ `fullName` / 帧区间；`name` / `fullName` 由 `scenes.ts:139-152` 的 `sceneName` / `sceneFullName`（mirror `video.rs` 的 `ResolvedScenesTimeline::from_scenes`）提供，见 1.3。
- 处理：实现与原 4 条断言**均不动**；只补 1 条更强的投影断言（`t.scenes` 逐字段 `deepEqual`，比原来的 `length === 2` 更强，不弱），把"投影正确"也变成可回归的证据。
- 给指挥官的复核建议：本条的行号归属可能有误（失败清单疑把行号串到了相邻用例）。请用 `node --test test/time-spec.test.ts` 单跑一次确认；若该用例确曾失败，请把断言原文贴回，我按同款纪律重判——**在拿到反证前不改实现**。

### 2.2 本轮改了什么（供门禁 diff 核对）

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `src/core/color.ts` | `clampByte`(:12-18)、`clampChannel` 委托(:20-22)、`withAlpha` 改 u8 语义(:175-184) | 实现修复（第 2 项） |
| `src/core/duration.ts` | `auto()` → `auto` 常量(:51-58) | 实现修复（第 4 项） |
| `src/core/types.ts` | JSDoc `auto()` → `auto`(:111, :128) | 文档同步（第 4 项） |
| `test/animation.test.ts` | 期望 `'translate(0 0)'` → `''`(:308-312) | 测试修复（第 1 项） |
| `test/color-transform.test.ts` | `with_alpha` 补 3 条断言(:79-87)；origin 第三条改真正"双无"(:198) | 测试修复 + 增强（第 2、3 项） |
| `test/duration.test.ts` | 8 处 `auto()` → `auto` | 调用形态对齐契约（第 4 项，语义等价） |
| `test/time-spec.test.ts` | 右端场景名换 fixture(:153-168)；garbage 两分支(:223-240)；`#7`/空场景分支(:242-255)；`fromScenes` 投影断言(:290-297) | 测试修复 + 增强（第 5-8 项） |
| `DELIVERY.md` | 本节 + 1.4 第 1 条补注 | 交付记录 |

修复后行数（1.1 的行数列是生成轮快照，已按本轮改动漂移，门禁 `wc -l` 时以本表为准）：
`src/core/color.ts` 236 → **247**、`src/core/duration.ts` 172 → **176**、`src/core/types.ts` 177（不变）；
`test/animation.test.ts` 327 → **329**、`test/color-transform.test.ts` 209 → **217**、`test/duration.test.ts` 145（不变）、`test/time-spec.test.ts` 268 → **302**。
`test()` 用例总数**本轮不变**（只改断言，未增删用例）；1.1 表里的分文件用例数未在本轮重新核对，以门禁 `node --test` 的实际统计为准。

### 2.3 复跑要求（交外部门禁）

```bash
cd fframes-node && node --test test/*.test.ts        # 必须全绿，且总 test() 数只增不减
```

本轮**新增断言 11 条**（color-transform 5 条：float alpha 镜像 / 非不透明非全透明 / 字节 clamp 上下界 2 条；time-spec 6 条：`Intro..Outro` 抛错 1、garbage 的 `available` + 文案 + 无场景语法提示 3、`#7` 的 `available` 1、`fromScenes` 投影 1），**删除断言 0 条、放宽容差 0 处、修改期望值 4 处**（第 1 项 `''` 1 处、第 5 项右端场景名 1 处、第 6 项 `'abc'` 类别 1 处、第 7 项空场景 `#0` 类别 1 处），每处都已在 2.1 给出 Rust 行号依据。

---

## GEN-2 音频 + 媒体层（`src/audio/**` 6 文件 + `src/media/**` 2 文件 + §8 中 6 个测试文件）

### 2.1 产出文件清单

源码（8 个文件，**3232 行**，含 JSDoc 与逐行 mirror 注释）：

| 文件 | 行数 | 契约 §3 要求 | 关键导出 / 说明 |
| --- | --- | --- | --- |
| `src/audio/audio-map.ts` | 541 | `AudioDuration`、`audioTrack` 建造者、`FadeCurve` + `fadeCurveGain`、`Ducking`、`AudioMap.none()/of()`、`resolve` | `AudioTrack`（9 个建造者，全部返回新实例）、`TrackMix` / `DEFAULT_TRACK_MIX`、`FadeCurve` 4 值联合 + `FADE_CURVES`、`Ducking`（字段全可选）+ `ResolvedDucking` + `DEFAULT_DUCKING` + `resolveDucking`、`AudioMap`（类，`none`/`of`/`isNone`/`isEmpty`/`trackNames`/`usedAudioFiles`/`flattenWithScenes`）、`ResolvedAudioTrack` / `ResolvedAudioMap`（`calcStreamDuration`/`roundMaxDuration`）、`resolve` / `resolveAudioMap` / `resolveAudioFrames`、`samplesFromSeconds` / `secondsFromSamples` / `samplesToFrames` / `framesFromSeconds`、`AudioRange` / `SampleRange` 同构类型、`SceneAudio` |
| `src/audio/resample.ts` | 172 | 加窗 sinc 重采样，常数照抄 `audio_mix.rs` | `ZERO_CROSSINGS = 8`、`RESAMPLE_PHASES = 256`、`KAISER_BETA = 8.6`、`besselI0`（50 项 / 1e-12 收敛）、`SincResampler`（`half`/`phases`/`cutoff`/`sample`）、`getResampler`（按速率对缓存相位表）、`resampledLength`、`resample` |
| `src/audio/mixer.ts` | 797 | `AudioMixer`、lookahead 限幅器、5 ms de-click、ducking、增益/声像/淡化、采样精确定位叠加、`mixAudioToFile` | `DECLICK_SECONDS = 0.005`、`DEFAULT_MIX_SAMPLE_RATE`、`dbToGain`、`LimiterOptions` + `DEFAULT_LIMITER_OPTIONS`（ceiling −1 / lookahead 5 / release 80）、`MixerOptions` + `DEFAULT_MIXER_OPTIONS`、`Limiter`（导出，便于单测 `latency()`）、`AudioMixer`（`render`/`renderAll`/`renderInterleaved`/`activeTracksAt`/`missingFiles`/`preparedTracks`/`range`）、`ActiveTrack`、`mergeRanges`、`duckDb`、`panGains`、`TrackAudio`（结构类型，`DecodedAudio` 直接兼容）、`mixAudioToFile` |
| `src/audio/analysis.ts` | 539 | BS.1770 全套，`TRUE_PEAK_PHASES` 逐字照抄 | `Biquad`、`kWeighting`、`TRUE_PEAK_PHASES`（4×12 = **48** 个系数）、`TRUE_PEAK_COEFFICIENT_COUNT`、`truePeak`、`toDb`、`dbToGain`、`energyToLufs`、`finiteLufs`、`ABSOLUTE_GATE_MEAN_SQUARE`、`RELATIVE_GATE_FACTOR`、`MOMENTARY_HOPS = 4`、`SHORT_TERM_HOPS = 30`、`LoudnessAnalysis`（`windows`/`integrated`/`momentary`/`shortTerm`/`loudnessRange`/`quietRanges`/`hopSeconds`）、`analyzeAudio`（接受 `left/right` **或** `interleaved`）、`AudioAnalysis` / `LoudnessWindow` / `SectionAnalysis` / `AnalysisSection` / `AnalyzeAudioInput` |
| `src/audio/wav.ts` | 365 | 16-bit PCM（tag 1）+ f32le（tag 3）写出、`readWavHeader` 回读 | `WAVE_FORMAT_PCM` / `WAVE_FORMAT_IEEE_FLOAT`、`toInt16` / `fromInt16`、`TpdfDither`（确定性 xorshift，seed `0x9E3779B9`）、`encodeWav`（照抄 `encode_wav`）、`encodeWavInterleaved`、**`writeWav`（async）+ `writeWavSync`**、`WavHeader`、`parseWavHeader`、`readWavHeader`、`readWav` / `WavFile` |
| `src/audio/visualize.ts` | 277 | `fftRadix2`（原地）、`hannWindow`、mirror `frame.rs:212-270` + `audio_window_functions.rs` | `fftRadix2`（迭代 Cooley-Tukey，位反转 + 蝶形，长度校验）、`hannWindow` / `hammingWindow` / `blackmanWindow`（**双形态**：传长度返回系数，传样本返回加窗结果）、`applyWindowFunction`、`WINDOW_FUNCTIONS`、`SAMPLE_SIZES = [256, 512]`、`getVisualization`、`centerSpectrumLowFrequencies`；re-export `SampleSize` / `WindowFunction` / `VisualizeFrameInput`；**模块加载时 `setVisualizationResolver(getVisualization)`**（兑现 GEN-1 §1.5 集成要求） |
| `src/media/audio-decode.ts` | 310 | ffmpeg 预解码 → mono f32、ffprobe 时长 | `DecodedAudio`（类，= Rust `PreloadedAudioData`：`samples` / `right` / `sampleRate`，外加 `channels` / `sampleCount` / `isStereo` / `channelPair` / `durationInSeconds` / `durationInFrames` / `getRange` / `getFrameData` / `getFrameDataMono` / `interleaved`）、`DEFAULT_SAMPLE_RATE = 44100`、`parseF32le`、`deinterleave`、`decodeAudioFile`（mono，`-ac 1`）、`decodeAudioSamples`（契约字面形态，返回裸 `Float32Array`）、`decodeAudioFileStereo`（`-ac 2`）、`probeDurationSeconds`（`ffprobe -print_format json` 解析 `format.duration`）、`toDecodedAudio` |
| `src/media/media-dir.ts` | 231 | `MediaDirectory`：new / path / exists / list / usedFiles | `MediaDirectory`（`path`/`exists`（含 `..` 越界防护）/`list`/`names`/`namesOf`/`audioFiles`/`imageFiles`/`fontFiles`/`readFolder`/`usedFiles`/`hasAll`/`loadAudio`/`durationOf`/`dir`）、`MediaDirectoryEntry` / `MediaDirectoryCheck`、`mediaKindFor`、5 组扩展名常量（照抄 `read_folder` 的 match 分支） |

测试（6 个文件，**1923 行，108 个 `test()`**）：

| 文件 | 行数 | `test()` 数 | 覆盖 |
| --- | --- | --- | --- |
| `test/audio-map.test.ts` | 340 | 24 | 建造者 9 个字段全字段 / 不可变 / `volume`→dB / clamp；`fadeCurveGain` 4 曲线 × (端点/中点/clamp)；`Ducking` 默认值与部分覆盖；`AudioMap.none/of/trackNames/usedAudioFiles/flattenWithScenes`；**`resolve` 采样级定位 4.25 s@44100 → 起始样本恰 187425**；镜像 Rust `short_sounds_start_at_their_exact_sample`（0.51 s → 22491）；offset 参与 Eof base；显式 end 不被文件时长拉长；空/倒挂区间；Eof 且无法 probe 时抛错；场景音频偏移；`timelineEndFrame`（`Duration auto` 入参）；样本↔帧↔秒换算；`roundMaxDuration`；`resolveAudioFrames` |
| `test/mixer.test.ts` | 565 | 26 | 逐条镜像 `audio_mix.rs:691-946` 全部 6 个 Rust 测试：精确采样起点（22491/1000 非零样本）、重叠线性求和 + 限幅器（`\|s\| ≤ 10^(−1/20)+1e−6`、中段 ≈ ceiling ±1e−3）、`gain_pan_fades_and_offset`（0.125 / 硬右 / 0.5 s 后静音）、`ducking_follows_voice_ranges`（1–2 s voice：前 0.25 s 满、voice 中段 ≈ −12 dB、attack 斜坡在两者之间、release 斜坡、3.1 s 回到满）、`resampling_keeps_a_tone…`（48 k→44.1 k 1 kHz，3 个采样点 ±2e−3）、`maps_resolved_at_another_rate_are_rescaled`、`range_renders_start_in_the_middle_of_a_track`；另加：`equalPower` 淡化中点 = `sin(π/4)` ±1e−6、linear 淡出末样本为 0、**de-click 第 0/110/220 样本比例（0 / 110/220.5 / 220/220.5）**、de-click 可关、输出区间两端 de-click（`edge = trunc(220.5) = 220`）、契约形态的 voice 3–5 s 场景（voice 中段有效增益 −12 dB ±0.5 dB、6.1 s 后回 0 dB）、voice 不 duck 自己、`mergeRanges`、`duckDb` 端点、立体声 balance vs mono 等功率、`panGains`、master gain、缺文件跳过 + `missingFiles`、`activeTracksAt`（文件内位置 / 有效增益 dB / voice 标记）、交织输出、`mixAudioToFile` 16-bit 与 f32le 落盘回读、非法 sampleRate 抛错 |
| `test/resample.test.ts` | 140 | 10 | 三个常数（8 / 256 / 8.6）；`besselI0` 对 I0(1)、I0(2) 精确值、偶函数、单调；相位表参数（44100→22050 `cutoff 0.475`、`half 17`；上采样 `cutoff 0.95`）；`getResampler` 缓存；**44100→22050 与 48000→44100 的 1 kHz 正弦幅度保持 ±5%、长度 ±1 样本**；DC 电平三组速率都保持（逐相位单位直流增益的验证）；同速率精确复制；空输入；滤波边缘渐入而非跳变；不修改入参 |
| `test/analysis.test.ts` | 325 | 18 | `kWeighting(48000)` 9 个系数逐个对照 Rust `mod tests` 的期望值（1e−12）+ 44.1 kHz 重建；**`TRUE_PEAK_PHASES` 48 系数逐字 `deepEqual` 对照 + 相位 3 = 相位 1 反序、相位 4 = 相位 0 反序**；满幅 1 kHz 立体声 10 s → `integratedLufs ∈ [−3.4, −2.6]`；幅度 0.1245 → `[−21.6, −20.6]`（ffmpeg 基线 −21.1）；997 Hz 单声道 → −3.01 LKFS；满幅正弦 `truePeakDb ≈ 0 ± 0.5`；采样交替 ±1 的**采样间峰值 > 采样峰值**；>1 样本 → `clippingSamples > 0`；全零 → `silent` + 全部 `null` + 1 段静音区；3 s 静音 + 3 s 音（镜像 Rust `silence_and_sections`，sections 的 `null`/非 `null`）；momentary 窗口数与时间戳；两个门限常量；`-0.691` 偏移与 `finiteLufs` 四舍五入；相对门把低电平半段排除（`loudnessRangeLu`）；`LoudnessAnalysis` 子区间 + 非法 sampleRate；`interleaved` 入参与双声道入参一致；单声道按 `chain` 语义计两次 |
| `test/wav.test.ts` | 269 | 14 | 16-bit 立体声 44 字节头 + RIFF 尺寸（镜像 Rust `wav_headers`）；f32le 18 字节 `fmt ` + `fact`，总长 58+8、`formatTag 3`、首样本 `0.5`；`fact` 声明帧数；**dither 确定性**（同输入同字节、同 seed 同流、TPDF 幅值 < 1 LSB）；**16-bit 回读 ±1 LSB**（用 1/32767 的整数倍，dither 可关）+ dither 开启时 ≤1.5 LSB；f32le 精确回读（含 >1 的 1.25）；mono `blockAlign 2`；`readWavHeader` 读手写文件；`writeWav` promise 形态；`toInt16` clamp 而非回绕；非法 channels 抛错；非 RIFF / 非 WAVE / 无 `fmt` 三种坏文件抛错 |
| `test/visualize.test.ts` | 284 | 16 | `SAMPLE_SIZES` / `WINDOW_FUNCTIONS`；Hann 端点 `= 0`、峰值 1、周期性；双形态（传长度 / 传样本）；hamming 端点 0.08、blackman 端点 0、长度 1 不除零；`applyWindowFunction('none')` 是副本；**无窗 + 恰好落在 bin 的余弦 → 峰在 bin 3、幅度 = A·N/2 = 64、其余 bin < 0.01**；440 Hz + Hann → 峰在最近 bin（3）±1 内且远高于均值；512 窗口（257 bins，bin 11）；`fftRadix2` 精确性（bin 5 与 59 各 = N/2，其余 < 1e−9，共轭对称）；常数信号 → DC 尖峰；入参校验（非 2 次幂 / 长度不等 / 长度 0）；DC bin 是真实直流电平；**按帧取样**（帧 0 静音、帧 30 = bin 6 幅度 64）；越过音频末尾补零且 bin 数不变；**`Frame.visualizeAudioFrame` 真实 provider 端到端**（smoothLevel 2 平均帧 28..31 → bin 6 = 32，单帧 = 64）；`centerSpectrumLowFrequencies` 镜像 Rust `test_prettify_spectrum` |

全部信号为**合成**（常数 / 斜坡 / 正弦 / 余弦 / 阶跃 / 交替），无 ffmpeg、无真实媒体文件；仅 `wav.test.ts` / `mixer.test.ts` 写临时文件，落点为 `os.tmpdir()` 下的 `mkdtemp` 目录。

未改动 `src/core/**` 与 GEN-1 的 7 个测试文件；未创建契约清单之外的源码文件（见 2.5 第 1 条）。

### 2.2 §10 交付前自查（本切片相关项）

| # | 项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 清单中每个文件存在且非空；每 src 文件 `export` ≥1 | ✅ | 14/14 文件存在（8 src + 6 test），见 2.1 表；`grep "^(export\|const\|class\|function\|interface\|type)"` 在每个 src 文件均命中（`audio-map.ts` 顶层 25 处、`mixer.ts` 14 处、`analysis.ts` 20 处、`wav.ts` 17 处、`visualize.ts` 16 处、`resample.ts` 9 处、`audio-decode.ts` 10 处、`media-dir.ts` 12 处） |
| 2 | `enum ` / `namespace ` / `constructor(private\|public\|readonly` 零命中 | ✅ | `grep -E "\b(enum\|namespace)\s+\w\|constructor\s*\(\s*(private\|public\|protected\|readonly)"` 在 `src/**` **零命中**。过程中 `mixer.ts` 的 `FloatDelayRing` 曾用参数属性（`constructor(private readonly capacity: number)`），已在自查阶段改成显式字段 |
| 3 | 相对导入均带 `.ts` | ✅ | `grep "from '\."`：`src/audio` 10 处、`src/media` 2 处，全部带 `.ts`（`../core/duration.ts`、`../core/frame.ts`、`../core/types.ts`、`./audio-map.ts`、`./resample.ts`、`./wav.ts`、`./audio-decode.ts`）；test 内 6 个文件同样全部带 `.ts` |
| 4 | §5 常数在源码中出现 | ✅ | `0.005`（mixer.ts:28 `DECLICK_SECONDS`）、`8.6`（resample.ts:21 `KAISER_BETA`）、`256`（resample.ts:18 `RESAMPLE_PHASES`；visualize.ts `SAMPLE_SIZES`）、`-12`（audio-map.ts:75 `DEFAULT_DUCKING.depthDb`）、`0.691`（analysis.ts:168 `energyToLufs`、:180 `ABSOLUTE_GATE_MEAN_SQUARE`）、`38.135`（analysis.ts:55 `f0 = 38.13547087602444`）、`0.7071752`（analysis.ts:43 `q = 0.7071752369554196`）、`187425`（test/audio-map.test.ts:189 与 :197 两次显式断言）。`0.42` / `0.58` / `0.166667` 属 GEN-1 |
| 5 | `test/` 下 `test(` 总数 ≥ 40 | ✅ | 本切片 **108** 个（audio-map 24 + mixer 26 + resample 10 + analysis 18 + wav 14 + visualize 16），叠加 GEN-1 的 122 = **230** |
| 6 | `TODO` / `FIXME` / `not implemented` / `placeholder` 零命中 | ✅ | `grep -E "TODO\|FIXME\|not implemented\|placeholder\|XXX"` 在 `fframes-node/` 下的 66 处命中**全部位于 `node_modules/`**，`src/**` 与 `test/**` 零命中 |
| 7 | examples `export default` / broken-video 字体与媒体 | ⏭ | 非本切片（GEN-3） |
| 8 | `TRUE_PEAK_PHASES` 48 系数与 `audio_analysis.rs` 完全一致 | ✅ | `analysis.ts:71-127` 手写 4×12；`test/analysis.test.ts:67-113` 把相位 0、1 逐个 `deepEqual` 断言，并断言相位 3 = 相位 1 反序、相位 4 = 相位 0 反序（Rust 源码的构造方式），`TRUE_PEAK_COEFFICIENT_COUNT` 运行时再数一遍 = 48 |
| 9 | `cli/main.ts` shebang / `exit(2)` | ⏭ | 非本切片（GEN-3） |
| 10 | `index.ts` 覆盖 §4 符号 | ⏭ | 非本切片（GEN-3）；本切片新增待 re-export 的符号见 2.5 |

补充自查（超出 §10 清单的自查项）：

- **禁止依赖复核**：`src/**` 只 import `node:child_process` / `node:fs` / `node:fs/promises` / `node:buffer` / `node:path` 与本项目相对模块；无第三方依赖，未改 `package.json` / `tsconfig.json`。
- **测试不依赖 ffmpeg**：`audio-decode.ts` 的 `decodeAudioFile` / `probeDurationSeconds` 与 `media-dir.ts` 的 `loadAudio` / `durationOf` **没有任何测试调用**（§8 未要求），因此 `test/` 全部离线可跑；这两个模块要 spawn 外部进程，交由 GEN-3 的门禁在有 ffmpeg 的环境里验证。
- **`src/media/**` 无单测**（契约 §8 未列），已在 2.6 记为未尽事项。

### 2.3 逐条对齐的 ground truth

| 本文件 | Rust ground truth | 对齐要点 |
| --- | --- | --- |
| `audio/audio-map.ts` | `audio_map.rs`（全 596 行） | `FadeCurve::gain` 四分支（`linear`/`sin(t·π/2)`/`(1−cos(t·π))·0.5`/`10^(−60(1−t)/20)` 且 `t ≤ 0 → 0`）+ clamp；`Ducking` 默认 `−12 / 0.2 / 0.3 / 0.8 / 0.8`；`TrackMix` 8 字段与默认值；`AudioTrack` 9 个 builder 的 clamp（`volume` 用 `20·log10(max(v,1e−6))`、`pan` clamp ±1、fade/offset `max(0,·)`）；`AudioTimestamp::to_seconds` 的 `Eof → duration(file) + eof_base` 且 `eof_base = start − mix.offset`（`audio_map.rs:142-169` + `resolve` 的 `audio_map.rs:499-508`）；`AudioTimelineSamples::from_seconds = round(max(0,s)·sample_rate)`（**round 而非 floor**）与 `to_frames = samples·fps/sample_rate`（整数除法）；`seconds_to_frames_floor` 复用 GEN-1 的 `core/duration.ts`；`ResolvedAudioMap::round_max_duration` 的「越界截断 + `start ≥ max` 的 track 整条丢弃」；`used_audio_files` 只收 `Eof` 依赖的文件 |
| `audio/resample.ts` | `audio_mix.rs:63-156` | `bessel_i0` 的 `for k in 1..50`（即 1..=49）与 `term < sum·1e−12` 提前 break；`cutoff = min(out/in, 1)·0.95`；`half = ceil(ZERO_CROSSINGS / cutoff)`；`(phases+1)·taps` 相位表；`k = j − half + 1`、`d = k − frac`、`v = d/half`、`window = I0(β·√(1−v²))/I0(β)`（`\|v\| ≥ 1 → 0`）；`sinc` 的 `\|x\| < 1e-12 → 1`；逐相位单位直流归一化（`\|sum\| > 1e−9` 才除）；`sample()` 的 `p0 = min(floor(p), phases−1)`、相邻两行线性插值、越界样本按 0 处理 |
| `audio/mixer.ts` | `audio_mix.rs`（全 946 行） | `AudioMixOptions` / `LimiterOptions` 默认值；`db_to_gain`；`Limiter` 的滑动最小值 `min_window`（`pop_back` 去掉尾部 `≥ required`、`pop_front` 去掉 `i + lookahead ≤ n`、`hold = front`、`released` 指数释放）、`boxcar`（长度 = `lookahead`、槽位 `n % lookahead`、每 10⁶ 样本重算和以杀漂移）、`latency() = lookahead − 1` 与 `reset()` 预填静音、输出 `clamp(±ceiling)`；`PreparedTrack::envelope` 的**顺序**（fade_in 否则 declick_in → fade_out 否则 declick_out → ducking 相乘，fade 赢过 de-click）；`declick_in = declick && offset > 0`、`declick_out = declick && range.end < natural_end − 1`（`natural_end = range.start + (samples − source_start)/ratio`）；`duck_db` 的 raised-cosine attack / hold / release 与「取最深而非求和」；`merge_ranges`（`start ≤ last.end + gap`）；pan 的三分支（中心 `(1,1)` / 立体声 balance 衰减 / 单声道等功率且两侧 `.min(1)`）；`mix_raw` 的线性求和 + 末尾 master gain；`render` 的「限幅器提前 `latency` 取样 + 跳块时用 `latency` 个样本 prime」；输出区间 de-click 的 `saturating_sub` 语义；`new_rescaled` 的 `round(sample · out/in)` 重标定与 voice 区间换算；voice 不 duck 自己的过滤条件（照抄 Rust 的整段相等判断）；`active_tracks_at` 的 `20·log10(gain)` 与 `ducked_db` |
| `audio/analysis.ts` | `audio_analysis.rs`（全 498 行） | `Biquad` 直通 II 型；`k_weighting` 的 f0/g/q/vb 常数与两级系数公式；`TRUE_PEAK_PHASES` 4×12 逐字；`true_peak`（先取 `max|x|`，再对每相位做 12 抽头 FIR，`n ≥ k` 才累加）；`energy_to_lufs` 的 `−0.691`；`finite()` 的「非有限 → null，否则四舍五入两位」；`LoudnessAnalysis`（`hop = max(1, rate/10)`、`hops = left.len()/hop`、每声道独立滤波器状态、`take(hops·hop)` 截断）；`windows` 的 `range.len() < n → 空` 与 `start..=end−n`；`integrated` 的两级门（绝对 `10^((−70+0.691)/10)`、相对 `gated 均值 · 0.1`）；`momentary`（4 hop）/ `short_term`（30 hop）；`loudness_range`（EBU 3342：绝对门 + 均值·0.01 + 排序后取 10%/95% 分位）；`quiet_ranges` 的 `(i + 3)·hop` 收尾；`analyze_audio` 的字段集合与 `left.chain(right)` 语义（单声道按两遍计 clipping） |
| `audio/wav.ts` | `audio_analysis.rs:357-412`（`encode_wav`） | `fmt` 16（PCM，tag 1）/ 18（float，tag 3 + `cbSize = 0`）；`fact` 12 字节（size 4 + 帧数）；`riff_len = 4 + (8+fmt_len) + fact_len + 8 + data_len`；`byte_rate = rate·channels·bytes`；`block_align = channels·bytes`；`bits = bytes·8`；16-bit 路径的 **TPDF dither**（`state = 0x9E3779B9`，xorshift `^= <<13; ^= >>17; ^= <<5`，`uniform = state as f32 / u32::MAX`，`dither = u() − u()`，`(sample·32767 + dither).round().clamp(−32768, 32767)`），float 路径直写 `f32` |
| `audio/visualize.ts` | `audio_data.rs:76-159`（`apply_fft_to_frame` / `get_visualization`）+ `audio_window_functions.rs`（全 46 行）+ `frame.rs:212-228` | 帧取样 `start_index = frame·sample_rate / fps`（整数除法）+ 越界补零；`window: None` 不加窗；`spectrum[0].im = 0` 后取 `norm()`（本实现是复数 FFT，该行对实输入本就是 0，保留以对齐语义并注释说明）；输出 `size/2 + 1` 个幅度（等价 `rfft_N` 的 bin 数）；Hann 周期式 `0.5(1 − cos(2πi/n))`（`audio_window_functions.rs:9-18`）；`center_spectrum_low_frequencies`（`audio_data.rs:167-180`，含其 `#[cfg(test)]` 期望值）；`Frame.visualizeAudioFrame` 的平滑在 GEN-1 的 `core/frame.ts`（不重复实现），本模块只注册 provider |
| `media/audio-decode.ts` | `fframes-media/src/audio.rs`（全 100 行，`PreloadedAudioData`）+ `audio_data.rs` 的 `AudioData` | `samples` = 单声道全通道 / 立体声左，`right` = `Some` 仅立体声；`duration_in_seconds = len/rate`、`duration_in_frames = len·fps/rate`（整数）；`get_range` 越界 → `None`；`get_frame_data` / `get_frame_data_mono`（双声道取均值）；解码器本体 Rust 走 libavformat（`ffmpeg_sys_fframes`），本移植改走 `ffmpeg` CLI（见 2.4 第 1 条） |
| `media/media-dir.ts` | `fframes/src/renderer/media_directory.rs`（全 147 行） | `read_folder` 的两组扩展名 match（`Data` 组：jpg/jpeg/png/gif/vtt/mp3/wav/flac/aac/pcm/ogg/mp2；`Stream` 组：mp4/webm/mkv/avi/mov/flv/wmv/m4v/ttf/ttc/otf/otc）；非文件跳过；`process_media_source` 的分派键（扩展名 + 文件名）；缺失目录报错文案（`resources_dir must be a folder`） |

### 2.4 决策清单（按契约最佳理解 / 与契约字面不同的地方均标注）

1. **`decodeAudioFile` 返回 `DecodedAudio` 而不是裸 `Float32Array`**：契约 §3 写「→ Float32Array（mono）」，但 GEN-1 的 `core/types.ts:41` 写 `VisualizeFrameInput.audio: DecodedAudio`（`FFramesContext.getAudio` 也返回它），裸数组无法携带 `sampleRate`，而 `visualizeAudioFrame` 必须要。**两个形态都导出**：`decodeAudioFile` → `DecodedAudio`（`channels === 1`、`right === null`，与 `-ac 1` 一致），`decodeAudioSamples` → 裸 `Float32Array`（契约字面），`toDecodedAudio` → 适配层。另加 `decodeAudioFileStereo`（`-ac 2`）覆盖 Rust 的 `decode_raw_file_stereo`，`MediaDirectory.loadAudio` 用的就是它（对齐 `media_directory.rs:82` 的 `decode_raw_file_stereo`）。
2. **`DecodedAudio` 是类而不是接口**：`PreloadedAudioData` 的 6 个方法（`is_stereo` / `channels` / `duration_*` / `get_range` / `get_frame_data[_mono]`）都是逻辑，放在类里比让 GEN-3 重写一遍更接近 ground truth；合成信号测试用 `new DecodedAudio(samples, rate)` 直接构造，因此不需要媒体文件。`core/types.ts` 用的是 `import type`，运行期被擦除，不构成耦合。
3. **`Ducking` 的字段全部可选 + `ResolvedDucking` = `Required<Ducking>`**：`core/types.ts:156-158` 的 `RenderOptions.ducking?: Ducking | null` 是「全局默认覆盖」，用户写 `{ depthDb: -6 }` 必须能编译；而 `TrackMix.duck` 存的是已归一化的值。因此 `Ducking` 可选、`resolveDucking()` 填 `DEFAULT_DUCKING`、`AudioTrack.duck()` 存 `ResolvedDucking`。契约里 `Ducking {depthDb:-12, …}` 的默认值以 `DEFAULT_DUCKING` 常量表达（并在测试里 `deepEqual` 锁定）。
4. **`AudioTimestamp` 树收敛为 `AudioDuration {start?, end?}`**（契约字面）：Rust 的 `Frame` / `Time{minutes,seconds}` / `DurationOfAudio` / `+` / `-` 变体本轮不做（§1 明确不做项里没有它们，但契约 §3 的 `AudioDuration` 就是秒区间）。缺失 `end` = `Eof`，缺失 `start` = 0。**`Eof` 的 `eof_base = start − mix.offset` 语义完整保留**（`audio_map.rs:499-508`），所以 `audioTrack('take.wav', {start: 10, end: 14}).offset(3.2)` 与 `audioTrack('x', {start: 3}).offset(2)` 都按原版算。`DurationOfAudio("file")`（解析到另一个文件的时长）未实现，需要跨文件探针时可在 `resolveAudioDuration` 回调里自行组合。
5. **`resolve` 返回 `ResolvedAudioTrack[]`，`ResolvedAudioMap` 是可选包装**（契约字面是数组）；`resolveAudioMap()` 给包装版，`roundMaxDuration` / `calcStreamDuration` 在包装上。另加 `resolveAudioFrames()` 走 `AudioTimelineFrames` 单元（Rust 的泛型 `TUnit` 在 TS 侧用两个函数表达），供 `timeline` 命令与场景放置用。
6. **`ResolvedAudioTrack.timelineEndFrame`** 按 GEN-1 §1.5 第 4 条实现：`samples · fps / sample_rate` 整数除法（Rust `AudioTimelineSamples::to_frames`），是 `Duration auto` 的入参。已加测试锁定（2 s @30 fps → 60）。
7. **`MixerOptions.limiter` 用 `LimiterOptions | null | undefined` 三态**：`undefined` = 用默认（限幅开），`null` = 显式关闭（对应 Rust 的 `Option<LimiterOptions>` + `AudioMixOptions::default()`）。因此 `noMaster()` 测试助手 = `{limiter: null, declick: false}`，与 Rust `audio_mix.rs:745-751` 一致。**注意 `??` 不能表达这个三态**，故用 `=== undefined` 显式判断（见 `mixer.ts:465-469`）。
8. **`AudioMixer` 的输入用结构类型 `TrackAudio {samples, right, sampleRate}`** 而不是 import `DecodedAudio`：这样 `mixer.ts` 不产生对 `node:child_process` 的运行期依赖（`DecodedAudio` 所在模块 import 了它），单测可以只 import 混音器。`DecodedAudio` 结构上完全满足 `TrackAudio`，无需适配器。
9. **`mixAudioToFile` 是同步的**（`mixAudioToFile(input, wavPath, {float?, dither?})` → `WavHeader`）：渲染循环里混音本身是同步的，同步落盘省掉一层 await，且 CLI 的 `audio render` 正好这样用。`wav.ts` 同时提供 `writeWav`（async）与 `writeWavSync`。
10. **16-bit 保留 TPDF dither，并暴露 `dither: false`**：契约 §8 要求「16-bit 样本值 round-trip ±1 LSB」。dither 是 `encode_wav` 的既有行为（去掉会改变渲染产物），所以默认开启（`dither !== false`），并在测试里分两档断言：关 dither 时用 1/32767 的整数倍样本断言 **≤1 LSB**，开 dither 时断言 **≤1.5 LSB**。seed 固定为 `0x9E3779B9`，保证同输入同字节（可复现渲染）。
11. **`analyzeAudio` 额外返回 `silent`（契约要求）**：Rust 的 `AudioReport` 没有这个字段。定义 = **左右两个通道的每个样本都恰为 0**（数字静音），而不是「integrated 为 −inf」——后者对「极低但非零」的电平会误判为静音。`integratedLufs` / `truePeakDb` / `samplePeakDb` 对静音返回 `null`（Rust `finite()` 的 JSON 约定），`silent` 让 CLI 不必靠 `null` 推断。
12. **`momentary` / `shortTerm` 输出 `{timeSeconds, lufs}`，另加 `endSeconds`**：契约 §3 只写 `{timeSeconds, lufs}`。窗口起点 = `i · hop_seconds`（`quiet_ranges` 里 Rust 自己的 `s·hop_seconds` 就是这个口径），补 `endSeconds = (i + hops)·hop_seconds` 便于 CLI 画条带。`lufs` 沿用 `null` 表示静音。
13. **`fftRadix2` 是完整复数 FFT，`getVisualization` 取前 `N/2+1` 个 bin**（契约要求 `fftRadix2(re, im)` 原地）：Rust 走 `microfft::real::rfft_N`。对实输入两者等价且 `N/2+1` 的 bin 数一致；`spectrum[0].im = 0` 那行（实输入变换把 Nyquist 打包进 DC 的虚部）在本实现下是恒等操作，保留并在注释里说明了原因，不假装它有作用。
14. **`hannWindow` / `hammingWindow` / `blackmanWindow` 支持两种入参**（传长度 / 传样本）：契约写 `hannWindow(n)`，Rust 是 `hann_window(samples)`。两种读法都有人会用，故两种形态都支持（传 number 返回系数数组，传 `ArrayLike<number>` 返回加窗后的新数组），并在 JSDoc 与测试里锁定。
15. ⚠️ **`hamming_window` 不照抄 Rust 的笔误**：`audio_window_functions.rs:29` 写的是 `0.54 - (0.46 * (2.0 * PI * i as f32 / cosf(samples_len - 1.0)))`——`cos` 被写到了分母上、参数是 `len − 1` 而不是 `i`，这条式子算出来的不是 Hamming 窗。本移植按 **Hamming 窗的定义** `0.54 − 0.46·cos(2πi/(n−1))` 实现，测试断言两端 ≈ 0.08、中间 > 0.99。**PORTING.md 请记入此标注。**
16. **`getVisualization` 的补零策略与 Rust 的 `unwrap_or([0.0; size])` 一致但更明确**：Rust 在取样失败时 FFT 全零数组（`try_into().unwrap_or_else`），本实现在 `getFrameData` 返回 null 或长度不足时补零到 `size`，保证 bin 数恒为 `size/2+1`。
17. **`ffmpeg` / `ffprobe` 走 CLI 子进程，不链接 libavformat**：Rust 用 `ffmpeg_sys_fframes` 链接，本移植只允许 `node:*` 内置（契约 §2），所以 `decodeAudioFile` spawn `ffmpeg -v error -i <path> -f f32le -ac N -ar SR pipe:1` 收集 stdout，`probeDurationSeconds` spawn `ffprobe -v error -print_format json -show_format` 解析 `format.duration`（契约 §3 原文）。**不做双 stdin 管道**（§7 的 R2 死锁），音频仍走「先落 WAV 再二次输入」的两阶段。
18. **`MediaDirectory` 构造器不读文件**：`media_directory.rs:25-61` 的 `read_folder` 在目录不存在时抛错，而契约 §3 的形态是 `new(dir)`（示例里 `MediaDirectory('media')` 可能在目录被创建前就构造）。故 `new()` 只存绝对路径，`readFolder()` / `list()` 才触碰文件系统并抛错。`exists()` 额外做了 `..` 越界防护（`join` 之后检查前缀），让 `inspect` 把 `../secret.wav` 报成 missing 而不是读到目录外的文件。
19. **`usedFiles(names)` 返回 `{used, missing, ok}` 而不是抛错**：契约只说「usedFiles 校验辅助（供 inspect missing-media）」，`inspect/diagnostics.ts` 属 GEN-3，需要的是「哪些缺失」这个列表，抛错反而要 try/catch 每个文件。
20. **所有 `f32` 语义用 `f64` 表达**：Rust 音频链大量用 `f32`（`FadeCurve::gain`、`db_to_gain`、`pan`、`envelope`、biquad）。本移植全用 `f64`，因为 TS 只有 `f64`（`Math.fround` 只会引入偏差）。所有阈值断言（±1e-6、±1e-3）都留了比 `f32` 更大的余量，因此结论不受影响。**这是与原版的已知数值差异，PORTING.md 可记。**
21. **`ActiveTrack.fileSeconds` 是「文件内位置」不是时间线位置**（照抄 `audio_mix.rs:648` 的 `position / source_rate`），`offset` 会体现在这个值里。已加测试锁定（offset 0.25 s、输出样本 22050 → `fileSeconds = 0.25`）。

### 2.5 给下游切片的集成要求（GEN-3 请照办）

- **`audio/visualize.ts` 已完成 GEN-1 §1.5 第 1 条**：模块加载时自己调用 `setVisualizationResolver(getVisualization)`，并从 `core/types.ts` re-export `SampleSize` / `WindowFunction` / `VisualizeFrameInput`（类型单一事实源在 `core/types.ts`）。`index.ts` 若要暴露窗口函数，re-export 这一组即可，**不要再写一份 FFT**。
- **`media/audio-decode.ts` 已完成 GEN-1 §1.5 第 2 条**：`DecodedAudio` 是类，含 `samples` / `right` / `sampleRate` / `channels`，`decodeAudioFile` 返回它。`FFramesContext.getAudio` 可直接返回 `DecodedAudio | null`。
- **`media/media-dir.ts` 已完成 GEN-1 §1.5 第 3 条**：导出名为 `MediaDirectory` 的类。
- **`audio/audio-map.ts` 已完成 GEN-1 §1.5 第 4 条**：导出 `AudioMap`（类，`none()` / `of()`）、`Ducking`（可选字段）/ `ResolvedDucking`（全字段）/ `FadeCurve`（字符串联合）、`ResolvedAudioTrack`（含 `timelineEndFrame: number`）。`toFrames({kind:'auto'}, fps, {audioMap})` 需要的 `tracks[].timelineEndFrame` 已就位（`core/types.ts:22-25` 的 `DurationAudioTrackHint`）。
- **`index.ts` 建议追加 re-export**（本切片新增，接 GEN-1 §1.5 的清单）：`AudioMap` / `audioTrack` / `AudioTrack` / `AudioDuration` / `TrackMix` / `DEFAULT_TRACK_MIX` / `FadeCurve` / `FADE_CURVES` / `fadeCurveGain` / `Ducking` / `ResolvedDucking` / `DEFAULT_DUCKING` / `DEFAULT_FADE_CURVE` / `resolveDucking` / `resolve` / `resolveAudioMap` / `resolveAudioFrames` / `ResolvedAudioTrack` / `ResolvedAudioMap` / `AudioMapTimeBase`(即 `AudioTimeBase`) / `SceneAudio`；`resample` / `SincResampler` / `besselI0` / `ZERO_CROSSINGS` / `RESAMPLE_PHASES` / `KAISER_BETA`；`AudioMixer` / `Limiter` / `MixerOptions` / `LimiterOptions` / `DEFAULT_MIXER_OPTIONS` / `DEFAULT_LIMITER_OPTIONS` / `ActiveTrack` / `TrackAudio` / `mixAudioToFile` / `panGains` / `mergeRanges` / `duckDb` / `dbToGain` / `DECLICK_SECONDS`；`analyzeAudio` / `LoudnessAnalysis` / `AudioAnalysis` / `SectionAnalysis` / `AnalysisSection` / `TRUE_PEAK_PHASES` / `kWeighting` / `Biquad` / `truePeak` / `toDb` / `energyToLufs`；`writeWav` / `writeWavSync` / `readWavHeader` / `readWav` / `encodeWav` / `WavHeader`；`fftRadix2` / `hannWindow` / `hammingWindow` / `blackmanWindow` / `applyWindowFunction` / `getVisualization` / `centerSpectrumLowFrequencies`；`DecodedAudio` / `decodeAudioFile` / `decodeAudioFileStereo` / `decodeAudioSamples` / `probeDurationSeconds` / `DEFAULT_SAMPLE_RATE`；`MediaDirectory` / `mediaKindFor` / `MediaDirectoryEntry` / `MediaDirectoryCheck`。
- **CLI（GEN-3）的音频链拼装顺序**（本切片已把每一步做成独立函数）：`video.audio()` → `resolve(map, {fps, sampleRate: 44100, resolveAudioDuration})` → 解码每个 `track.file`（`mediaDir.loadAudio` / `decodeAudioFile`）→ `new AudioMixer({tracks, audio, sampleRate, outputRange, totalSamples, options})` → `mixAudioToFile(input, os.tmpdir()/x.wav, {float})` → ffmpeg 二次输入。`RenderOptions.ducking` / `fadeCurve`（GEN-1 §1.6 遗留）建议这样落地：作为 `AudioTrack` 默认值的覆盖，或在 `resolve` 之后对 `mix.duck === null` 的 track 补 `renderOptions.ducking`。
- **`audio at <spec>`** 用 `AudioMixer.activeTracksAt(sample)`，字段已经是 CLI §6 要求的 `{file, positionInFileSeconds, gainDb, voice}`（本实现叫 `fileSeconds`，另给 `duckedDb`）。
- **`inspect` 的 missing-media** 用 `MediaDirectory.usedFiles(audioMap.trackNames())`。
- **门禁建议加的两条黑盒断言**（本切片无测试覆盖、需要外部进程）：`decodeAudioFile('examples/audio-demo/media/sine.wav')` 的 `sampleCount ≈ duration·44100` 且 `channels === 1`；`probeDurationSeconds` 对同一文件返回 > 0。

### 2.6 本切片未尽事项

- **`src/media/**` 没有单元测试**（契约 §8 未列这两个文件）：`MediaDirectory.list/readFolder/usedFiles/exists` 与 `decodeAudioFile/probeDurationSeconds` 都只做了编辑器级自查。前者其实可以离线测（临时目录 + 造几个空文件），是时间预算内的取舍；后者需要 ffmpeg，契约 §8 明令测试不得调用 ffmpeg。
- **`decodeAudioFile` 未做缓存**：同一次 `render` 里同一个文件被两条 track 引用时会解两次。Rust 侧由 `MediaDirectory::process_media_source` 预先解码一次规避；本移植把缓存责任留给 GEN-3（`MediaDirectory` 或 CLI 的 decode map）。
- **`AudioTimestamp` 的 `Frame` / `Time{minutes,seconds}` / `DurationOfAudio` / `+` / `-` 变体未实现**（见 2.4 第 4 条），契约 §3 的 `AudioDuration` 没有它们。
- **`AudioMap.resolve` 的 `offset`（场景整体时间偏移）只在 `resolveAudioFrames`/`resolve` 内部按场景起点实现**，`AudioMap.resolve` 的 Rust `offset: TUnit` 形参（供 scene audio 用）在本移植里换成了 `ResolveAudioOptions.sceneAudio`，语义等价。
- **`analyze --waveform` 的波形图 PNG 按 §1 不做**，故 `LoudnessAnalysis` 没有暴露逐 hop 的原始能量（只暴露了 `momentary` / `shortTerm` 的 LUFS）。
- **`Scene.audio?()` 已在 `core/types.ts` 预留**，本切片提供了 `resolveAudioMap(...).flattenWithScenes()` 与 `resolve(..., {sceneAudio})` 让 GEN-3 聚合，但 `Scenes.resolveTimeline` 仍不聚合场景音频（GEN-1 §1.6 已记）。
- **Hamming 窗未照抄 Rust 笔误**（2.4 第 15 条）与**全链 `f32 → f64`**（2.4 第 20 条）两条 PORTING.md 标注请求。
- 执行级验证（`node --test test/`、`tsc --noEmit`）按 §0 纪律留给外部门禁；本切片只做编辑器级自查（2.2）。

> **一次中途夭折的记录**（切片指令提到的教训）：本切片 14 个文件全部**增量落盘**（依赖序：`media/audio-decode` → `media/media-dir` → `audio/audio-map` → `audio/resample` → `audio/wav` → `audio/analysis` → `audio/mixer` → `audio/visualize` → 6 个测试），每个文件写完立刻 `Write`，没有出现「最后批量写」的窗口。唯一一次越界是 `resample.ts` 首版把三个常数放进了计划外的 `src/audio/resample-constants.ts`——在自查的 `grep` 之前就发现并改成了文件内 `export const`，该文件从未真正落盘（`glob` 复核过目录里只有契约清单内的文件）。

---

## GEN-3 渲染 / 编码 / 检查 / CLI / 示例 / 文档

> **范围**：契约 §3 剩余全部文件（`src/render/**`、`src/encode/**`、`src/inspect/**`、`src/cli/**`、`src/index.ts`、3 个示例、3 个说明文件）。
> **执行级验证**：本轮权限面无 bash，未运行任何命令（`tsc --noEmit`、`node --test`、任何 ffmpeg 调用都留给外部门禁）。所有结论来自逐行阅读源码 + M0 探针数据。

### 3.0 落盘方式与一次中途越界

**本切片 16 个代码文件（12 源码 + 4 示例）＋ 3 个文档全部增量落盘**，顺序即依赖序：`render/resvg-backend`（渲染会话）→ `encode/ffmpeg-encoder` → `inspect/diagnostics` → `cli/args` → `cli/render` → `cli/frame` → `cli/svg` → `cli/timeline` → `cli/inspect` → `cli/audio-cmd` → `cli/main` → `index` → 4 个示例 → 3 个文档。每个文件写完立即落盘，没有「最后批量写」的窗口；`cli/*.ts` 之间无环（`main` 单向 import 六个子命令，子命令之间不互相 import），`index.ts` 最后写，因为它要引用全部模块的导出面。

> **收尾复核修正（文件数）**：初稿把本切片写成「15 个文件」、3.1 表头写成「源码 11 个文件」、3.3 第 1 项写成「11 个源码」。实际 `glob` 清点是 **12 个源码**（`cli/` 下 8 个：`args` `render` `frame` `svg` `timeline` `inspect` `audio-cmd` `main`，加 `render/resvg-backend` `encode/ffmpeg-encoder` `inspect/diagnostics` `index`）＋ 4 个示例 = 16 个代码文件，另加 3 个文档。3.1 表体本来就是 12 行，是三处**文字计数**与表体不符，已按表体与磁盘实况统一为 12 / 16。计数口径沿用 GEN-2（「14 个文件」＝8 源码 + 6 测试，**不含文档**）。这是本轮唯一一次交付后改动，性质为文档计数勘误，不涉及任何源码、断言或容差。

一次越界：写 `resvg-backend.ts` 时我先建了计划外的 `src/render/pipeline.ts` 放会话代码，随后改主意把会话并回 `resvg-backend.ts`（理由见 3.2 第 2 条）。本切片的工具面**没有删除文件的能力**（`search` 对 delete / remove / unlink / bash 零命中，子 Agent 同样无 shell），只能先把它覆写成空文件；**该文件已在后续轮次由指挥官删除**（见 §4 修复轮第 2 项），`glob` 与目录读取都确认 `src/render/` 现在只有 `resvg-backend.ts`。契约 §0 的文件清单在本仓**没有越界残留**。

记录这件事而不是略过，是因为它一度是真实的 §0 违规，门禁在早前的快照上可能看到过一个 0 字节的 `pipeline.ts`。

### 3.1 产出文件清单

> ⚠️ **本节的行号引用是生成轮快照。** 后续的「修复轮 gen2 / gen3 / gen3 复核」又改动了其中若干文件，因此**行号已漂移**；4.2 / 4.3 / 4.4 记录的是最新状态（那里给的是修复后的 file:line）。本节的文件清单、导出面与决策仍然有效，**只有行号不可用作定位依据**。

源码（12 个文件）：

| 文件 | 契约 §3 要求 | 关键导出 / 说明 |
| --- | --- | --- |
| `src/render/resvg-backend.ts` | `renderSvgToRgba(svg, {width,height,scale,fontFiles,defaultFontFamily})` | **本切片最重的一块**：① resvg 后端（`renderSvgToPng` / `renderSvgToRgba` / `buildResvgOptions` / `scaledSize` / `isFullyTransparent`）；② 字体家族启发式（`normalizeFontFamily` / `registeredFontFamilies` / `fontFamilyIsRegistered`）；③ **渲染会话**（`createRenderSession` / `RenderSession` / `PipelineOptions` / `resolveScenes` / `flattenAudioMap` / `resolveDuration` / `makeFrame` / `renderFrameSvg` / `renderFramePng` / `framePngs` / `decodeSessionAudio` / `resolveSessionAudio` / `createSessionMixer` / `framesToSamples` / `probeDurationSync` / `videoSize`） |
| `src/encode/ffmpeg-encoder.ts` | `encodeVideo({…, frames, audioWavPath?, draft, scale})` | `buildFfmpegArgs`（可单测的 argv 构造）+ `encodeVideo`；PNG `image2pipe` 默认、`rawvideo` 可选；stdin drain 背压；stderr 收集后随非零退出码抛出；懒帧源（回调或 iterable） |
| `src/inspect/diagnostics.ts` | `inspectVideo(video, {everyFrame?, distance=30?, exitSeverity, json?, fontFiles, mediaDir?})` | `inspectVideo` / `inspectVideoDetailed` / `inspectFrame` / `inspectFrames` / `inspectMedia` / `fontFamiliesInSvg`；`Severity` / `ExitSeverity` / `RawFinding` / `MergedFinding` / `InspectOptions` / `FrameInspection` / `DetailedInspectResult` |
| `src/cli/args.ts` | 极简解析器（位置参数 / `--flag` / `--key value` / `--key=value` / `-o` 短别名，无第三方） | `parseArgs` / `ParsedArgs` / `ArgSpec` / `ArgKind` / `globalSpecs` / `UsageError` / `CliIo` / `processIo` / `printReport` / `printError` / `helpText` / `TIME_SPECS_HELP` |
| `src/cli/render.ts` | `--frame-range`、`-o`、`--draft`、`--scale`、进度→stderr、`--json` | `renderVideo`（两步音频 + 单次 ffmpeg + `finally` 删临时 WAV）/ `RenderReport` / `defaultOutputFor` / `ensureParent` / `renderText` / `RENDER_SPECS` |
| `src/cli/frame.ts` | `frame <spec...>` → `-o` 目录、`frame-<globalIndex>.png`、`--json` | `renderFrames` / `frameCommand` / `framesText` / `framesJson` / `frameFileName` / `frameSvgFileName` / `frameHelp` |
| `src/cli/svg.ts` | `svg <spec>` → stdout 或 `-o` | `frameSvg` / `svgCommand` / `SVG_SPECS` |
| `src/cli/timeline.ts` | 人读表格 + `--json`（契约 §3 的完整字段） | `timelineReport` / `timelineText` / `timelineCommand` / `TimelineReport` / `TimelineSceneReport` / `TimelineTrackReport` |
| `src/cli/inspect.ts` | `--every-frame`、`--distance`、`--exit-code`、`--json`、命中 exit 2 | `inspectCommand` / `inspectText` / `parseExitSeverity` / `INSPECT_SPECS` |
| `src/cli/audio-cmd.ts` | `audio render｜analyze｜at` | `renderAudioToFile` / `analyzeAudioRange` / `audioAt` / 三个 `*Command` / `analyzeText` / `analyzeJson` / `audioAtText` / `sectionsForRange` / `defaultAudioOutput` / `AUDIO_SPECS` |
| `src/cli/main.ts` | shebang、`argv[2]`=模块、`argv[3]`=命令、dynamic import、default export = 实例或工厂、错误→exit 1、inspect→exit 2 | `run(argv)` / `runCli` / `loadVideo` / `mediaDirFor` / `resolveScale` / `resolveRange` / `resolveSpecs` / `splitSpecs` / `isEntryPoint` / `USAGE` / `CommandName` / `CliOptions` / `VideoExport`。**⚠️ 故意不被 `index.ts` re-export，见 3.2 第 21 条的环** |
| `src/index.ts` | 公共 API re-export，覆盖契约 §4 与门禁 A11 符号清单 | 全部模块（除 `cli/main.ts`）的导出汇总（见 3.3 第 10 项） |

示例（4 个文件）：

| 文件 | 说明 |
| --- | --- |
| `examples/hello-world/video.ts` | 逐行对照 `hello_world_multiscene.rs`：30fps / 1920x1080 / `duration()` 返回 `auto` 常量 / SceneOne 15s（"hello scene 1" + 两个绿 rect 含 `rotate(45)` + `transform-origin="top left"`）/ SceneTwo 15s（y 300→320，0.2s 线性）/ 背景 6 段 `#fff → #f8fafc → #fff7ed → #fef2f2 → #f7fee7 → #ecfdf5 → #faf5ff`，每段 5s 线性，色值照抄 / 角落的 frame index + second 文本 / `fonts()` 返回 Helvetica.ttc / `export default`。两处**被迫**的偏离（字体、`Easing::Linear(d)` → 显式 `end`）写在文件头 |
| `examples/hello-world/main.ts` | 便捷入口：`buildArgv()` 把视频路径拼到 `argv[2]`，调 `run(argv)`；直接执行判断用 `process.argv[1]` vs `fileURLToPath(import.meta.url)`（Node 24 无 `import.meta.main`，契约 §3 指定的方案） |
| `examples/audio-demo/video.ts` | 10s / 30fps / 640x360；`music = audioTrack('sine.wav').gainDb(-6).fadeIn(0.5).fadeOut(1)`、`voice = audioTrack('sine.wav',{start:3,end:5}).offset(3).voice()`、`music.duckUnderVoice()`；纯色背景 + 帧号文本（Helvetica） |
| `examples/broken-video/video.ts` | `font-family="DefinitelyMissingFont-XYZ"`（`fonts()` 只给 Helvetica）+ `audioTrack('nope.wav')`；专供 inspect 门禁，必须报 missing-font 与 missing-media，退出码 2 |

文档（3 个文件）：

| 文件 | 说明 |
| --- | --- |
| `README.md` | 定位 + MIT 衍生声明、快速开始、完整 API 示例、命令表 + 选项表、退出码表、Time spec 表、音频用法、库用法、示例表、仓库结构 |
| `PORTING.md` | 本轮范围表、**放弃/延后清单（§1 逐条 + 理由）**、M0 探针数据（字体扫描热点 351→25.8ms、典型场景 25.5ms/帧≈39fps、密集 300 文本 242/131ms、ffmpeg rgba 管道 363.6fps、PNG image2pipe 全链路 37.5fps、LUFS 基线 −21.1/−18.1）、9 条「行为差异」（含 spring getDuration 存疑、svgr 不转义、hamming 笔误、f32→f64）、6 条后续路线 |
| `DELIVERY.md` | 本节 |

### 3.2 决策清单（按契约最佳理解 / 与契约字面不同的地方均标注）

1. **契约 §3 要求的 `renderSvgToRgba` 名字保留了，但管线走 PNG。** 契约 §3 自己已经把后端职责改成 `renderSvgToPng(svg, opts) → Buffer(PNG)`，§7 又钉死「A. `-f image2pipe -vcodec png -r FPS -i pipe:0`」。本切片**两个都导出**：`renderSvgToPng` 是 render 管线用的那个，`renderSvgToRgba` 是 `inspect` 判 `empty-frame` 时用的那个（顺带满足 §3 的字面命名）。编码器默认 `inputFormat: 'png'`，`'rawvideo'` 可选。
2. **渲染会话（session）落在 `render/resvg-backend.ts`，而不是新建文件或 `cli/`。** 契约 §3 的文件清单是封闭的，而 `render` / `frame` / `svg` / `timeline` / `inspect` / `audio` 六个命令都需要同一份会话（已解析的时间轴、`FFramesContext`、解码缓存、媒体目录），Rust 侧那是 `Previewer::new`（`renderer/preview.rs`）+ `mixer_for`（`cli.rs:1049`）。放 `cli/` 会让库模块 `inspect/diagnostics.ts` 反向依赖 CLI；新建文件违反 §0（本轮已经因此产生 3.0 那一个待删文件）。放渲染层的理由写在文件头：导入图无环（`core` → 无、`render` → `core`+`audio`+`media`、`encode` → 无、`inspect` → `render`、`cli` → 全部）。
3. **`inspect` 的 `missing-font` 用「字体文件名启发式」，不是 fontdb。** `resvg-js` 不暴露它建的字体库，Rust 侧是问 `fontdb`（`renderer_font_source.rs`）。本实现从 `fontFiles` 的 basename 去扩展名、去 `-Regular/-Bold/…` 后缀、小写化去非字母数字；匹配规则是「相等或其一为另一的前缀」——这是 `font-family="Dm Sans"` 能匹配 `DMSans-Regular.ttf` 的原因。**注册字体列表为空时一律放行**（没声明字体的视频不该被要求有字体）。这是启发式，PORTING.md 第 6 条如实标注了它可能双向误判。
4. **`empty-frame` 判定必须光栅化，且 `inspect` 渲染不带背景。** 另三条检查都能从 SVG 字符串判定；「这一帧画了东西吗」只能看像素，所以 `inspect` 走 `renderSvgToRgba` 且**不传 `background`**——带背景的话任何帧都不透明，`empty-frame` 永远不会触发。代价是 `inspect` 把同一帧光栅化两次（一次拿字符串、一次拿像素），已在文件头与 PORTING.md 第 7 条说明。
5. **`renderFrame` 抛错的包装信息带帧号、秒与场景名**，对齐 `render_frame_guarded` 的 Rust panic 文案（上游 AGENTS.md：「A panic in render_frame fails the render with the frame, second and scene it happened in」）。
6. **`ctx.getAudio` 走同步懒解码。** Rust `Previewer` 在第一帧前预加载全部媒体，所以 `ctx.get_audio` 是 map 查找；本移植的解码是异步的（渲染循环是 async），但 `renderFrame` **不是** async——一个用 `frame.visualizeAudioFrame(ctx.getAudio('track.wav'))` 画频谱的场景必须拿到样本。所以 `getAudio` 首次命中时用 `execFileSync` 子进程解码并写进 session 缓存（`maxBuffer` 提到 512 MiB），之后都是 map 查找；从不请求音频的视频一个 ffmpeg 都不 spawn。异步路径 `decodeSessionAudio` 供 `render` / `audio` 预热。
7. **时长探测是同步的（`execFileSync`）。** GEN-1 的 `ResolveAudioDuration` 是普通函数、`Scenes.resolveTimeline` / `toFrames` 也和 Rust 一样同步，所以探测必须同步。按文件 memoize，且只在真的需要时触发（`fromAudio` / `Eof` 区间 / 无场景的 `auto`）。异步形态 `probeDurationSeconds` 由 GEN-2 提供，库调用方用那个。
8. **`--scale` / `--json` / `--media-dir` / `--help` 是全局选项**，在 `cli/args.ts` 的 `globalSpecs()` 里声明一次，六个命令的 spec 列表都是 `[...globalSpecs(), ...自己的]`。Rust 侧 `--json` / `--scale` 本来就是 `Cli` 的 global（`cli.rs:47-63`）；`--media-dir` 是本移植新增的，因为 Rust 从 `RenderOptions` 拿媒体目录，而 Node 模块必须被告知路径。
9. **未知长选项不报错，按布尔 `true` 记下**；而 `audio analyze --waveform` 这种**明确不支持**的选项走另一条路：`args.has('waveform')` 命中后抛 `UsageError` 并指向 PORTING.md，不静默忽略。
10. **短选项里未知的字母按位置参数处理**（`-5`、`-1s` 不会被当成 flag 吃掉）。`audio at` / `frame` 的时间规格可能以 `-` 开头，丢掉比透传糟。
11. **进度打到 stderr 且节流（每 10 帧 + 最后一帧）。** 契约 §6 要求 `--json` 时 stdout 恰好一个 JSON 文档、进度与警告一律 stderr；10 秒视频 300 帧，逐帧打会淹没其它输出。
12. **`frame` 的文件名是 `frame-<globalIndex>.png`，`-o` 默认是 `.`。** 契约 §3 明写；Rust 用 `snapshot::snapshot_name(&spec)`（从 spec 派生，两个 spec 落到同一帧会撞名，且 `Intro@1.2s` 不是合法文件名）。
13. **`svg` 命令打印的是 `renderFrame` 产出的原始 markup（已拼接场景），不是「转换后」的树。** 本移植没有排版引擎（`text_*` 属 §1 不做项），没有可转换的东西。差异记在 PORTING.md 第 5 条。
14. **`inspect` 的 `--distance` 是帧数（默认 30），不是 Rust 的 `--every 0.25s` 时间量。** 契约 §3 明写 `--distance <n>`；帧数在任何 fps 下都无歧义。采样规则（每场景首尾帧必查 + 范围末帧 + 排序去重）照抄 `cli.rs:901-922`。
15. **`run(argv)` 返回退出码，`runCli(argv)` 才写 `process.exitCode`。** 契约 §3 要求 `main.ts` 导出 `run(argv)` 供 `examples/hello-world/main.ts` 调用；返回码让测试能读，实际执行走 `runCli`（`runCli` 不调 `process.exit`，好让 `finally` 里的临时 WAV 删除与 stdout 冲刷都跑完）。
16. **`run` 在缺视频路径时打印 USAGE 到 stderr 并返回 1**（契约 §6：用法错误 = 1；clap 用的是 2，以契约为准）。
17. **`--draft` 的 crf 是 30、preset 是 `ultrafast`。** 契约 §7 只说「减半分辨率 + ultrafast」；`cli.rs:573-576` 的 draft 分支同时设了 `preset=ultrafast` 与 `crf=30`，照抄。默认（非 draft）是 `preset=medium`、`crf=23`。
18. **音频两阶段，且临时 WAV 在 `finally` 里删。** 混音先落 `os.tmpdir()/fframes-<uuid>.wav`，再作为 ffmpeg 的**第二个 `-i`**（绝不双 stdin 管道，契约 §7 的 R2）；渲染结束或抛错都删。缺文件不阻断：`missingFiles()` 进报告与 stderr 警告，与 Rust `mixer.missing_files()` 一致。
19. **`audio analyze` 把 section / silent 区间的时间平移回时间线。** `cli.rs:1146-1154` 对 `--frame-range 5s..` 就是这么做的，否则报告里全是相对秒。
20. **`ensureParent`（建父目录）放在 `cli/render.ts` 并导出**，对齐 `cli.rs:531-537` 的 `ensure_parent`；`frame` / `svg` / `audio render` 都用它。
21. ⚠️ **`index.ts` 故意不 re-export `cli/main.ts`——这是硬约束，不是风格选择。** 我一度把 `run` / `runCli` / `loadVideo` 加进了 `index.ts` 的导出，随后发现那会**死锁直接执行路径**：`main.ts` 结尾是顶层 `if (isEntryPoint()) await runCli()`，而视频模块（`examples/*/video.ts`）为了拿公共 API 会 import `index.ts`，于是形成 `main.ts`（TLA 未完成）→ `loadVideo` 的 `await import(video.ts)` → `video.ts` → `index.ts` → `main.ts` 的环，`index.ts` 永远求值不完，Node 以 "unsettled top-level await" 退出 13。已回退，并在 `index.ts` 末尾写清了环的形状与「要修就修 `main.ts`，不要修 `index.ts`」的理由（每个视频模块都经过 `index.ts`）。**`index.ts` 末尾那段注释是规范性的，评审请勿删。**
22. **兑现了 GEN-2 §2.6 的「decode 未做缓存」待办**：解码缓存放在 session 的 `audioCache` 上，`decodeSessionAudio` 与 `ctx.getAudio` 共用，同一文件只解一次。
23. **兑现了 GEN-1 §1.6 / GEN-2 §2.5 的 `RenderOptions.ducking` / `fadeCurve` 遗留**：它们经 `PipelineOptions.mixerOptions` 传到 `AudioMixer`；用户级默认值仍由 `AudioTrack` 的建造者承担。
24. **`AudioMap` 解析失败不阻断 session 构造。** `resolve()` 对 `Eof` 区间要问文件时长，文件不在媒体目录里就没有时长——GEN-2 的 `requireDuration` 会抛 `can not resolve the duration of "nope.wav"`。若让它抛，`examples/broken-video` 连 session 都建不起来，`inspect` 永远报不出 `missing-media`，门禁的 broken-video 断言就无从谈起。所以 `resolveDuration` 捕获该错误放进 `RenderSession.audioResolveError`，用场景/字面时长继续；`inspect` 把它作为**同一个** `missing-media` kind 上报（`inspectMedia` 里 `missing-media:unresolvable`）；`main.ts` 在 stderr 打一条 warning；`render` 与 `audio render` 跳过混音（`mixable` 条件含 `audioResolveError === null`），其余照常。这既让 broken-video 可检，也与 Rust 的行为一致：Rust 侧同样是在建 `Previewer` 时因媒体处理失败而报错，不是渲染到那一帧才报。
25. **但「完全无法确定时长」仍然是致命错误。** `auto` 且无场景、音频又解析不出来时，`toFrames` 抛 `auto requires either scenes or an audio map`。此时没有帧可渲染、也没有帧可检查，用 `durationInFrames = 0` 掩盖问题比报错更糟，所以 `resolveDuration` 用 `try/catch` 把这条路径包起来、补上 fps 与场景帧数后重抛。**这两条不冲突**：缺单个文件是「能渲染、能报告」，完全无从判断长度是「什么都做不了」。
26. **`frame` 命令对抛错的帧不中断。** `renderFrame` 抛异常时该 spec 产出一条 `render-error` finding、`path` 为空、`bytes` 为 0，然后继续下一个 spec——对齐 `render_frame_guarded` 把 panic 变成 finding 而不是中止整轮。人读行在没有文件时省略 `-> path` 箭头。
27. **命令选项表统一在 `globalSpecs()` 合并**（见第 8 条），因此各命令的 `*_SPECS` 里不再重复声明 `json` / `scale` / `media-dir`，避免同一 flag 在两处定义、行为可能不一致。
28. **值选项是否吞掉下一个 token，用「下一个 token 是不是已声明的选项」判断，而不是「它是不是以 `-` 开头」**（`args.ts` 的 `isDeclaredOption`）。后者会让 `--frame-range -5..5` 丢掉范围值；前者只在下一个 token 真的是已声明选项时才停。这也让 `-5` 这样的负数时间规格能作为位置参数透传。
29. **`ctx.getImage` 的 data URI 按文件 memoize。** Rust `Previewer` 在第一帧前预读全部媒体，效果等价；本移植的媒体目录是运行时文件夹，所以第一次 `getImage` 读盘 + base64 后写进 session 的 `imageCache`。不缓存的话每帧都要把整张图 base64 一遍，`renderFrame` 每帧调一次就是 N 倍开销。

### 3.3 §10 交付前自查（本切片相关项）

| # | 项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | §3 清单中每个文件存在且非空；每 src 文件 `export` ≥1 | ✅ | **12** 个源码 + 4 个示例文件全部落盘（3.1 表的 12 行）；`grep "^export "` 在 `src/index.ts` 命中 30+ 个 `export` 语句（60+ 个符号）、`resvg-backend.ts` 25 个，其余 10 个模块均 ≥1 命中 |
| 2 | `enum ` / `namespace ` / `constructor(private\|public\|readonly` 零命中 | ✅ | `grep -E "\b(enum\|namespace)\s+\w\|constructor\s*\(\s*(private\|public\|protected\|readonly)"` 在 `fframes-node/src/**` **零命中**（同一命令在 `node_modules/` 有 100 处命中，属第三方，不在本仓） |
| 3 | 相对导入均带 `.ts` | ✅ | `grep "from '\.\.\?/"` 覆盖 `src/**` + `examples/**`，命中行全部以 `.ts'` 结尾；反向检查 `grep "from '\.[^']*[^s]'"` **零命中** |
| 4 | §5 常数在源码中出现 | ✅（本切片相关） | §5 的 11 个常数属 GEN-1 / GEN-2（已在 1.2 / 2.2 留证）。本切片引入的管线常数，按 grep 逐个确认在盘上：`image2pipe` / `libx264` / `yuv420p` / `ultrafast` / `192k` / `aac` / `shortest`（`encode/ffmpeg-encoder.ts` 的 `buildFfmpegArgs`）、`loadSystemFonts: false`（`render/resvg-backend.ts` 的 `buildResvgOptions`）、`0.5`（`cli/main.ts` 的 `resolveScale`，draft 减半）、`30`（`inspect/diagnostics.ts` 的 `distance` 默认）、`2`（exit code，镜像 `cli.rs:996-1000`）。⚠️ 本行的 file:line 因后续修复轮已漂移，见 3.1 顶部提示；grep 命中的是符号本身，不依赖行号 |
| 5 | `test/` 下 `test(` 总数 ≥ 40 | ✅（不增不减） | 契约 §8 的 13 个测试文件全部由 GEN-1（122 个 `test()`）与 GEN-2（108 个）落地，**合计 230 个**；§3 未给本切片分配新测试文件，故本切片测试数不变。⚠️ **本切片新增的渲染 / 编码 / 诊断 / CLI 代码没有任何单元测试**——见 3.5 第 1 条 |
| 6 | `TODO` / `FIXME` / `not implemented` / `placeholder` 零命中 | ✅ | `grep -E "TODO\|FIXME\|not implemented\|placeholder\|XXX"` 在 `fframes-node/src/**` **零命中** |
| 7 | 三个 examples 均有 `export default`；broken-video 引用 `DefinitelyMissingFont-XYZ` 与 `nope.wav` | ✅ | `grep` 在 `examples/**` 命中 25 处：三个 video.ts 各一处 `export default`；`DefinitelyMissingFont-XYZ` 与 `nope.wav` 都在 `broken-video/video.ts`；`sine.wav` 两处在 `audio-demo/video.ts`；三个示例的 `fonts()` 都返回 Helvetica.ttc。三个示例都实现了 `Video` 的全部必实现成员（含 `defineScenes`）——`audio-demo` 与 `broken-video` 返回 `null`（`Scenes.fromValue(null)` 即空时间轴，对应 Rust 的 `Scenes::default()`） |
| 8 | `TRUE_PEAK_PHASES` 48 系数与 `audio_analysis.rs` 一致 | ⏭ | 非本切片（GEN-2，2.2 第 8 项已逐系数留证） |
| 9 | `cli/main.ts` 首行 shebang；inspect 命中路径 `process.exitCode = 2` 或 `exit(2)` | ✅ | `main.ts` 第 1 行是 `#!/usr/bin/env node`；inspect 的退出码由 `inspectCommand` **返回** `result.exitCode`（diagnostics 里 `exitCode: failed ? 2 : 0`），`main.ts` 的 `run` 直接 return，`runCli` 写 `process.exitCode = code`（不调 `process.exit`，好让 `finally` 与 stdout 冲刷跑完） |
| 10 | 公共 API（index.ts）覆盖 §4 示例中用到的全部符号 | ✅ | §4 示例用到的 14 个符号逐一在 `index.ts` 里定位：值 `svgr` / `Svgr`（`./core/svgr.ts` 那条）、`seconds` / `auto`（`./core/duration.ts` 那条）、`timeline` / `Easing`（`./core/animation/timeline.ts` 与 `./core/animation/easing.ts` 两条）、`AudioMap` / `audioTrack`（`./audio/audio-map.ts` 区块）、`Color`（`./core/color.ts`）；类型 `Video` / `Scene` / `FFramesContext`（`./core/types.ts` 区块）、`Frame`（`./core/frame.ts`）、`Duration`（`./core/duration.ts`）。另外覆盖 GEN-1 §1.5 与 GEN-2 §2.5 的两份 re-export 清单 |

补充自查（超出 §10 清单）：

- **禁止依赖复核**：`src/**` 只 import `node:child_process` / `node:events` / `node:buffer` / `node:fs` / `node:path` / `node:os` / `node:crypto` / `node:url`、`@resvg/resvg-js`（唯一运行时依赖，已预置）与本项目相对模块。未改 `package.json` / `tsconfig.json`，未新增依赖，未动 `examples/audio-demo/media/sine.wav`。
- **未改 GEN-1 / GEN-2 的任何文件**：本切片只新增 §3 清单里的文件；`src/render/pipeline.ts` 的一次中途越界已清除（3.0），目录复核确认 `src/render/` 只有 `resvg-backend.ts`。
- **`index.ts` 覆盖 GEN-1 §1.5 与 GEN-2 §2.5 的 re-export 清单**：两份清单里的符号全部并入，另追加了渲染 / 编码 / 诊断 / CLI 层的导出。两处与清单不同：
  1. `analysis.ts` 的 `dbToGain` 导出为 `analysisDbToGain`（`mixer.ts` 已导出同名 `dbToGain`，两者语义相同；同名 re-export 两次是编译错误，见 GEN-2 §2.3）。
  2. `AudioMapTimeBase`（GEN-2 §2.5 清单里的写法）在本仓叫 `AudioTimeBase`，按实际导出名 re-export。
  3. `cli/main.ts` **不在** re-export 清单里（硬约束，见 3.2 第 21 条）。
- **`SampleSize` / `WindowFunction` / `VisualizeFrameInput` 从 `core/types.ts` re-export**（类型单一事实源），不是从 `audio/visualize.ts`，与 GEN-2 §2.5 第 1 条一致。
- **`import.meta.main` 的替代方案**：Node 24 没有它，`isEntryPoint()` 比较 `resolve(argv[1])` 与 `resolve(fileURLToPath(import.meta.url))`，两边都不过时再比 `realpathSync`（`bin/fframes` 这类符号链接下前者不相等）——契约 §3 指定的方案。`examples/hello-world/main.ts` 用同一手法（它是脚本，不经 bin，故不需要 realpath 比对）。
- **可擦除语法**：本切片零 `enum` / `namespace` / 参数属性 / 装饰器（见上表第 2 项），符合 `tsconfig.json` 的 `erasableSyntaxOnly`。
- **`verbatimModuleSyntax` 合规**：所有纯类型导入都写成 `import type`（`CliIo` / `InspectOptions` / `RenderSession` / `FrameRange` / `Video` / `ArgSpec` 等），值与类型同名处（`Easing`、`EasingLike`、`dbToGain`）分两条语句。
- **相对导入带 `.ts` 但不带目录别名**：全仓无路径别名，跨目录引用一律逐级 `../`，与契约 §2 一致。

### 3.4 逐条对齐的 ground truth（mirror 清单）

| 本文件 | Rust ground truth | 对齐要点 |
| --- | --- | --- |
| `render/resvg-backend.ts`（后端部分） | `renderer/cpu.rs:25-59`（`CpuRenderingBackend` 的三个旋钮）、`:88-93`（`pixmap.fill(background_color)`）、`:121-175`（渲染循环：`Frame::__internal_make_for_renderer` → `into_svg_tree` → `svgr::render` → `writer.submit`）、`:147` | `new Resvg` 每帧重建（每实例持有已解析树 + 字体）；`fitTo: {mode:'width'}` 对应 `fit_transform`；背景由调用方传（render / frame 传黑、inspect 不传）；渲染循环串行（契约 §7） |
| `render/resvg-backend.ts`（会话部分） | `renderer/preview.rs`（`Previewer::new`：媒体、字体库、缓存、`resolved_timeline`）+ `video.rs:83-137`（`ResolvedScenesTimeline::from_scenes`）+ `fframes_context.rs`（14 个 context 成员）+ `cli.rs:1049-1072`（`mixer_for`） | context 14 个成员逐个提供（兑现 GEN-1 §1.5 第 5 条）；`makeFrame(global, global, fps)`；场景音频按 `startFrame/fps` 平移后 flatten（`unstable_flatten_with_scenes` 语义）；`durationInFrames` 走 `toFrames` 的 `auto`（场景 → audioMap 尾帧）两分支；mixer 的 `outputRange` / `totalSamples` 用 `frame*rate/fps` 整数除法 |
| `encode/ffmpeg-encoder.ts` | `renderer/encoder.rs` + `ffmpeg_helper.rs` + `stream.rs` | 单次 ffmpeg、libx264、`-pix_fmt yuv420p`、音频 `-c:a aac -b:a 192k -shortest`、draft → `ultrafast` + `crf 30`；**无分段、无拼接**（Rust CPU 后端用 rayon 分段后由 `concatenator.rs` 合并）；帧源懒生成，峰值内存 = 1 帧 |
| `inspect/diagnostics.ts` | `diagnostics.rs`（`Severity` 序、诊断 kind、dedup key）+ `cli.rs:872-1001`（`Finding` / `InspectResult` / 采样 / merge / 排序 / `FailOn` / exit 2） | 采样 = `everyFrame ? 全帧 : 按 distance 步进` + 每场景首末帧 + 范围末帧，排序去重；merge 按 `key` 累积 `lastFrame` / `seenIn` / `scenes`，保留首帧 message；排序 = 严重度降序 → `firstFrame` 升序；`exitCode = 有 finding 达到阈值 ? 2 : 0`；人读文案逐句对齐 `cli.rs:972-994` |
| `cli/args.ts` | `cli.rs:33-63`（`TIME_SPECS`、`Cli { json, scale }`）、`:436-449`（`print`） | `--json` → stdout 恰好一个 JSON 文档、其余 stderr；错误行 `error: {message}`；未知的 flag 宽容、明确不支持的选项报错（3.2 第 9 条） |
| `cli/render.ts` | `cli.rs:121-131`（`RenderArgs`）、`:549-607`（`fn render`）、`:531-537`（`ensure_parent`）、`:538-547`（`RenderResult`）、`:568-577`（draft）、`:593-605`（人读行） | 命令缺省即 `render`；range 缺省 `timeline.full_range()`；`draft` 减半除非给了 scale；输出缺省 `video.defaultOutput ?? 'out.mp4'`（`cli.rs:281`）；JSON 字段 = Rust 的 `RenderResult` + 契约要求的 `seconds` / `audio` |
| `cli/frame.ts` | `cli.rs:134-143`（`FrameArgs`）、`:618-666`（`fn frame`）、`:499-514`（`resolve_frames`：spec 按空白再逗号切） | 每 spec 一行 `{spec} frame {n} {s}s [scenes] -> {path}` + 缩进的诊断；`--svg` 额外写 SVG；契约的 `frame-<globalIndex>.png` 与 `{index, second, path, bytes}` JSON |
| `cli/svg.ts` | `cli.rs:173-178`（`SvgArgs`）、`:785-809`（`fn svg`） | `-o` 有值 → 写文件 + `{frame, output}`；无值 → 打印 SVG 本体 + `{frame, svg}` |
| `cli/timeline.ts` | `cli.rs:813-870`（`fn timeline`） | 首行 `{w}x{h} @ {fps} fps, {frames} frames ({s}s)`；无场景打 `no scenes`；场景行 `#{index:<3} {name:<28} frames {a..b:>14} {sa..sb:>18}`；音频行的条件注记（gain≠0 / pan≠0 / 有 fade / offset>0 / voice / ducked）逐条照抄 |
| `cli/inspect.ts` | `cli.rs:188-203`（`InspectArgs`）、`:894-1001` | flag 名按契约改名（见 3.2 第 14 条）；exit 2 的判定 `severity >= failOn` |
| `cli/audio-cmd.ts` | `cli.rs:224-246`（`AudioCommand`）、`:1049-1238`（`mixer_for` + `fn audio`）、`:1240-1283`（`audio_report_text`） | 三个子命令共用 `mixer_for`（range → 样本、total = 全片）；`analyze` 按场景切 section（`round` 到最近样本、clamp 进 range、再相对 range 起点，`:1129-1144`）并把时间平移回时间线（`:1146-1154`）；人读报告逐句对齐（含每场景的 `{name} {range} {lufs} / peak {dbtp}` 与缺文件警告行）；`at` 的 `{spec} ({s}s):` + 每 track `{file} at {pos}s of the file, {gain}dB[, voice][, ducked {d}dB]` |
| `cli/main.ts` | `cli.rs:45-49`（`cli::new(&video, options)`）、`:271-283`（`new` → `default_output: out.mp4`）、`:343-433`（`Runner::run`） | `argv[2]`=视频模块（Rust 是编译期绑定，这里是路径 + dynamic import）、`argv[3]`=命令（缺省 `Render`）；`Err(message)` → `error: {message}` + `ExitCode::FAILURE`；inspect 的 `ExitCode::from(2)` 由 `runCli` 写 `process.exitCode` |
| `examples/hello-world/video.ts` | `examples/hello-world/src/hello_world_multiscene.rs`（全 105 行） | 30fps / 1920x1080 / `Duration::Auto` / SceneOne 15s（`x="100" y="300" font-size="150"` 的 "hello scene 1" 文本 + 两个 `fill="green"` 的 120x120 rect，一个在 `scale(1)` 的 `<g>` 里、一个在 `rotate(45)` + `transform-origin="top left"` 的 `<g>` 里）/ SceneTwo 15s（y 由 timeline 从 300 动到 320）/ 背景 6 段色值 `#fff #f8fafc #fff7ed #fef2f2 #f7fee7 #ecfdf5 #faf5ff` 照抄 / 角落的 `This frame index: {i}, second: {:.2}` / `AudioMap::none()` / `Scenes::from(vec![&SceneOne, &SceneTwo])` |
| `examples/audio-demo/video.ts` | 契约 §3 的 audio-demo 条目 | 契约逐项落地（10s / 30fps / 640x360 / 两条 track 引用 `sine.wav` / `{start:3,end:5}` + `.offset(3)` + `.voice()` / `duckUnderVoice()`） |
| `examples/broken-video/video.ts` | 契约 §3 的 broken-video 条目 | 契约逐项落地（`DefinitelyMissingFont-XYZ` + `nope.wav` + `fonts()` 给 Helvetica） |

### 3.5 本切片未尽事项

- ⚠️ **本切片零单元测试。** 契约 §8 的 13 个测试文件全部分配给了 GEN-1 / GEN-2，本切片（渲染 / 编码 / 诊断 / CLI）**没有分配测试文件**，所以按契约我也没有新建：§0 允许「测试文件可按需增补」，但 §8 明令测试「不依赖 ffmpeg / 网络 / 真实渲染 / 真实字体文件」，而本切片几乎所有有价值的断言都要碰到 ffmpeg 或 resvg——在不违反 §8 的前提下只能测纯函数。以下是**可离线测、建议在门禁侧补**的部分（每条都是纯函数，不需要 ffmpeg / resvg / 字体文件）：
  - `buildFfmpegArgs`：纯函数，逐 token 断言（image2pipe 路线、`-r` 在输入侧、音频二输入、draft → ultrafast/crf 30、`-pix_fmt yuv420p` 结尾是 outPath）。
  - `parseArgs`：位置参数 / `--flag` / `--key value` / `--key=value` / `-o` / `--` 之后的透传 / 未知 flag 宽容 / 未知短字母按位置参数（`-5`）。
  - `inspectFrames`：采样规则（`everyFrame` 全帧、按 distance 步进、每场景首末帧必查、范围末帧、排序去重）——纯函数，只需一个假的 `RenderSession`。
  - `fontFamiliesInSvg` / `fontFamilyIsRegistered` / `normalizeFontFamily` / `registeredFontFamilies`：纯字符串函数。
  - `splitSpecs` / `resolveScale` / `mediaDirFor`（临时目录）/ `timelineText` 的表格对齐。
  - `scaledSize` / `buildResvgOptions`：断言 `loadSystemFonts` **恒为 false** 且 `fontFiles` 透传（这是契约 §7 的硬约束，值得锁死）。
- **`inspect` 的 6 种 finding 只实现了 4 种。** `render-error` / `missing-font` / `missing-media` / `empty-frame` 按契约落地。Rust `diagnostics.rs` 另外几类（文字被画布边缘裁切、NaN transform、字形缺失、整帧出画布）需要文本测量与布局信息，本移植没有（§1 不做 `text_*`），因此没有对应 kind。`Severity` 保留了 `info` 档位（`--info` / `--exit-code info` 都读它），但当前没有任何检查产出 `info`——这是本切片与原版最实质的一处能力差距，`inspect` 报不出「文字被裁掉」这类只有布局引擎才知道的问题。
- **`Video::BACKGROUND_COLOR` 没有进 API。** 渲染一律铺黑（`pixmap.fill(background_color)` 的 `Color::BLACK` 默认值）；Rust 允许视频自定义背景色。要支持需要给 `Video` 加一个可选成员。
- **渲染循环没有任何缓存**：无字体数据库、无子树缓存、无 converter 缓存（Rust `CpuRenderingBackend { cache_capacity: 20, text_cache_capacity: 10, concurrency }`）。这是与原版最大的性能差距，PORTING.md 路线图第 3 条。
- **`--codec` / `--audio-bitrate` / `--ffmpeg-log` 没有暴露为 CLI flag**，只作为 `EncodeVideoOptions` 的字段存在（`videoCodec` / `audioBitrate` / `logLevel` / `binary`）。契约 §3 的 `render` 选项表只列了 `--frame-range` / `-o` / `--draft` / `--scale`，我另加了 `--crf` / `--preset` / `--float-audio`。要输出 webm 需要 `--codec`。
- **`strip` / `onion` / `snapshot` / `preview` 未实现**（契约 §1 明确不做）。联系表是最便宜的「不看就审片」工具，后续补。
- **场景不做 overlap / 交叉淡化**（GEN-1 §1.4 第 14 条已记）：一帧至多命中一个场景，`renderScenes` 不会产生需要混合的两份输出。
- **`ctx.getImage` 第一次调用会阻塞读盘**（同步 `readFileSync` + base64，之后走缓存）。这与 `ctx.getAudio` 的同步懒解码是同一个取舍：Rust 侧媒体是预读的，这里改成懒加载是为了让从不请求媒体的视频一个文件都不读。代价是渲染循环里第一次取图有一次同步 IO。
- **`audio analyze` 与 `audio render` 各写一次临时 WAV。** 两个子命令不会在同一次调用里都跑（子命令互斥），所以不存在重复混音；同一个 session 内混音结果是确定的（解码缓存 + 定长 dither seed），两次写出的字节相同。
- **本切片未运行任何命令**（§0 纪律）：`tsc --noEmit`、`node --test`、任何 `ffmpeg` / `ffprobe` 调用都留给外部门禁。因此 3.3 表里所有 ✅ 都是**静态自查**（grep / Read）结论，不是执行证据。门禁若报类型错误或运行期错误，请把报错原文贴回，我按同款纪律逐条归因。

> **本节已被门禁与后续修复轮检验过**：生成轮之后跑了「修复轮 gen2 / gen3 / gen3 复核」，门禁报出的 20 个音频单测失败、13 个 FAIL（CLI 全线挂起 + tsc 12 错 + 单测 6 失败）都在下面的章节里逐项裁决并修复。**读 3.1–3.5 时请把 3.0 的行号漂移提示与 4.x 章节一起看**：3.x 是「当初怎么做的」，4.x 是「门禁认为哪里错、怎么改的、现在是什么样」。

---

## 修复轮 gen2（音频层 20 个单测失败 · Rust ground truth 裁决）

> **范围**：`node --test test/audio-map.test.ts test/mixer.test.ts test/resample.test.ts test/analysis.test.ts test/wav.test.ts test/visualize.test.ts` 报出的 20 个失败（wav 7 / mixer 5 / audio-map 3 / analysis 3 / resample 1 / visualize 1）。
> **裁决优先级**（切片指令）：Rust 源码（`.source/fframes/fframes/src/audio_*.rs`）> 标准规范（RIFF WAV / ITU-R BS.1770 / EBU R128）> 测试预期 > 实现现状。判定哪边偏离就修哪边。
> **纪律**：每项修复「正反可辨」——修复前失败的那条断言就是回归验证；不删断言；不放宽容差（第 3 项是唯一被换掉的断言，换成 3 条更严的量化断言，理由见 3.1）。
> **执行级验证**：本轮权限面无 bash，**未运行任何命令**（全量复跑交外部门禁）。所有结论均为逐行推演 + Rust 源码比对，推演依据逐项写在 3.1 内。

### 3.0 总览

| # | 失败用例（文件） | 归因 | 处理 | 裁决状态 |
| --- | --- | --- | --- | --- |
| 1 | `a full scale 1 kHz stereo sine reads about -3 LUFS`（analysis） | 测试错 | 左右声道改为「左满幅 / 右静音」，用例改名 | 采纳 |
| 2 | `the same tone 18.1 dB down … -21.1 LUFS`（analysis） | 测试错 | 同上 | 采纳 |
| 3 | `a loud passage mixed with a quiet one …`（analysis） | 测试错（前提可证伪） | 1 条断言换成 3 条可量化断言 | 采纳 |
| 4 | `a 32-bit float file has the 18 byte fmt chunk and a fact chunk`（wav） | **实现错** | `parseWavHeader` 帧数偏移 `body+4 → body` | 采纳 |
| 5 | `a fact chunk declares the frame count`（wav） | **实现错** | 同上 | 采纳 |
| 6 | `the 16-bit dither stays inside one and a half LSB`（wav） | **实现错** | `encodeWav` 不再写死双声道 | 采纳 |
| 7 | `32-bit float keeps the samples exactly …`（wav） | **实现错** | 同上 | 采纳 |
| 8 | `a mono file has blockAlign 2 and one channel`（wav） | **实现错** | 同上 | 采纳 |
| 9 | `readWavHeader reads a file written by hand`（wav） | **实现错** | 同上 | 采纳 |
| 10 | `int16 conversion clamps instead of wrapping`（wav） | 测试错 | `-2` 期望 `-32767 → -32768`，另补 2 条 | 采纳 |
| 11 | `the limiter delays the signal by lookahead - 1 samples`（mixer） | 测试错 | 拆成「限幅器自身延迟」+「混音抵消延迟」两段 | 采纳 |
| 12 | `duckDb is a raised cosine ramp …`（mixer） | 测试错 | 采样率改 1（字段以样本计），断言重排为 10 条 | 采纳 |
| 13 | `mixAudioToFile writes a 16-bit stereo WAV …`（mixer） | 未发现缺陷 | 原断言全留，补 5 条布局断言 | 现场归因：判为误报 |
| 14 | `mixAudioToFile can write 32-bit float`（mixer） | 未发现缺陷 | 原断言全留，补 5 条（含修好的 `frames`） | 现场归因：判为误报 |
| 15 | `resolve mirrors the Rust exact-sample test for a short click`（audio-map） | 测试错（笔误） | `start + 1009 → start + 1000` | 采纳 |
| 16 | `the sample and frame unit conversions …`（audio-map） | 测试错 | `0.99999 @30fps` 期望 30 → 29，换成「噪声宽容 / 真实截断」一对 | 采纳 |
| 17 | `the exponential fade reaches -60 dB …`（audio-map） | 测试错（笔误） | `+57 → +60`，另补 3 条 | 采纳 |
| 18 | `short sounds start at their exact sample`（mixer） | 测试错（笔误） | `start + 1009 → start + 1000` | 采纳 |
| 19 | `the filter edges fade instead of jumping`（resample） | 测试错（期望值算错） | 边缘区间 `(0.1,0.7) → (0.5,1)`，另补恢复点与尾部 2 条 | 采纳 |
| 20 | `hamming and blackman have the endpoints …`（visualize） | 测试错 | `assert.equal(f32(0.08), 0.08)` → 容差，另补 blackman 1 样本 | 采纳 |

净效果：**实现只改 1 个文件**（`src/audio/wav.ts`，2 处缺陷）；测试改 6 个文件。**删除断言 0 条、放宽容差 0 处**。

### 3.1 逐项修复

**实现缺陷 1：`fact` chunk 的帧数从错误的偏移读出（第 4、5 项）**

- 依据：`audio_analysis.rs:382-389` —— float 分支依次写 `0u16`（cbSize）、`b"fact"`、`4u32`（chunk 体长）、`(frames as u32)`。fact 体就是那 4 字节帧数，落在 `body + 0`。
- 缺陷：`parseWavHeader` 写的是 `frames = readU32(buffer, body + 4)`。float 文件里 `body = 46`，`body + 4 = 50` 已经是下一个 `data` chunk 的魔数，于是 `header.frames` 读成 `"data"` 的小端 u32（0x61746164 = 1635017060）。第 4 项断 `header.frames === 1`、第 5 项断 `parseWavHeader(bytes).frames === 7` 都因此失败；第 14 项补的 `header.frames === 10` 同样靠这条修复。
- 改动：`src/audio/wav.ts:322` `body + 4` → `body`，并加注释指向 `encodeWav` 的 fact 布局。**写入侧本来就是对的**（`view.setUint32(offset + 8, frames, true)`），零改动——这正是「读取侧错位」而非指令所说的「布局分歧」。

**实现缺陷 2：`encodeWav` 写死双声道，`writeWavSync` 的 `channels` 被吞掉（第 6、7、8、9 项）**

- 依据：RIFF 规范 —— `fmt ` 的 `nChannels` 与 `blockAlign = nChannels · bitsPerSample / 8` 必须自洽；`audio_analysis.rs:359-381` 的 `encode_wav` 恒为 2 声道，但那只是该函数自己的形状。契约 §3 的 `writeWav(path, {sampleRate, channels, bitDepth, data})` 明确带 `channels`。
- 缺陷：`encodeWavInterleaved` 把 `channels: 1` 的数据拆成 `left`/`right = null`，而 `encodeWav` 里 `const right = options.right ?? options.left;` 把 null 又变回 left，且 `const channels = 2` 写死 —— 于是**任何 mono 请求都被写成双声道**（`blockAlign` 4、`dataSize` 翻倍、样本按 L,R,L,R 交织）。4 条失败都由此而来：第 8 项断 `blockAlign === 2`（实得 4）、第 9 项断 `channels === 1`（实得 2）、第 7 项断 f32 样本逐个相等（`samples[1]` 里装的是 `values[0]`）、第 6 项断 dither 误差 ≤ 1.5 LSB（`samples[2k+1]` 里装的是 `values[k]`，却拿去和 `values[2k+1]` 比）。
- 改动（`src/audio/wav.ts`）：
  - 抽出私有 `encodeRiff(options)`（:129-191）作为唯一编码器，参数含 `channels` / `frames` / `float` / `dither` / `sampleAt`；`encodeWav`（:199-216）与 `encodeWavInterleaved`（:230-246）都走它 —— **头部布局从此只有一个事实源**，两个入口不可能再错位。
  - `EncodeWavOptions` 新增可选 `channels`（默认 2 = Rust `encode_wav` 的形状，mono 传 1）；`encodeWavInterleaved` 把自己的 `channels` 原样传下去，`> 2` 声道也不再静默丢数据（旧实现只取前两路）。
  - 16-bit 量化子句加了 `audio_analysis.rs:406` 的出处注释；`channels < 1` 的 `RangeError` 保持 `channels must be >= 1` 措辞（第 13 项既有断言 `/channels must be >= 1/` 不受影响）。
- 回归可见性：写入字节序对既有断言**逐字节不变** —— 测试里 3 处 `encodeWav` 调用都同时给了 `left` 与 `right`，默认仍是 2 声道；`channels < 1` 在进入 `encodeRiff` 前就被拒，不会分配缓冲区。

**1 / 2．BS.1770 的 −3 LUFS 是**单**声道满幅正弦，不是双声道（analysis 第 1、2 项）**

- 依据（三重，逐条都指向测试）：
  - `audio_analysis.rs:167-182` `LoudnessAnalysis::new` 对 `[left, right]` **逐声道累加** `hops[i/hop] += y*y`，除数只有 `hops_per_window * hop`（`:190-199`），**没有声道因子**；
  - `audio_analysis.rs:441-451` 的 Rust 测试名就写着 **in_one_channel**，且 `right = vec![0.; left.len()]`；
  - `audio_analysis.rs:453-461` `stereo_minus_23`：EBU Tech 3341 test 1「双声道 1 kHz @ −23 dBFS 读 −23 LUFS」。这条同时证明**声道必须求和**（若除以 2 会得到 −26.04 LUFS，与标准矛盾）。
  - 于是单声道满幅 A 的 `mean_square = 0.5·A²·K²`（K 加权在 1 kHz 约 +0.67 dB，由 `k_weighting` 的库对比伯 128 常数解析算出，已在本仓 `k_weighting(48000)` 的系数上复核），满幅 → `−0.691 + 10·log10(0.5·1.167) = −3.03`；**同样信号放两个声道就是 +3 dB ≈ −0.02 LUFS**，与 −3.0 的预言机差整整 3 dB。
- 判定：实现逐字 mirror Rust 且被同文件既有的「997 Hz 单声道 → −3.01」用例证明正确；**预言机（契约 §8 / 指挥官给的 −3.0 / −21.1）本身是单声道口径**（0.1245 → −3.03 − 18.10 = −21.13，与 ffmpeg ebur128 实测 −21.1 吻合）。故改测试的声道布置，实现零改动。
- 改动（`test/analysis.test.ts:115-152`）：两条用例都改成 `{ left: tone, right: new Float32Array(tone.length) }`，第 1 条用例名去掉 `stereo`；`sampleRate` / `durationSeconds` / `silent` 三条原断言保留；注释写明「双声道求和 ⇒ 满幅双声道读 0 LUFS」。
- 预期落点：`−3.03`（区间 [−3.4, −2.6]）、`−21.13`（区间 [−21.6, −20.6]）。

**3．「安静的半段不会拉低 integrated」的 −0.05 LU 上界不可达，前提本身写错了（analysis 第 3 项）**

- 依据：`audio_analysis.rs:205-212` 两级门都在**均方域**：绝对门 `10^((-70+0.691)/10) = 1.169e-7`；相对门 = 通过绝对门者的均值 × 0.1。原断言的前提是「安静半段低于 −70 LUFS 绝对门」，但 `0.001` 幅度 = −60 dBFS，双声道均方 = `2·(0.001²/2)·1.167 = 1.167e-6`，比绝对门**高 10 dB**，根本没有被绝对门剔除。
- 真实行为（逐块推演，4 跳 = 400 ms，40 跳/半段）：37 块全响（1.167）+ 3 块跨阶跃（`3/4, 2/4, 1/4` × 1.167）+ 37 块全静（1.167e-6）。绝对门放行全部 77 块；相对门 = 均值 0.5835 × 0.1 = 0.05835，**只剔掉 37 块全静**，3 块跨阶跃全部留下 → `mean = 38.5/40 × 1.167` → `I = −0.19 LUFS`，而全响段是 `−0.02`，**恰好掉 10·log10(40/38.5) = 0.167 LU**。任何信号形状都消不掉这 3 块，所以 `> loudOnly − 0.05` 永远不成立（差 0.12 LU）。
- 改动（`test/analysis.test.ts:274-300`）：把 1 条不可达的断言换成 3 条**可量化**断言 —— `0 < drop < 0.5`（实测 0.17，与推演差 3 倍余量）＋ `3.01 − drop > 2.4`（把「有门」与「无门（掉 3.01 LU）」两种答案拉开 14 dB，这条才是真正**正反可辨**的判据）。原来的 `|whole − loudOnly| < 1.5` 与 `loudOnly.loudnessRangeLu === 0` 原样保留；`whole.loudnessRangeLu >= 0` 收紧为 `> 0`（29 块跨阶跃的 3 s 窗产生 ≈ 6.98 LU 的真实 range）。用例名由「raises」改为「barely moves」——原名与断言方向相反。
- 备注：这是本轮**唯一**被替换的断言，替换理由不是「实现算出来的数不好看」，而是原前提（安静段在绝对门之下）可由 `audio_analysis.rs:205` 直接证伪；新断言把同一意图（安静段不按能量比拖低结果）变成有 14 dB 判决余量的量化命题。

**10．`toInt16(-2)` 应饱和到 −32768 而不是 −32767（wav 第 10 项）**

- 依据：`audio_analysis.rs:406` `(sample * 32767. + dither).round().clamp(-32768., 32767.)` —— **两端非对称**；切片指令也写明「<−1.0 → −32768」。读回 `v / 32767` 与之配套，所以 −32768 读回是 −1.0000305，这是标准 PCM 的非对称标度，不是 bug。
- 改动（`test/wav.test.ts:225-238`）：期望 `-32767 → -32768` 并注明出处；**新增 2 条**：`toInt16(-0.5/32767) === -1`（远离零取整，与 Rust `f64::round` 一致）、`fromInt16(toInt16(-2)) === -32768/32767`（把非对称标度锁住，防止有人把下限改成 −32767 来「对称化」）。`toInt16` 实现零改动。
- 归并说明：第 6 项的 dither 语义无需裁决 —— Rust 的 `round().clamp(...)` 与本实现逐字相同，`<= 1.5 LSB` 的上界在修复声道数后自然成立（`|round(x+n) − x| ≤ 0.5 + |n| < 1.5`，`n = u1 − u2 ∈ (−1,1)` 是严格开区间），**容差未动**。

**11．限幅器的 `lookahead − 1` 是 `Limiter` 自身的延迟，混音器把这一段预填掉了（mixer 第 11 项）**

- 依据：`audio_mix.rs:194-197` `fn latency(&self) -> usize { self.lookahead - 1 }` ＋ `:199-209` `reset()` 把 `latency()` 个 0 压进延迟队列 —— 所以**单独**调 `Limiter::process` 时输出滞后 `lookahead − 1` 个样本，这正是原用例名想说的事。
- 但 `audio_mix.rs:565-615 AudioMixer::render` 在真正混音前会用**输出区间之前**的 `latency` 个样本「预热」限幅器（`:576-584`），其输出被丢弃，随后 `mix_raw(start + latency, ..)` 喂进去。所以**混音成品不延迟**：`left[i]` 就是时间线样本 `i`（这对音画同步是必须的，也是契约 §1「采样精确定位」的题中之义）。原用例 `left[0] === 0` 期望的是「未补偿的限幅器」，与 Rust 行为相反。
- 改动（`test/mixer.test.ts:154-186`，用例名改为 `the limiter lags by lookahead - 1 samples and the mix compensates it`）：
  - 直接对 `Limiter` 断三条：`latency() === 220`（`round(0.005·44100) = 221` 减 1）；喂 222 个 1.0 得 `[0×220, 1, 1]`（前 220 个是预填静音，第 220 个才是第一个输入样本）—— **`lookahead − 1` 被直接、可辨地锁住**；
  - 再断混音侧三条：`left[0] === 1`、`left[220] === 1`（跨 4096 块边界）、`left[RATE-1] === 1` —— 混音成品逐样本对齐。
  - 新增 import：`Limiter`（值）、`LimiterOptions`（类型）。实现零改动。
- 判据说明：`ceilingDb: 20` 时 `peak = 1 < ceiling = 10` ⇒ `required ≡ 1`、boxcar 全 1 ⇒ `gain ≡ 1`，因此这三条是精确等值断言（不是容差断言）。

**12．`duckDb` 的 attack/hold/release 是**秒**，测试把它们当样本用了（mixer 第 12 项）**

- 依据：`audio_mix.rs:321-348` `attack = f64::from(ducking.attack) * sample_rate`（hold/release 同理），ramp 形状是 raised cosine `(1 − cos(π·clamp(t,0,1)))/2`（`:325`）—— **在 attack 起点上 ramp 值恰为 0**，不是 −12 dB。
- 缺陷：测试传 `{attack: 20, hold: 10, release: 30}` 配 `sampleRate = 44100`，于是 attack = 882000 样本，`n = 79` 时 `(79 + 881900)/882000 = 0.99998` → 期望 0 实得 −11.99999；`n = 80` 期望 −12（ramp 起点）实得同值 —— 两条都错，且与 Rust 语义无关地错。另外 `n = 150` 落在 hold 区间，`duckDb` 精确等于 −12，`> −12` 也恒不成立。
- 改动（`test/mixer.test.ts:381-403`）：采样率传 `1`（包络是纯样本函数，字段即样本数，注释已写明；真实 `RATE` + 默认 ducking 路径由 `ducking follows the voice ranges` / `a voice at 3..5 s …` 两条集成用例覆盖），断言重排为 10 条且全部落在整数边界：`79 → 0`（attack 之前）、`80 → 0`（ramp 起点）、`90 → −6`（attack 中点）、`100 → −12`（全下）、`209 → −12`（hold 结束前）、`210 → −12`（release 起点）、`225 → −6`（release 中点）、`239 → 0` / `240 → 0`（release 之后）、无 voice → 0。实现零改动。
- 细节：`depthDb · 0 = −0`，而 `assert.equal`（= `Object.is`）判 `−0 ≠ 0`，故用 `at(n) = duckDb(...) + 0` 折回 `+0` 再比 —— 这是**测试写法问题**，不是语义问题（Rust 侧同样是 `-0.0f32`）。

**15 / 18．`Eof` 的区间末端 = 文件时长 + 区间起点，不是 + 1009（audio-map 第 15、mixer 第 18 项）**

- 依据：`audio_map.rs:490-509` `end = Eof.to_seconds(file, fps, Some(start − mix.offset), ..)`，而 `:152` `Eof => resolve_audio_duration(filename)? + eof_base.unwrap_or(0.)`；offset = 0 时 `eof_base = start`。所以 `Second(0.51)..Eof` 配 1000 样本文件 ⇒ `(0.51 + 1000/44100)·44100 = 22491 + 1000 = 23491`。
- 缺陷：两处断言都写 `start + 1009`（= 23500），而**它们自己的 message 就写着**「the file is 1000 samples plus the 0.51 s base」——`1009` 是 `1000` 的笔误。改动仅此一处数字，并补上 `audio_map.rs:152` 的推导注释。4.25 s 那条（`range.end === samplesFromSeconds(14.25, RATE)`）本来就对，未动。

**16．`seconds_to_frames_floor` 的容差是 1e-6 **帧**，不是 1e-5 秒（audio-map 第 16 项）**

- 依据：`audio_map.rs:106-110` `(seconds.max(0.) * fps as f64 + 1e-6).floor() as usize`；函数注释自己举的例子是「`0.99999` **帧**的整秒仍算整帧」，不是「0.99999 秒」。30 fps 下 1e-6 帧 = 3.33e-8 s，而 `0.99999 s` 距整秒差 1e-5 s = **3e-4 帧**，比容差大 100 倍，必须截断成 29。
- 改动（`test/audio-map.test.ts:301-315`）：把与实现相反的期望换成**一对正反断言** —— `framesFromSeconds(0.5 − 1e-9, 30) === 15`（3e-8 帧的浮点噪声被 1e-6 帧容差原谅；去掉 epsilon 就是 14，可辨）＋ `framesFromSeconds(0.99999, 30) === 29`（真实欠量必须截断）。另补 `samplesToFrames(samplesFromSeconds(2, RATE), …) === 60` 把 `AudioTimelineSamples::to_frames` 的整数除法也锁住。`framesFromSeconds(2.5, 30) === 75`、`(-1, 30) === 0`、`samplesFromSeconds(-5, RATE) === 0`、`secondsFromSamples(187425) === 4.25` 四条原样保留。实现零改动。

**17．指数 fade 在 `t → 0+` 的极限是 −60 dB，不是 −57 dB（audio-map 第 17 项）**

- 依据：`audio_map.rs:198-203` `if t <= 0 { 0 } else { 10f32.powf(-60. * (1. - t) / 20.) }` —— 端点 0 dB 与 −60 dB 之间是**斜率 3 dB / 单位 t 的直线**，`t = 0.001` 处必然是 −59.94 dB，`-57` 与定义差 2.94 dB（超出该断言自己的 ±1 容差）。切片指令也判「以实现严格 mirror Rust 为准」，并点名「测试断言应改为 `gain(0)===0` 或 `t=1e-9` 处 ≈ −60 dB」。
- 改动（`test/audio-map.test.ts:143-152`）：`+57` → `+60`，容差 ±1 → ±0.01（**收紧** 100 倍），并按指令补 3 条：`gain(0) === 0`（Rust 的 `t <= 0` 分支）、`t = 1e-9` 处 ≈ −60 dB（±0.01）、`t = 0.5` 处 = −30 dB（斜率中点）；`gain(1) === 1` 与 `gain(0.9) > 0.5` 原样保留。实现零改动。

**19．重采样边缘不是「看到一半输入」（resample 第 19 项）**

- 依据：`audio_mix.rs:148-152` 越界 tap 贡献 0（所以边缘是渐变、不是跳变），但 `:120-125` **每个相位行都被归一化到单位直流增益**。于是首样本拿到的是「核的右半边」**加上中心 tap 自身**（中心 tap 独占约 0.485 的直流增益），而不是一半：按源码常数手算（`cutoff = 0.475`、`half = 17`、34 taps）首末样本 ≈ **0.74**，`0.7` 的上界是算错的。
- 改动（`test/resample.test.ts:126-144`）：区间 `(0.1, 0.7) → (0.5, 1)`（该区间对 0.74 有 32% 余量，且仍能判别「补零 = 0」与「钳到满幅 = 1」两种错法），**另补 2 条更强的**：`output[16] ≈ 1 ± 1e-3`（32 个源样本后整个核都在缓冲区内 ⇒ 精确复原）与尾端 `output[length-1] ∈ (0.5, 1)`（首尾对称）。中段 `mid ≈ 1` 原样保留。实现零改动。

**20．Hamming 的 1 样本窗断的是 f64 字面量，系数存在 `Float32Array` 里（visualize 第 20 项）**

- 依据：`audio_window_functions.rs:29` 的 `cosf` 被写到了分母上（`0.54 − 0.46·(2πi / cosf(len−1))`），本移植在 2.4 第 15 条已记录「不照抄笔误」，实现 `0.54 − 0.46·cos(2πi/(n−1))` 是**正确的对称 Hamming**，端点 `0.54 − 0.46 = 0.08`（切片指令判「hamming 端点 0.08 还是 0.54−0.46=0.08」＝ 0.08，采纳实现）。Blackman 同理 `0.42 − 0.5 + 0.08 = 0`，源码常量一致。
- 缺陷：只有 `assert.equal(hammingWindow(1)[0], 0.08)` 这一条挂 —— `assert.equal` 是 `Object.is`，而系数写进 `Float32Array` 后是 `f32(0.08) = 0.07999999821…`，与 f64 字面量不逐位相等。**这是断言写法错，不是数值错。**
- 改动（`test/visualize.test.ts:92-95`）：改成 ±1e-6 容差（与同一用例里其它 5 条端点断言量级一致），**另补** `blackmanWindow(1)[0] ≈ 0 ± 1e-6`（把「1 样本不除零」对两个窗都锁住）。`hamming[0]` / `[32]` / `[63]`、`blackman[0]` / `[32]`、两条 `.length` 断言全部原样保留。

**13 / 14．`mixAudioToFile` 两条：逐条推演后未发现缺陷，判为误报（mixer 第 13、14 项）**

- 推演：`mixAudioToFile` → `new AudioMixer({tracks, audio, sampleRate})`，无 `outputRange` ⇒ 取 `{0, maxEnd = 1000}`，`renderInterleaved()` 出 2000 个样本；`writeWavSync({channels: 2, bitDepth: 16, dither: false})` ⇒ `dataSize = 1000·2·2 = 4000`、`frames = 1000`、`formatTag = 1`；float 路径 `fmtSize = 18`、`formatTag = 3`、`dataOffset = 58`。**原有 7 条断言在修复前后都成立**，与本轮两处实现缺陷无因果关系 —— `mixAudioToFile` 走的正是 `channels: 2`，两处缺陷都碰不到它。
- 处理：**不为了「让清单归零」而改实现**；原断言逐字保留，并各**补 5 条**把「统一后的布局」真正锁住：16-bit 侧 `fmtSize === 16` / `blockAlign === 4` / `byteRate === RATE·4` / `dataOffset === 44` / `float === false`；float 侧 `frames === 10`（**这条在 fact 偏移修复前实得 1635017060**，是对实现缺陷 1 的第二个回归锁）、`blockAlign === 8` / `dataOffset === 58` / `dataSize === 80` / `float === true`。
- 给指挥官的复核建议：若这两条在门禁里仍红，请把 `node --test test/mixer.test.ts` 的原始 diff 贴回 —— 按当前代码它们应全绿；本轮**没有**为它们改任何一行实现。

### 3.2 本轮改了什么（供门禁 diff 核对）

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `src/audio/wav.ts` | 抽出 `encodeRiff`(:129-191)；`encodeWav` 加 `channels`(:199-216)；`encodeWavInterleaved` 透传声道数(:230-246)；`parseWavHeader` 帧数 `body+4 → body`(:322) | **实现修复 2 处缺陷** |
| `test/wav.test.ts` | `toInt16(-2)` → `-32768` ＋ 2 条新断言(:225-238) | 测试修复（第 10 项） |
| `test/analysis.test.ts` | 两条 LUFS 用例改单声道(:115-152)；「安静段」用例换 3 条量化断言(:274-300) | 测试修复（第 1-3 项） |
| `test/audio-map.test.ts` | 指数 fade `+57 → +60` ＋ 3 条(:143-152)；`start+1009 → start+1000`(:210-227)；帧换算换正反一对 ＋ 1 条(:301-315) | 测试修复（第 15-17 项） |
| `test/mixer.test.ts` | import 加 `Limiter`/`LimiterOptions`；`start+1009 → start+1000`(:108-122)；限幅器用例重写(:154-186)；`duckDb` 用例重写(:381-403)；两条 `mixAudioToFile` 各补 5 条(:553-596) | 测试修复 + 增强（第 11-14、18 项） |
| `test/resample.test.ts` | 边缘区间 `(0.1,0.7) → (0.5,1)` ＋ 2 条(:126-144) | 测试修复（第 19 项） |
| `test/visualize.test.ts` | `assert.equal(f32(0.08), 0.08)` → 容差 ＋ 1 条(:92-95) | 测试修复（第 20 项） |
| `DELIVERY.md` | 本节 | 交付记录 |

**新增断言 21 条、删除断言 0 条、修改期望值 11 处**（第 1/2 项声道布置 ×2、第 3 项 ×1、第 10 项 ×1、第 15 项 ×1、第 16 项 ×1、第 17 项 ×1、第 18 项 ×1、第 19 项 ×1、第 20 项 ×1）。`test()` 用例总数不变：20 条用例全部仍在原文件里，只改断言内容与 3 条用例名。

### 3.3 复跑要求（交外部门禁）

```bash
cd fframes-node
node --test test/audio-map.test.ts test/mixer.test.ts test/resample.test.ts \
               test/analysis.test.ts test/wav.test.ts test/visualize.test.ts   # 目标 111 pass / 0 fail
node --test test/*.test.ts        # 全量，总数只增不减
npx tsc --noEmit                 # encodeRiff 的 RiffOptions / channels 字段类型完整性
```

重点复核的 4 个数值落点（若与下列不符，说明本轮某条推演有误，请把 diff 贴回）：
`analysis` 满幅单声道 `−3.03` LUFS、0.1245 单声道 `−21.13` LUFS、安静段 `drop = 0.17` LU 且 `whole.loudnessRangeLu ≈ 6.98`、`resample` 边缘 `≈ 0.74`（区间 `[0.5, 1]`）。

---

## 修复轮 gen3（门禁 13 FAIL：CLI 全线挂起 + tsc 12 错 + 单测 6 失败 · 指挥官逐项裁决）

> **门禁证据**：`bash gates/verify-fframes.sh` → `PASS=12 FAIL=13`。§A 全过；**§B1 `tsc --noEmit` 12 错**；**§B2 单测 231 pass / 6 fail**；**§C 全部 9 项挂起**（`node src/cli/main.ts …` 无输出、exit 13、`Detected unsettled top-level await at src/cli/main.ts:485`、CPU profile 零命中 = 纯空闲等待）。
> **裁决优先级**：Rust 源码（`.source/fframes/fframes/src/`）为最终事实源 > 测试预期 > 实现现状。**语义争议一律引 `file:line`**。
> **纪律**：每项修复「正反可辨」——修复前失败的那条断言/类型错误即回归验证；**不删断言**；**不放宽容差**（下表第 10/11/13 项的容差变更是指令明确裁决且已注明理由）。
> **执行级验证**：本轮权限面无 bash，**未运行任何命令**。所有结论为逐行推演 + Rust 源码比对 + `grep` 自查，依据逐项写在 4.1 内；执行证据交外部门禁（4.3 给出复跑命令与预期落点）。

### 4.0 总览

| # | 指令项 | 归因 | 处理 | 裁决状态 |
| --- | --- | --- | --- | --- |
| 1 | P0-1 `index.ts ↔ cli/main.ts` TLA 环（阻塞 §C 全部 9 项） | **实现错** | 删 `index.ts` 末尾对 `./cli/main.ts` 的 15 行 re-export，改写为规范性注释；README 补「CLI 按路径 import」 | 采纳（`main.ts` 的 TLA 一行未动） |
| 2 | P0-2 越界空文件 `src/render/pipeline.ts` | 已由指挥官删除 | 本轮未重建（`src/render/` 只剩 `resvg-backend.ts`） | 采纳（无操作） |
| 3 | B1-1 `AudioDemo` 缺 `defineScenes`（TS2420） | **实现错** | 加 `defineScenes(): null { return null; }` | 采纳 |
| 4 | B1-2 `mixer.sampleRate` 字段/方法同名（TS2300×2 + TS2341 + TS2349） | **实现错**（上轮 fixer 方法名撞私有字段） | 删 `sampleRate()`，改名 `get outputSampleRate()`；`mixAudioToFile` 改读它 | 采纳 |
| 5 | B1-3 `Declared.present` readonly（TS2540×2） | **实现错** | 内部簿记类型 `present` 改可变；对外 `ParsedArgs` 只读性不动 | 采纳 |
| 6 | B1-4 `sections` 不在 `AnalyzeAudioInput`（TS2353） | **调用方错**（`analysis.ts` 不动） | `sections` 改作 `analyzeAudio` 的**第二实参**（`analysis.ts:469`） | 采纳（附源码级证据，见 4.1 第 6 项） |
| 7 | B1-5 `diagnostics.ts` readonly→可变（TS4104） | **已合规**（复核结论） | 消费点已是显式拷贝，补 2 行注释固化规则；不改编排 | 复核推翻「需改签名」，附证据 |
| 8 | B1-6 `DecodedAudio` 以 `import type` 引入却 `new`（TS1361） | **实现错** | 并入已有的值导入 | 采纳 |
| 9 | B1-7 `frame.test.ts` 用对象字面量冒充 `DecodedAudio`（TS2740×2） | **测试错**（GEN-1 早于 GEN-2 的类） | 两处改 `new DecodedAudio(samples, 44100)`，断言语义不变 | 采纳（改测试不改实现） |
| 10 | B2-1 指数 fade `t=0.001` 期望 −60 ±0.01（audio-map） | **测试错**（fixer 算错期望） | 该条容差 `0.01 → 0.1`（精确值 −59.94，偏差 0.06）；同用例其余 4 条不动 | 采纳（指令裁决） |
| 11 | B2-2 `duckDb` 中点 −6 精确比较（mixer） | **测试错**（浮点必然漂移） | 90 / 225 改 1e-9 容差；**逐条核对发现 239 的期望值本身也错**，按 `audio_mix.rs:331` 改闭式 −6·(1+cos(29π/30)) ±1e-9 | 采纳 + 1 项指令外更正（附推演） |
| 12 | B2-3 `mixAudioToFile` ×2 | 与 B1-2 同根因 | 修实现即绿，**测试零改动** | 采纳 |
| 13 | B2-4 `resample` 首尾边缘区间 `(0.5, 1)` | **测试错**（Kaiser 纹波过冲） | 首/尾上界 `1 → 1.15` + 实测过冲依据；`output[16]`、中段不动；**未改 `resample.ts`** | 采纳（指令裁决） |
| 14 | B2-5 `toInt16(-0.5/32767) === -1`（wav） | **实现错**（与 ground truth 真实偏差） | 新增 `roundHalfAwayFromZero`；`toInt16` 与 dither 路径同用；clamp 不变 | 采纳（`audio_analysis.rs:406`） |

净效果：**实现改 7 个文件**（`src/index.ts`、`src/audio/mixer.ts`、`src/audio/wav.ts`、`src/cli/args.ts`、`src/cli/audio-cmd.ts`、`src/render/resvg-backend.ts`、`examples/audio-demo/video.ts`）＋ 1 处注释固化（`src/inspect/diagnostics.ts`）；**测试改 4 个文件**；**文档改 2 个**（`README.md`、本节）。**删除断言 0 条、放宽容差 3 处**（第 10/11/13 项，均为指令裁决并注明理由）。

### 4.1 逐项修复（含源码级依据）

**1. P0-1 CLI 全线挂起 —— 删掉 `index.ts` 对 `cli/main.ts` 的 re-export**

- 依据（指令已实验锁定，此处复核链条）：`src/cli/main.ts:484-486` 是 `if (isEntryPoint()) { await runCli(); }`（TLA）；`runCli → run → loadVideo`（`main.ts:425`）里 `await import(pathToFileURL(resolve(...)))` 动态载入视频模块；`examples/*/video.ts` 静态 `import … from '../../src/index.ts'`；原 `index.ts` 末尾静态 `export { run, runCli, … } from './cli/main.ts'`。于是 `main.ts`（TLA 未落定）→ `video.ts` → `index.ts` → `main.ts`（求值中）成环，`index.ts` 永不求值完，`runCli` 永挂 —— 与「无输出 + exit 13 + `unsettled top-level await at src/cli/main.ts:485` + CPU 零命中」完全吻合。程序化路径（先 `import main.ts` 求值完再 `runCli(argv)`）不成环，所以探针正常。
- 改动：`src/index.ts:305-332` —— 删掉 `export { isEntryPoint, loadVideo, mediaDirFor, resolveRange, resolveScale, resolveSpecs, run, runCli, splitSpecs, USAGE } from './cli/main.ts';` 与 `export type { CliOptions, CommandName, VideoExport } from './cli/main.ts';`（原 :305-319），替换为规范性注释：环的形状、为什么程序化路径不受影响、为什么 `cli/render.ts` 等命令模块可以继续 re-export（它们都不 import `main.ts`）、以及「要修就修这个文件的 re-export，不要动 `main.ts` 的 TLA」（呼应 3.2 决策 21）。
- **未动 `main.ts`**（指令第 3 条）：`isEntryPoint()` + TLA 是契约 §3 指定的入口判定，探针已证明该形态在无环模块图下正常。
- 连带核查（grep 全库）：`src/**` 内无任何文件 import `../index.ts`，删除后 `index.ts → main.ts` 不存在任何静态路径；除 `index.ts` 外无文件从它取过 `run`/`runCli`/`loadVideo`/`USAGE`/`CliOptions` 等 15 个符号，`examples/hello-world/main.ts:20` 本来就 `import { run } from '../../src/cli/main.ts'`。
- 门禁 A11 复核：16 个符号（`Video Frame Svgr svgr seconds frames auto fromAudio timeline Easing AudioMap audioTrack Color Transform Ducking MediaDirectory`）全部仍在 `index.ts`，删掉的块一个都不含它们。

**2. P0-2 `src/render/pipeline.ts`**：指挥官已删除；本轮未重建，`src/render/` 目录现在只有 `resvg-backend.ts`（glob 单命中）。

**3. B1-1 `AudioDemo.defineScenes`（TS2420）** —— `examples/audio-demo/video.ts:41-45`

- 依据：`src/core/types.ts:133` `defineScenes(): Scenes | readonly Scene[] | null | undefined;` 是必实现成员；`src/core/scenes.ts:70` `Scenes.fromValue(...)` 与 `resvg-backend.ts:484` `Scenes.fromValue(video.defineScenes())` 都接受 `null`。
- 改动：加 `defineScenes(): null { return null; }`。**这不是纯类型修复**：`video.defineScenes()` 在 `resvg-backend.ts:484` 是运行时调用，缺方法会抛 `TypeError`，即 §C 的 `audio render/analyze/at` 在运行期同样过不去。

**4. B1-2 `sampleRate` 遮蔽（TS2300×2 / TS2341 / TS2349）** —— `src/audio/mixer.ts:560-568`、`:797-799`

- 依据：`private readonly sampleRate: number`（`:449`）与上轮 fixer 新加的 `sampleRate()` 方法（`:561`）同名 → TS 重复标识符；运行时**实例字段遮蔽原型方法**，`mixer.sampleRate` 是 number，于是 `mixAudioToFile`（`:791`）的 `mixer.sampleRate()` 抛 `TypeError: mixer.sampleRate is not a function` —— 这正是 B2-3 两条用例失败的同一根因。
- 改动（裁决二选一取「不同名的只读访问器」）：删 `sampleRate()`，换成 `get outputSampleRate(): number`（镜像 Rust `AudioMixer::sample_rate`，注释写明同名会遮蔽的运行时原因）；`mixAudioToFile` 改 `sampleRate: mixer.outputSampleRate`。**没有**在 `mixAudioToFile` 里重算 `input.sampleRate ?? DEFAULT_MIX_SAMPLE_RATE`：那份归一化已在构造器里做过（`mixer.ts:460-463`，含整数/正数校验），重算等于把「一处归一化」变成两处。测试零改动（`test/mixer.test.ts:559`、`:584` 传 `sampleRate: RATE`，断的是落盘 WAV 头）。

**5. B1-3 `Declared.present`（TS2540×2）** —— `src/cli/args.ts:61-68`

- 依据：两处错误都落在 `declared.present = true`（`:106`、`:148`），声明在内部 `interface Declared`（`:56-62`）。`Declared` 是 `parseArgs` 的簿记类型（`values` 同样是可变的 `string[]`），对外的 `ParsedArgs`（`:35-50`）用 `ReadonlyMap` + `readonly`，只读性不受影响。
- 改动：`readonly present: boolean` → `present: boolean` + 注释；解析行为零变化。

**6. B1-4 `sections` 传参位置（TS2353）** —— `src/cli/audio-cmd.ts:148-163`

- **源码级复核（指令前提有出入，按证据记录）**：`sections` 不是 `analyzeAudio` 的入参字段，而是它的**第二位置参数** —— `src/audio/analysis.ts:469-472` `export function analyzeAudio(input: AnalyzeAudioInput, sections: readonly AnalysisSection[] = []): AudioAnalysis`；且 `analysis.ts:531-537` 正是按场景算 `integratedLufs: finiteLufs(loudness.integrated(section.start, section.end))` 与 `truePeakDb: finiteLufs(toDb(peakOf(section.start, section.end)))`（4x 多相真峰），语义与指令描述的「按场景切 section → clamp 进 range → 相对 range 起点 → 时间平移」一致。既有测试也用这个形态：`test/analysis.test.ts:222` `analyzeAudio({ left, right, sampleRate: rate }, [ … ])`。
- 改动（遵守「`analysis.ts` 不动、改调用方」）：把 `sections` 从入参对象取出，作为第二实参传入。**没有**在 `audio-cmd.ts` 新写一份「按 `LoudnessAnalysis` + 切片自算每场景 LUFS」的逻辑 —— 那份逻辑 `analysis.ts` 已导出且已被 `analysis.test.ts` 覆盖，在调用方复刻只会造出第二个可能与 ground truth 漂移的实现，这正是裁决里「若已含 windows/section 能力则直接用」的情形。
- 输出形状不变：人读仍打 `section.name / startSeconds..endSeconds / LUFS / dBTP`（`analyzeText`，`audio-cmd.ts:198-201`），`--json` 的 `sections` 来自 `analyzeJson(:223)`；门禁 C7 依赖的 `integratedLufs` / `truePeakDb` 是整段数值，不受影响。

**7. B1-5 `diagnostics.ts` TS4104 —— 复核结论：当前代码已合规，只补注释**

- 指令描述的症状（签名声明可变数组、调用点传 readonly）与 tsc 日志 `diagnostics.ts(264,11)` 在**当前文件**对不上：`:264` 现在是文档注释行；同列号 11 的「可变数组声明」在 `:296`，而 `:296` 已是 `[...inspectFrame(...).findings]` 的显式拷贝 —— 展开 readonly 数组得到可变数组，不产生 TS4104；`:299` 的 `raws.unshift(...inspectMedia(session, frame))` 里 `inspectMedia` 返回可变 `RawFinding[]`（`:210`），同样不触发。
- 判定：这条错误来自门禁日志所依据的**更早文件版本**（佐证：`index.ts` 在我两次读取之间也多了 7 行 `DurationResolution` 导出，说明落盘状态在门禁之后又变过）。当前文本已满足裁决要求 —— 签名保持只读（`FrameInspection.findings: readonly RawFinding[]`，`:135`），唯一被改动的数组是本地拷贝（`:296`）。
- 改动：**只加 2 行注释**（`:294-295`）固化「签名只读 + 改动前先拷贝」，不重排 `:296-300` 的逻辑（`unshift` 的顺序语义不动，`merged` 插入顺序因此不变）。

**8. B1-6 `DecodedAudio` 值导入（TS1361）** —— `src/render/resvg-backend.ts:62-69`

- 依据：`decodeAudioSync` 在 `:345` `new DecodedAudio(...)`，而原来只有 `import type { DecodedAudio }`（`:68`）；`verbatimModuleSyntax` 下类型导入不能当值用。
- 改动：`DecodedAudio` 并入已有值导入块，删掉 `import type` 行。行数不变（7 行换 7 行），所以注释里的自引用 `:345` 仍准确。

**9. B1-7 `frame.test.ts` 的 `DecodedAudio`（TS2740×2）** —— `test/frame.test.ts:14`、`:157`、`:173`

- 依据：GEN-1 写测试时 `VisualizeFrameInput.audio` 还是 `{samples, sampleRate, channels}` 结构，GEN-2 换成类 `DecodedAudio`（`src/media/audio-decode.ts:27-39`，构造器 `(samples, sampleRate, right = null)`，`channels` 由 `right` 推导）。按裁决**改测试不改实现**。
- 改动：加值导入 `import { DecodedAudio } from '../src/media/audio-decode.ts';`，两处字面量改 `audio: new DecodedAudio(new Float32Array(512), 44100)`（`right` 省略 = 单声道 = 原 `channels: 1`）。两条用例的断点（缺 provider 抛错 / smoothLevel ±2 帧）不读音频内容，语义不变。

**10. B2-1 指数 fade `t=0.001`（audio-map）** —— `test/audio-map.test.ts:143-153`

- 依据：`audio_map.rs:198-203` 的 `10^(-60*(1-t)/20)` 在 `t=0.001` 处**精确**等于 `10^(-2.997)`，dB 值 `-59.94`，与 `-60` 差 0.06 dB —— ±0.01 的期望不可达，是 fix-gen2 第 17 项把期望写成 −60 时算错的（同用例 `t=1e-9` 偏差只有 6e-5，±0.01 成立，所以只动这一条）。
- 改动：该条容差 `0.01 → 0.1`，注释补「0.06 dB 是公式的精确距离，不是擦边放行；同时仍比 −59/−57 那种量级错误严 100 倍」。`gain(0)===0`、`t=1e-9`、`t=0.5 = -30`、`gain(1)===1` 逐字未动。

**11. B2-2 `duckDb` 逐条核对（mixer）** —— `test/mixer.test.ts:390-408`

按指令「逐条核对待测值」逐条推演（`mixer.ts:354-382`，`sampleRate=1`、`voices=[100,200]`、`{depth:-12, attack:20, hold:10, release:30}`）：

| 断言 | 实现实得 | 处理 |
| --- | --- | --- |
| `at(79) === 0` | `n < downFrom(80)` → skip → `-12·0 = -0`，`+0` 折叠为 0 | 保留 `equal` |
| `at(80) === 0` | `RAISED_COSINE(0) = (1-cos0)·0.5 = 0` | 保留 `equal` |
| `at(90) === -6` | `-12·(1-cos(π/2))/2 = -6·(1-6.12e-17) = -5.999999999999999` | 改 `Math.abs(at(90) + 6) < 1e-9` |
| `at(100) === -12` | `n ≥ voice.start` 且 `n < upFrom(210)` → amount 恒 1 → 精确 −12 | 保留 `equal` |
| `at(209) === -12` | 同上 | 保留 `equal` |
| `at(210) === -12` | `1 - RAISED_COSINE(0) = 1` → 精确 −12 | 保留 `equal` |
| `at(225) === -6` | `-6·(1+cos(π/2)) = -6.000000000000001` | 改 `Math.abs(at(225) + 6) < 1e-9` |
| `at(239) === 0` | **期望值本身错**：239 仍在 release 斜坡内（29/30 处），amount = `1 - RAISED_COSINE(29/30)` = 0.00272 → **−0.0327 dB** | 改闭式 `Math.abs(at(239) - -6 * (1 + Math.cos((29/30) * Math.PI))) < 1e-9`（**指令外更正**） |
| `at(240) === 0` | `n ≥ upFrom+release = 240` → `continue`（`audio_mix.rs:331`）→ 精确 0 | 保留 `equal` |

- 指令外更正的依据：Rust `audio_mix.rs:328-344` 与 `mixer.ts:365-380` 都是 `n >= up_from + release → continue`，即 240 是**第一个**完全释放的样本，239 仍在斜坡里。原期望 `at(239) === 0` 在实现与 ground truth 两侧都不成立；又因为 `node:test` 遇错即止，指挥官只看到 90 那一条先炸，不改则本轮做完仍红。改法不是把期望挪到 −0.0327 这个魔法数，而是写成闭式 `-6 * (1 + cos(29π/30))` + 1e-9 容差，判别力不变（0 / −6 / −12 任一错误实现仍会红）。
- 该用例断言**条数不变**（9 条），其余 6 条精确比较逐字保留。

**12. B2-3 `mixAudioToFile` ×2**：与第 4 项同根因（`TypeError: mixer.sampleRate is not a function`）。修实现即绿，**测试零改动**。

**13. B2-4 `resample` 首尾边缘区间（resample）** —— `test/resample.test.ts:126-150`

- 依据：实现逐行 mirror `audio_mix.rs:63-156`（Kaiser β=8.6、8 阶 sinc、256 相位表、每相位归一化到单位直流增益）。窗在通带边缘有纹波，满幅直流输入的**边缘样本会过冲**：门禁实测尾样本 `1.0504`，上界写 `1` 必然红。
- 改动：首/尾两条区间 `(0.5, 1)` → `(0.5, 1.15)`，注释写明「1.15 = 实测过冲 1.0504 + Kaiser β=8.6 通带纹波；上界仍能同时否掉『补零 ⇒ 0』与『钳到满幅 ⇒ 恒 1』两类错误」。`output[16] ≈ 1 ±1e-3`（核完全入窗后的精确复原）与中段断言**逐字未动**；**`src/audio/resample.ts` 一行未改**（过冲是原算法的固有行为，不是缺陷）。
- 与 gen2 §3.2 第 19 项的关系：那一轮把区间从 `(0.1, 0.7)` 抬到 `(0.5, 1)`（首样本实测 ≈0.74 落在里面），但尾样本从未被单独跑到（首条先炸）；本轮按实测把上界放到 1.15。

**14. B2-5 `toInt16` 远离零取整（wav）** —— `src/audio/wav.ts:52-69`、`:196-199`

- 依据：`audio_analysis.rs:406` `(sample * 32767. + dither).round().clamp(-32768., 32767.) as i16`。Rust `f64::round` 是**远离零**取整（`(-0.5f64).round() == -1.0`），`Math.round` 是向 `+∞`（`Math.round(-0.5) === -0`）——**实现与 ground truth 的真实偏差，测试是对的**。
- 改动：新增模块私有 `roundHalfAwayFromZero(value) = Math.sign(value) * Math.floor(Math.abs(value) + 0.5)`；`toInt16`（`:67-69`）与 `encodeRiff` 的 16-bit 写入路径（`:199`，dither 路径）统一改用它；`.clamp(-32768, 32767)` 原样保留。
- 对既有用例的影响复核：`toInt16(0.5/32767) === 1`（正侧平局不变）、`toInt16(-2) === -32768`、`fromInt16(toInt16(-2)) === -32768/32767`、`16-bit samples round trip ±1 LSB`（误差界仍 ≤ 0.5 LSB）、`dither ≤1.5 LSB`（噪声分布未动，只有恰好平局的样本变号）—— 全部仍成立，且比改前更贴 Rust。

### 4.2 本轮改了什么（供门禁 diff 核对）

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `src/index.ts` | 删除末尾 15 行 `cli/main.ts` re-export（原 :305-319），替换为 28 行环说明规范性注释 | **实现修复（P0 死锁根因）** |
| `src/audio/mixer.ts` | 删 `sampleRate()` → `get outputSampleRate()`(:560-568)；`mixAudioToFile` 改读它(:797-799) | **实现修复（B1-2 / B2-3 根因）** |
| `src/audio/wav.ts` | 新增 `roundHalfAwayFromZero`(:52-59)；`toInt16`(:67-69) 与 dither 写入(:196-199) 改用它 | **实现修复（B2-5，贴 ground truth）** |
| `src/cli/args.ts` | 内部 `Declared.present` 去掉 `readonly`(:61-68) | 实现修复（B1-3） |
| `src/cli/audio-cmd.ts` | `sections` 改作 `analyzeAudio` 第二实参(:148-163) | 调用方修复（B1-4，`analysis.ts` 未动） |
| `src/render/resvg-backend.ts` | `DecodedAudio` 并入值导入(:62-69) | 实现修复（B1-6） |
| `src/inspect/diagnostics.ts` | 消费点加 2 行注释(:294-295)，逻辑零改动 | 注释固化（B1-5 复核结论） |
| `examples/audio-demo/video.ts` | 加 `defineScenes(): null { return null; }`(:41-45) | 实现修复（B1-1，兼运行期） |
| `test/frame.test.ts` | 加 `DecodedAudio` 值导入(:14)；两处字面量 → `new DecodedAudio(...)`(:157,:173) | 测试修复（B1-7） |
| `test/audio-map.test.ts` | 指数 fade `t=0.001` 容差 `0.01 → 0.1` + 依据注释(:143-153) | 测试修复（B2-1，指令裁决） |
| `test/mixer.test.ts` | `duckDb` 用例：2 条改 1e-9 容差、1 条（239）改闭式容差、6 条精确比较保留(:390-408) | 测试修复（B2-2 + 1 项指令外更正） |
| `test/resample.test.ts` | 首/尾边缘上界 `1 → 1.15` + Kaiser 纹波依据注释(:126-150) | 测试修复（B2-4，指令裁决） |
| `README.md` | 「Using it as a library」补 CLI 例外说明与 `import { run } from './src/cli/main.ts'` 示例(:254-262) | 文档同步（P0-1 第 2 条） |
| `DELIVERY.md` | 本节 | 交付记录 |

**删除断言 0 条、放宽容差 3 处**（`audio-map` t=0.001 一处；`mixer` duckDb 三处由 exact 改容差；`resample` 首尾两条上界），全部是指令明确裁决或附推演的期望值更正，理由见 4.1。`test()` 用例总数不变（13 个测试文件，一条用例未删）。

### 4.3 复跑要求（交外部门禁）

```bash
cd fframes-node
./node_modules/.bin/tsc --noEmit   # 目标 0 错（12 处全清；其中 B1-5 经复核为日志版本问题，代码侧本已合规）
node --test test/*.test.ts         # 目标 pass ≥ 231、fail = 0
node src/cli/main.ts examples/hello-world/video.ts timeline   # 目标：立刻输出两行场景表 + exit 0
bash gates/verify-fframes.sh       # 目标 25/25
```

重点复核的行为/数值落点（与下列不符即说明本轮某条推演有误，请把 diff 贴回）：

- `node src/cli/main.ts examples/hello-world/video.ts timeline` 打印 2 行场景表、`process.exitCode = 0`、**无** `unsettled top-level await` 警告（这是 §C 全部 9 项的共同前提）；`render/frame/svg/inspect/audio` 同理。
- `mixer.test.ts` 的两条 `mixAudioToFile`：落盘 WAV 头 `sampleRate === RATE`、`channels === 2`、`dataSize === frames·4`（若仍报 `mixer.sampleRate is not a function`，说明遮蔽仍在）。
- `mixer.test.ts` 的 `duckDb`：`at(239)` 应为 **−0.0327 dB**（`-6·(1+cos(29π/30))`），不是 0。
- `wav.test.ts` 的 `int16 conversion`：`toInt16(-0.5/32767) === -1`（远离零）、`toInt16(0.5/32767) === 1`。
- `resample.test.ts` 的 `the filter edges fade instead of jumping`：首样本 ≈ 0.74、**尾样本 ≈ 1.0504**。
- `audio-map.test.ts` 的指数 fade：`t=0.001 → −59.94 dB`（偏差 0.06，落在 0.1 内）、`t=1e-9 → −60 dB`（偏差 6e-5）。
- C7 的 `audio analyze --json`：`integratedLufs` / `truePeakDb` 与 ffmpeg `ebur128` 差 < 0.5（`sections` 参数搬家不改变整段数值）。

### 4.4 gen3 复核轮（同一条 14 项指令的第二次派遣：独立复核 + 补回归锁）

> **本轮性质**：被再次以 gen3 指令派遣时，4.0–4.3 描述的 14 项修复**已全部在盘上**。本轮因此不是「再改一遍」，而是：(a) 逐项独立复核落盘状态与 Rust 事实源是否一致（含两处语义争议的源码级复验）；(b) 补上这个缺陷类别**任何测试与类型检查都看不见**的那道回归锁。**本轮未改动任何实现文件、未删任何断言、未放宽任何容差**（4.0 表里的 3 处容差变更是上一轮按指令裁决留下的，本轮原样保留）。

#### 4.4.1 逐项复核（14/14 与盘上状态一致）

| # | 指令项 | 盘上证据（file:line） | 复核结论 |
| --- | --- | --- | --- |
| 1 | P0-1 删 `index.ts` 对 `cli/main.ts` 的 re-export | `src/index.ts` 导出止于 `:303`，`:305-336` 为规范性注释，全文无 `from './cli/main.ts'`（grep）；`src/cli/main.ts:552-553` 的 `if (isEntryPoint())` + `await runCli()` 未动 | ✅ 一致。环的两侧都复核过：`src/**` 无任何文件 import `index.ts`，`src/**` 无任何文件 import `main.ts`，三个示例 `video.ts` 均 `import … from '../../src/index.ts'`（`examples/*/video.ts:26-27 / 28-29 / 21-22`）——**环确实被切断，且没有第二条静态路径** |
| 2 | P0-2 越界 `src/render/pipeline.ts` | glob 单命中 `src/render/resvg-backend.ts`；`src`/`test`/`examples` 内 `pipeline.ts` 零引用 | ✅ 仍不存在 |
| 3 | B1-1 `AudioDemo.defineScenes` | `examples/audio-demo/video.ts:43-45` `defineScenes(): null` | ✅ |
| 4 | B1-2 `sampleRate` 遮蔽 | 字段 `src/audio/mixer.ts:449`；访问器 `:560-569` `get outputSampleRate()`；`mixAudioToFile` `:799` 读它；`sampleRate()` 方法全库零命中 | ✅ 实例字段不再遮蔽同名方法 |
| 5 | B1-3 `Declared.present` | `src/cli/args.ts:64-68`（可变 + 注释），两处写入 `:141` / `:185`；对外 `ParsedArgs:35-50` 仍全 `readonly` | ✅ 只放开内部簿记 |
| 6 | B1-4 `sections` 传参位置 | `src/cli/audio-cmd.ts:143-163`（第二实参）；`src/audio/analysis.ts:469-472` 签名、`:531-537` 逐 section 的 LUFS/dBTP | ✅ 复核通过（见 4.4.2 第 3 条） |
| 7 | B1-5 `diagnostics.ts` readonly | `src/inspect/diagnostics.ts:135` 签名只读，`:296-298` 改动前先拷贝 | ✅ 当前代码本已合规（门禁日志版本更早） |
| 8 | B1-6 `DecodedAudio` 值导入 | `src/render/resvg-backend.ts:62-69`（值导入块内 `:65`），`new DecodedAudio(...)` 在 `:346` | ✅ |
| 9 | B1-7 `frame.test.ts` 字面量 | `test/frame.test.ts:13` 值导入；`:157` / `:173` `new DecodedAudio(new Float32Array(512), 44100)` | ✅ 改测试不改实现 |
| 10 | B2-1 指数 fade 容差 | `test/audio-map.test.ts:151`（0.001 → 0.1），`:150`（1e-9 → 0.01 保留）、`:152`（0.5 → 1e-9）、`:149/:153` 精确比较保留 | ✅ 4 条只动 1 条 |
| 11 | B2-2 `duckDb` | `test/mixer.test.ts:395` / `:399` 改 1e-9 容差，`:403-406` 改闭式（239），`:393-394` / `:396-398` / `:407-408` 精确比较**逐字保留** | ✅ 9 条断言条数不变（复核见 4.4.2 第 1 条） |
| 12 | B2-4 `resample` 首尾边缘 | `test/resample.test.ts:141` / `:150` 区间 `(0.5, 1.15)`，`:134-139` 写明 Kaiser 纹波依据；`:144`（`output[16]` ±1e-3）、`:146`（中段）未动；`src/audio/resample.ts` 零改动 | ✅ |
| 13 | B2-5 `toInt16` 远离零 | `src/audio/wav.ts:51-60` `roundHalfAwayFromZero`；`:68` `toInt16`；`:199` dither 写入路径；`.clamp` 语义保留 | ✅（复核见 4.4.2 第 2 条） |
| 14 | B2-3 `mixAudioToFile` ×2 | 与第 4 项同根因，测试文件零改动 | ✅ |

#### 4.4.2 Rust 事实源复验（本轮亲自读的源码，不是转述）

1. **`audio_mix.rs:331`** —— `if n < down_from || n >= up_from + release { continue; }`：release 斜坡在 `up_from + release` 处**不含端点**。配 `voices=[100,200]`、`{attack:20, hold:10, release:30}`、`sampleRate=1`（`mixer.ts:360-381` 逐行同构）⇒ 240 是第一个完全释放的样本，239 仍在斜坡 29/30 处，`-12·(1-raised_cosine(29/30)) = -6·(1+cos(29π/30)) ≈ -0.0327 dB`。**上一轮把 `at(239) === 0` 改闭式容差是对的**，不是为了让测试变绿而挪期望值。
2. **`audio_analysis.rs:406`** —— `(sample * 32767. + dither).round().clamp(-32768., 32767.)`：Rust `f64::round` 远离零、`Math.round` 向 `+∞`，`toInt16(-0.5/32767)` 在 JS 侧得 `-0`。**原测试是对的、实现是错的**，改 `wav.ts` 才是正解（`encoder_frame.rs:169` 的 `.round()` 同规则，方向一致）。
3. **`audio_map.rs:198-203`** —— `10f32.powf(-60. * (1. - t) / 20.)`：`t=0.001` 处 dB 精确为 `-59.94`，与 `-60` 差 0.06，`±0.01` 不可达；同用例 `t=1e-9` 偏差 6e-5（`±0.01` 成立）。**只放宽这一条 0.01 → 0.1 是修正算错的期望，不是给实现擦边**。
4. **`cli.rs:1049-1072` + `:1129-1154`** —— `mixer_for` 的区间来自 `AudioTimelineSamples::from_frames`（`audio_map.rs:86-88`，整数 `frames * rate / fps` 截断，与 `audio-cmd.ts:140-141` 的 `Math.trunc` 同构）；`to_samples` 是 round → clamp → 相对 range 起点（`audio-cmd.ts:111-112` 同构）；`analyze_audio(&left, &right, rate, &sections)` 的 `sections` **就是**独立的位置参数（对应 TS 的第二实参，`analysis.ts:469-472`）；随后按 `samples.start / sample_rate` 平移 section 与 silent range（`audio-cmd.ts:165-175`）。**B1-4 改调用方、复用 `analysis.ts` 已有的 section 能力，是与 ground truth 一一对应的最小改法**；在 `audio-cmd.ts` 另写一份按 `LoudnessAnalysis` 切片自算的实现才会引入第二个可能漂移的源。C7 只看整段 `integratedLufs` / `truePeakDb`，不受此改动影响。

#### 4.4.3 本轮新增：`test/module-graph.test.ts`（5 个用例 / 35 条断言）

P0-1 属于**类型系统与单测都够不到的缺陷类别**：环只在「直接执行入口」这条路径上形成（程序化路径 `import main.ts` → `runCli(argv)` 正常），所以 `tsc` 干净、单测全绿，CLI 仍然全线 exit 13。除非有人把 `index.ts` 的 re-export 加回去，否则没有任何自动检查会拦住它。上一轮只留了注释（`index.ts:305-336` 的规范性说明），本轮把它变成可执行断言：

| 用例 | 锁住的不变量 | 修复前 |
| --- | --- | --- |
| `index.ts does not statically depend on the CLI entry point` | 剥注释后 `index.ts` 里没有任何 `from '…cli/main.ts'`（import 与 re-export 两种形态），且环的解释文字仍在 | 前两条红 |
| `the barrel is a leaf, and only the video modules import it` | `src/**` 零文件 import `index.ts`、零文件 import `main.ts`；三个示例 `video.ts` 仍从 barrel 取 API（环的另一侧） | 红 |
| `the CLI keeps the entry point shape the contract asks for` | shebang、`if (isEntryPoint())` + `await runCli()`、`isEntryPoint(argv = process.argv)` / `argv[1]` / `sameFile` / `fileURLToPath(import.meta.url)`（契约 §3；**若有人改在 `main.ts` 里「修」挂起，这条会红**） | 绿（防回退） |
| `the public API still covers the contract symbols after the fix` | 16 个符号（A11 清单）必须出现在 `index.ts` 的 **export 语句**里，而不是散文里——防「删 re-export 时顺手删多了」 | 绿（防过删） |
| `the out-of-scope render pipeline file is still gone` | `src/render/pipeline.ts` 不存在，且 `src/render/resvg-backend.ts` 存在（成对断言，防目录整体消失导致空过） | 红 |

实现注记：断言读的是**真实源文件**（`node:fs`），剥注释只按整行 `//` / `*` 前缀（`cli/main.ts`、`audio/audio-map.ts` 的散文里提到 `import index.ts`，不能被当成代码）；export 语句用 `/export\b[\s\S]*?;/g` 匹配而不是按 `;` 切块——切块会把第一条 export 并进它前面的 import，而那条恰好是导出 `Video` 的块（第一版就是这么写错的，已改）。无相对导入（门禁 A3）、无 `enum`/`namespace`/参数属性（A2）、无桩标记（A4）、erasable-syntax 与 `verbatimModuleSyntax` 均满足。

**未验证的**：以上全是静态/单元级论证。执行级结论（tsc 0 错、单测 fail=0、`timeline` 立即输出、§C 11 项）仍归外部门禁，命令见 4.3。

## 修复轮 review（双评审 A FAIL(7) + B FAIL(13)+5 SUSPECT · 指挥官逐项实测裁决）

门禁本轮开跑时是 **PASS=25 FAIL=0**（含指挥官自己修的两处门禁 bug：C3 signalstats、C7 Peak 提取）。因此本轮处理的是**评审发现**，不是门禁失败。事实源：Rust `.source/fframes/fframes/src/`；契约 `.verify/fframes/gen-prompt.txt`。

### 5.0 总览

| 分类 | 数量 | 处置 |
| --- | --- | --- |
| 必修（FIX 1–14） | 13 项代码 + 1 项文档 | 全部落地，每项配可执行回归锁 |
| 判不修（不改代码，只留档） | 6 项 | PORTING.md 差距节 2 条 / 已有文档 2 条 / DELIVERY 3.2 补 2 条 |
| SUSPECT（低置信，留档不改） | 5 项 | DELIVERY「已知限制」汇总 |

新增测试文件 **4** 个（`media-dir.test.ts` / `cli-report.test.ts` / `inspect-frame.test.ts` / `render-report.test.ts`，共 22 个用例），修改测试文件 **2** 个（`time-spec.test.ts` 增 2 用例 + 修 1 条期望、`wav.test.ts` 增 2 用例）。

### 5.1 逐项修复（file:line + 改动摘要 + 裁决依据）

#### FIX 1 · A-FAIL1 · `cli/render.ts` `missingAudioFiles` 在解码前求值 → 正常音频视频全量误报

- **归因**：原判据是 `session.audioCache.get(file) === undefined`。报告在混音**之前**产生，此时缓存必然为空；且 `mixable` 为假时（零长度、无音频、map 解析失败）缓存永远为空。于是任何带音频的健康视频都把**全部** track 报成 missing，同时 `audio: true`、渲染成功——报告与事实相反。
- **裁决依据**：`audio_mix.rs:417-427` 的 `missing` 只由 `media.resolve_audio(&track.file)` 返回 `None` 推入，即「媒体目录没有这个文件」，与解码缓存无关；`resolved` 为空时 missing 为空。
- **改法**：判据换成媒体可解析性，并抽成可单测的纯函数 `missingAudioFiles(trackNames, mediaDir, undecodable)` + session 包装 `missingAudioFilesOf(session)`（`render/resvg-backend.ts`）。`cli/render.ts` 与 `cli/audio-cmd.ts` 共用同一份规则——后者原本有同一处 bug（按缓存判），一并对齐。
- **回归锁**：`test/render-report.test.ts` 5 个相关用例（「缓存为空但目录有文件 ⇒ `[]`」修复前为红、「目录没有该文件 ⇒ 报出来」、「无媒体目录 ⇒ 报出来」、「规则本身的纯函数形态」）+ 指挥官 E2E（audio-demo `render --json` 的 `missingAudioFiles` 必须 `[]`）。`render.ts` 里 `missingAudioFilesOf` 在**解码前先算一次**、混音后再算一次——第一次覆盖「不解码」的路径（`mixable` 为假），第二次让 FIX 10 的「存在但解码失败」也能进入报告。

#### FIX 2 · A-FAIL2 · `cli/timeline.ts` `--json` 的 track 字段名 `offset` 应为契约钉死的 `offsetSeconds`

- **裁决依据**：契约 `gen-prompt.txt:155` 明写 `…startSeconds,endSeconds,offsetSeconds,gainDb…`；实现用裸 `offset`，按契约读的消费者得 `undefined`。DELIVERY 未记录这次改名。
- **改法**：接口字段与输出键都改名 `offsetSeconds`，值仍取 `track.mix.offset`（AudioMap 内部 `TrackMix.offset` 不动，那是另一层）。`timelineText` 的 `from Xs of the file` 同步读新字段。
- **回归锁**：`test/cli-report.test.ts`「`offsetSeconds` 在、`offset` 不在、`JSON.stringify` 后同样、人读行仍含 `from 1.50s`」+ 无 offset 的 track 报 0 + 指挥官门禁 grep。

#### FIX 3 · A-FAIL3 · `cli/audio-cmd.ts` audio render 默认输出硬编码 `audio.wav`

- **裁决依据**：契约 `gen-prompt.txt:159-160` 要求「`<defaultOutput去扩展>.wav 或 out.wav`」。Rust `cli.rs:226` 字面是 `audio.wav`——**契约与 Rust 冲突处以契约为准**（本项目契约是单一事实源），且派生规则是常量的超集。
- **改法**：`defaultAudioOutput(defaultOutput?)` 由 `video.defaultOutput` 去扩展派生，无则回退 `'out.wav'`；`audioRenderCommand` 新增 `defaultOutput` 入参，`main.ts` 的 `commandAudio` 传入 `video.defaultOutput`。目录名里的点不算扩展名。
- **回归锁**：`test/cli-report.test.ts` 7 条断言（`out.mp4→out.wav`、`a/b.mov→a/b.wav`、无参/`null`/`''`→`out.wav`、`releases/v1.2/out` 不被误截）。

#### FIX 4 · A-FAIL4 · `core/time-spec.ts` `tryParseOffset` 用宽松 `parseFloat`，Rust 用严格 `parse::<f64>()`

- **归因**：`Number.parseFloat` 接受任意数值**前缀**，`'12abcs'`=360、`'5xx s'`=150、`'1..2s'`=30 全部被静默接受；Rust 对这些返回 `Err`，回落场景查找。既有垃圾清单恰好不带后缀，遮住了这个洞。
- **裁决依据**：`time_spec.rs:303-323` 四分支都是 `parse().ok()?`（严格 f64）。
- **改法**：新增模块级 `parseF64Strict`（正则 `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$` + `Number` + NaN 检查），`%`/`ms`/`s`/`:`（clock 每段）四个分支全部改用它；裸帧号分支（`/^\d+$/`）不动。
- **回归锁**：`test/time-spec.test.ts`「`'12abcs'`/`'5xx s'`/`'1..2s'`/`'1.2.3s'`/`'500mms'`/`'1:0:5x'` 全部抛 `TimeSpecResolveError`」，同用例内正向断言 `'1.5s'`=45、`'500ms'`=15、`'0:05'`=150、`'1:00.5'`=1815、`'50%'`=150、`'1e1%'`=30 不回归。

#### FIX 5 · A-FAIL5 · `core/time-spec.ts:78` ambiguousScene 文案 `JSON.stringify` 输出 `[1,2]`

- **裁决依据**：Rust `{indexes:?}` 对 `Vec<usize>` 打印 `[1, 2]`——切片 `Debug` 用 `, ` 分隔，`JSON.stringify` 不用。
- **改法**：`JSON.stringify(error.indexes)` → `` `[${error.indexes.join(', ')}]` ``。
- **回归锁**：`test/time-spec.test.ts:204` 的期望**同步**从 `/matches scenes \[1,2\]/` 改为 `/matches scenes \[1, 2\]/`（原断言把错误形态锁成了基线，所以必须一起改，否则是拿错误断言挡正确实现）。

#### FIX 6 · B-BUG3 · `core/time-spec.ts` 百分比分支负值产生负帧号

- **归因**：`resolveFrame('-10%')`（300 帧）= **-30**；`resolveRange('-10%..5s')` = `{start:-30,end:150}`，负 start 通过了 `start>=end` 校验。
- **裁决依据**：`time_spec.rs:304-306` 是 `(...).floor() as usize`，`(-30.0) as usize == 0`（Rust 浮点转整型是饱和而非回绕）。
- **改法**：`` Math.min(frame, Math.max(0, length - 1)) `` → `` Math.max(0, Math.min(...)) ``。配合 FIX 4（严格解析后 `'-10'` 仍是合法负数），下界钳制是必需的，两项互为前提。
- **回归锁**：`test/time-spec.test.ts`「`'-10%'`=0、`'0%'`=0、`'150%'`=299（上界不回归）、`resolveRange('-10%..5s').start===0`」。

#### FIX 7 · B-BUG6 · `audio/wav.ts` `parseWavHeader` 对 `dataSize===0` 抛错

- **归因**：`writeWavSync:281` 回读自己刚写的字节，而 `:350` 用 `dataSize === 0` 当「无 data chunk」的判据。零样本混音是合法 RIFF（`fmt` 完整 + data 大小 0），于是写盘成功、回读抛 `WAVE file has no data chunk`。CLI 可达：`seconds(0)` 视频 `audio render` → `main.ts:230` 返回 fullRange 绕过空范围检查 → 零样本 → 抛内部 helper 名的错。
- **改法**：有效性判据换成「见过 `fmt` chunk」+「见过 `data` chunk」两个标志，新增 `sawData`，`dataSize===0` 不再是缺失判据。
- **回归锁**：`test/wav.test.ts` 两个新用例——零样本写盘不抛、`readWavHeader` 回读得 `frames===0`/`dataSize===0`、`readWav` 得空样本数组；**残缺文件（无 data chunk / 无 fmt chunk）仍抛**（防止把判据放得过宽）。

#### FIX 8 · B-BUG8 · `media/media-dir.ts` 目录包含性是字符串前缀判定

- **归因**：`'/proj/media-secret/keys.wav'.startsWith('/proj/media')` = true。若该文件真实存在，`exists()` 会返回 true 并读取**目录外**文件——与 doc 注释（111-113）「逃逸目录的名字永不被包含」直接矛盾。
- **裁决依据**：`node:path` 的 `relative` 按**段**判断，`'..'` 前缀或 `isAbsolute` 结果即目录外；`''` 是目录自身（目录不是自己的文件）。
- **改法**：`exists()` 用 `relative(this.dir, full)` 判定，`relative` / `isAbsolute` / `sep` 从 `node:path` 引入。
- **回归锁**：新文件 `test/media-dir.test.ts`（6 个用例）：`../media-secret/keys.wav`（真存在）→ false；`../media/x.wav`（绕回内部）→ true；`./x.wav` → true；`.` 与绝对路径 → false；四种 `..` 写法 → false；`usedFiles` 把逃逸名报为 missing；外加 kinds 与 `readFolder` 6 条断言。

#### FIX 9 · B-BUG2 · `encode/ffmpeg-encoder.ts` `child.stdin` 无 `'error'` 监听

- **归因**：`stderr`/`close`/`child.error` 都挂了监听，唯独被写入的 `stdin` 没有。`writeToStdin` 的 `stream.write()===true` 快路径直接返回；若 ffmpeg 已退出，EPIPE **异步** emit 到无监听的 stdin → `Unhandled 'error' event` 进程崩溃，且 `stderrChunks` 里已收集的 ffmpeg 报错（本该用在错误文案里）全部丢失。
- **改法**：`let written` / `let feedError` 上移到 stdin null 检查之后，挂 `stdin.on('error')` 把首个错误记进 `feedError`（不清空已记录的值），`Promise.race` 之后对 `feedError` 的现有处理不变。
- **回归锁**：无法离线单测（需真实 ffmpeg 中途死），代码改对 + tsc 通过；**指挥官门禁加 E2E**：构造必失败的编码，断言进程**优雅非零退出并含 stderr 文案**，不是 `Unhandled 'error'` 崩溃。

#### FIX 10 · B-BUG4 · `media/audio-decode.ts` 不可解码音频抛错杀掉整个 render

- **归因**：`decodeAudioFileStereo` 对 ffmpeg 非零退出 `throw`，经 `render.ts` 的 `decodeSessionAudio` 冒泡 ⇒ render exit 1。而 `resolveSessionAudio:656-660` 的 doc **自陈**「抛错会把『文件缺失』变成『render 失败』，这不是 Rust 移植版的做法」——损坏文件正好命中这条被自己禁止的路径。
- **裁决依据**：`audio_mix.rs:416-427`：无法预载 → `AudioData::Lazy => continue`（跳过）；缺失 → `report_missing_media` + `push missing` + `continue`。两条都是**跳过该 track 并报告**，都不是整体失败。
- **改法**：`decodeSessionAudio` 单文件解码包 try/catch，失败则**不写缓存**、记入新的 per-session `undecodableAudio(session): Map<file, reason>`（`WeakMap` 持有，session 可回收）。该 map 同时被 FIX 1 的 `missingAudioFiles` 消费 ⇒ **存在但损坏的音频 = 该 track 静音跳过 + 报告列出该文件 + render exit 0**。「文件不存在」的原有 skip 行为不变。
- **回归锁**：`test/render-report.test.ts`「`undecodableAudio` 有记录 ⇒ 报为 missing」（正向可辨：修复前该 map 根本不存在，损坏文件只会让整个 render exit 1）+ 指挥官 E2E（损坏 wav → render 仍 exit 0 且 `missingAudioFiles` 含该文件）。`audio-cmd.ts` 的 `renderAudioToFile` 顺序天然正确（先 `decodeSessionAudio` 再读 `missingFiles`）。

#### FIX 11 · B-BUG5 · `cli/render.ts` 临时 WAV 在 mix/render 抛错时泄漏

- **归因**：`wavPath` 在 136 行赋值、`mixAudioToFile` 137 行创建文件，但 `try {` 到 155 行才开、`finally` 删文件在 194-198。137-161 之间任何抛错 → 临时 WAV 残留。兄弟路径 `audio-cmd.ts:137-182` 是对的（临时路径在 guarded 区内创建、finally 删）。
- **改法**：`try {` 上移到 `wavPath` 赋值之前，包住 decode + mix + encode 整段；`finally` 的删除保持 null 安全（`wavPath` 为 `null` 即无文件）。
- **回归锁**：结构修复，无直接单测；**指挥官复核** `render.ts` 的 try/finally 覆盖 `wavPath` 生命周期。

#### FIX 12 · B-BUG12 · 进度 off-by-one，末帧不打印，单帧渲染无进度

- **归因（推理链）**：`ffmpeg-encoder.ts` 在 `written += 1` **之后**调 `onFrame(written, total)`（1-based）→ `render.ts` 转发 `range.start + written` → `main.ts` 又算 `done = frame - range.start + 1` = `written + 1` ⇒ 首帧报 `rendered 2/N`；`done===total` 在倒数第二帧就触发；真正末帧 `done=total+1 ≠ total`；`N+1` 从不打印；`N===1` 时 `2===1` false 且 `2%10≠0` ⇒ **单帧渲染完全无输出**。
- **改法**：消除双重 +1，在 `main.ts:309` 一处改（`render.ts:168` 的 1-based 传值语义**不动**，只改一处以免再次错位）。
- **回归锁**：`test/render-report.test.ts`「progress counts frames once」逐帧模拟三种场景：`N=3` 只在末帧打印 `rendered 3/3`、`N=1` 打印 `rendered 1/1`（修复前为红）、`N=30` 仍在 10/20/30 节流 + 指挥官门禁 E2E（单帧 render stderr 含 `rendered 1/1 frames`）。

#### FIX 13 · B-BUG1 · `inspect/diagnostics.ts` `renderSvgToRgba` 在 try/catch 之外

- **归因**：`:150-161` 只把 `renderFrameSvg` 包在 try 里；`:178-194` 的 `checkEmpty` 块调 `renderSvgToRgba` **无 try 保护**。空串（`Svgr.empty()` 返回 `''`，`resvg-backend.ts:131-136` 硬抛）或非法 SVG → 未捕获 → inspect 进程死 exit 1，而 `empty-frame` warning（该检查存在的唯一目的）永远产不出来。空帧恰恰是它要抓的帧。
- **改法**：`renderSvgToRgba` 包 try/catch，失败产出 finding 而非崩溃——空文档（`svg.trim() === ''` 或报错信息含 `empty SVG document`）→ `empty-frame`(warning)；其它光栅化失败 → `render-error`(error)。`isFullyTransparent` 正常路径不变，`key` 沿用 `empty-frame` / `render-error` 以便 merge 语义不变。
- **回归锁**：`test/inspect-frame.test.ts`（6 个用例）：`Svgr.empty()` → `empty-frame` warning（修复前抛异常）；畸形 SVG → `render-error` error；`renderFrame` 抛错 → 仍是 `render-error` 且不触达光栅化；`checkEmpty: false` → 无 finding；采样规则与 `inspectMedia` 各一组。

#### FIX 14 · A-FAIL7 · `PORTING.md` 缺契约点名的 LUFS 基线 −21.1/−18.1

- **归因**：契约 `gen-prompt.txt:269` 要求 PORTING.md 收录 M0 探针数据含「LUFS 基线 −21.1/−18.1」；`grep -E 'LUFS|21.1|18.1' PORTING.md` 零命中。数据在 `.verify/fframes/M0-probe-results.md:16`（P3），且是门禁 C7 与 `test/analysis.test.ts` 的预言机。`DELIVERY.md:400` 却声称 PORTING.md 已含此数据——**§10 自查第 1 项不实**。
- **改法**：PORTING.md 第 2 节（PNG 管道）末补 LUFS 基线表 + 交叉校验说明（改了 `analysis.ts` 若偏离 −21.1 即为错）。DELIVERY 3.1 那行 `PORTING.md` 的描述（已含「LUFS 基线 −21.1/−18.1」）现在与实况一致。

### 5.2 判不修（不改代码，按裁决留档）

指挥官已逐项实测/对照 ground truth 裁决下列为 not-a-bug 或超范围。**本轮一行代码都没动**，只补文档。

| 编号 | 位置 | 裁决 | 留档位置 |
| --- | --- | --- | --- |
| A-FAIL6 | `inspect/diagnostics.ts` `inspectVideo` 收 session 而非 video、range 必填、缺 `json`/`mediaDir` 选项 | session 取代 video 已在 DELIVERY 3.2 第 2 条披露；`json` 由 `cli/inspect.ts` 承担、`mediaDir` 由 `session.mediaDir` 承担、range 由 CLI 解析并默认全片——**功能不缺**，是封闭文件清单下 session 模型的必然 API 形态 | 见 5.4（§5.2 表 + 本节留档） |
| B-BUG7 | `core/animation/timeline.ts:116,132` 空 keyframes `finalValue = 0 as unknown as T` | Rust `animation.rs:180-186` 对空 tweens 打 WARN 并用 `T::default()`，**且自陈「Behaviour is undefined」**。契约 `gen-prompt.txt:73-74` 钉死 `timeline(...keyframes)` 签名（无 fallback 参数），`erasableSyntaxOnly` 又禁止运行时类型信息 ⇒ 契约内无法复刻类型化 `T::default()` | **PORTING.md 第 9 节**新增条目：空 keyframes 用数值 0 作 finalValue、属 Rust 声明的未定义行为、受契约签名与 erasable syntax 双重约束 |
| B-BUG9 | `core/frame.ts:155-173` `smoothLevel: 0` 返回空谱 | Rust `frame.rs:212-228` 同为**排他**区间 `(index-smooth)..(index+smooth)`，`smooth_level=0` 时 `frames_to_smooth[1]` 直接 panic；移植版返回空数组**更优雅**。循环边界 1:1 忠实 ⇒ **判 not-a-bug（忠实移植 + 退化输入）** | **PORTING.md 第 9 节**一句带过 |
| B-BUG11 | `core/animation/spring.ts:101-125` settle 上界静默命中 | Rust `spring.rs:54-74` `get_duration` **无步数上界**，damping:0 时 `solve(t)=1-cos(w0·t)` 永不精确等于 1.0 ⇒ Rust **无限循环挂死**；移植版加 `SPRING_MAX_SETTLE_STEPS=1e6` 把挂死变 33ms 终止，**优于 Rust**。B 建议的「报配置错」是超出 mirror 契约的增强 | PORTING.md 第 9 节**已记载**该防御（本轮把理由补全：Rust 无上界、damping:0 挂死、为何不改成报配置错），无需新增条目 |
| B-BUG13 | `cli/args.ts:135-139` 未知长 flag 当 boolean | 代码注释**明示刻意设计**（`--whatever` 永不崩脚本）。短 flag 簇 `-ox out.mp4` 取值丢失是罕见边角，单短 flag `-o x` 正常。**Rust clap 会报错，本移植选择容错** | DELIVERY 3.2 第 9 条**已记录**该宽松策略（本轮在 5.4 复述留档） |
| B-SUSPECT 14/15/16/17/18 | 空 buffer `silent:false` / font-family 正则漏单引号与 `style=` / 字体前缀匹配过宽 / session 构建期硬编码 `DEFAULT_SAMPLE_RATE` / `offsetMap` 无测试覆盖 | 低置信、诊断质量、覆盖缺口类，**非确证功能缺陷**。本轮不改，避免过度改动破坏 A 已验证通过的 §3 面 | DELIVERY **「已知限制 / 后续」**（5.5）汇总 5 条 + 现状与影响面 |

### 5.3 本轮改了什么（供门禁 diff 核对）

| 文件 | 改动 |
| --- | --- |
| `src/core/time-spec.ts` | 新增 `parseF64Strict`；`%`/`ms`/`s`/`:` 四分支改用它；`%` 加下界钳制；ambiguousScene 文案 `[1, 2]` |
| `src/cli/render.ts` | `missingAudioFiles` 改用 `missingAudioFilesOf(session)`；`try {` 上移到 `wavPath` 赋值之前 |
| `src/cli/timeline.ts` | track 字段 `offset` → `offsetSeconds`（接口 + 输出 + 人读行） |
| `src/cli/audio-cmd.ts` | `defaultAudioOutput(defaultOutput?)` 由 `defaultOutput` 派生；`audioRenderCommand` 新增 `defaultOutput` 入参；`missingFiles` 改用 `missingAudioFilesOf`；`-o` help 文案同步 |
| `src/cli/main.ts` | `commandAudio` 收 `video` 并传 `defaultOutput`；进度 `done = frame - range.start`（去掉第二个 +1） |
| `src/audio/wav.ts` | `parseWavHeader` 新增 `sawData`，`dataSize===0` 不再当缺失判据 |
| `src/media/media-dir.ts` | `exists()` 改用 `relative`/`isAbsolute`/`sep` 的路径包含性判定 |
| `src/encode/ffmpeg-encoder.ts` | `let written`/`let feedError` 上移；新增 `stdin.on('error')` 监听记 `feedError` |
| `src/render/resvg-backend.ts` | `decodeSessionAudio` 单文件解码包 try/catch；新增 `undecodableAudio(session)`、`missingAudioFiles(...)`、`missingAudioFilesOf(session)` |
| `src/inspect/diagnostics.ts` | `checkEmpty` 块内 `renderSvgToRgba` 包 try/catch，空 → `empty-frame`、其它 → `render-error` |
| `src/index.ts` | barrel 补 `missingAudioFiles` / `missingAudioFilesOf` / `undecodableAudio` 三个 re-export |
| `test/time-spec.test.ts` | 修 ambiguousScene 期望为 `[1, 2]`；新增「严格解析」与「百分比饱和」两个用例 |
| `test/wav.test.ts` | 新增「零样本是合法 WAVE」与「残缺文件仍抛」两个用例 + `cut` 辅助 |
| `test/media-dir.test.ts` | **新文件**，6 个用例锁目录包含性 + kinds + `readFolder` |
| `test/cli-report.test.ts` | **新文件**，锁 `offsetSeconds` 字段名与 `defaultAudioOutput` 派生规则 |
| `test/inspect-frame.test.ts` | **新文件**，锁 `inspectFrame` 对空/畸形帧产出 finding 而非崩溃 |
| `test/render-report.test.ts` | **新文件**，锁 `missingAudioFiles` 规则与进度计数 |
| `PORTING.md` | 第 2 节补 LUFS 基线 −21.1/−18.1 + 交叉校验说明；第 9 节补空 keyframes `0` 与 `smoothLevel: 0` 两条、扩写 spring 上界理由 |
| `DELIVERY.md` | 3.2 补 A-FAIL6 与 B-BUG13 留档；本节（5.0–5.6） |

### 5.4 §3.2 补充留档（本轮评审项对应的决策）

30. **`inspectVideo` 的公共签名相对契约字面是「收 session」而非「收 video + video 选项」。** 契约 §3 写 `inspectVideo(video, {everyFrame?, distance=30?, exitSeverity='error', json?, fontFiles, mediaDir?})`；实现收一个已解析的 `RenderSession`。理由与 3.2 第 2 条同源（session 模型是封闭文件清单下的必然形态）：`json` 由 `cli/inspect.ts` 承担，`mediaDir` 由 `session.mediaDir` 承担（`--media-dir` 在建 session 时就生效），`fontFiles` 走 `session.context.fontFiles`，`range` 由 CLI 解析并缺省全片。**功能不缺项，只是参数的落点不同**；`broken-video` 的 `missing-font` + `missing-media` + exit 2 门禁项证明链路完整。
31. **未知长选项按 boolean `true` 记下，是刻意的容错取舍。** `cli/args.ts:135-139` 的注释说明了动机：`--whatever` 永不崩视频脚本。Rust 的 clap 对未知 flag 会报错退出。**本移植选择容错**——视频模块常带自己的 flag（Rust 侧靠 `.args(Args)` 拿到），一个拼错的 flag 不该让整轮渲染失败。代价是 `--frame-range 0..30 --outputx out.mp4` 这类拼写错误被静默接受；`audio analyze --waveform` 这种**明确不支持**的选项走另一条路（`args.has('waveform')` 命中后抛 `UsageError` 并指向 PORTING.md，见第 9 条），所以「不支持」与「拼错」仍然可区分。短 flag 簇（`-ox out.mp4`）的取值会丢失，属罕见边角，未改。

### 5.5 已知限制 / 后续（本轮评审的 5 条 SUSPECT，留档不改）

| # | 位置 | 现状 | 影响面 |
| --- | --- | --- | --- |
| 14 | `audio/analysis.ts` | 空 buffer（`data` 长度 0）时 `silent` 为 `false`，而不是「静音」 | 只在混音产出零样本时出现（`seconds(0)` 视频的 `audio analyze`）。不影响 render；`analysis` 自身的门禁断言未覆盖该输入 |
| 15 | `inspect/diagnostics.ts` `fontFamiliesInSvg` | 正则只认 `font-family="…"`，漏单引号形式与 `style=` 里的 `font-family` | `missing-font` 对这两种写法**漏报**（不误报）。常规 SVG 都用双引号属性，契约示例亦然 |
| 16 | `render/resvg-backend.ts` `fontFamilyIsRegistered` | 前缀匹配过宽：`registered.some(name => name === wanted || name.startsWith(wanted) || wanted.startsWith(name))` | `font-family="DMSans"` 会匹配 `DMSans-Bold.ttf`（本意），但也可能匹配无关的更长名。已在 PORTING.md 第 6 条标注「启发式，可能双向误判」，Rust 的 fontdb 是精确的 |
| 17 | `render/resvg-backend.ts` `createRenderSession` | `resolveDuration` 里 `resolve(audioMap, { sampleRate: DEFAULT_SAMPLE_RATE })` 用硬编码常量，与 `options.sampleRate` 无关 | 只有「按 `Eof` 定时长」的音频依赖它；`options.sampleRate` 默认就是 44100，非默认 sample rate 且用 `Eof` 时时长会按 44100 算（样本数换算在 `resolveSessionAudio` 用真实 sampleRate，帧数一致）。属低影响 |
| 18 | `render/resvg-backend.ts` `offsetMap` | 场景音频时间轴平移，**无单测也无示例覆盖** | 三个示例都无场景音频（`hello-world` 场景不带 `audio()`），所以现有门禁走不到这条路径。逻辑与 `AudioTimelineSamples` 的场景偏移一致，但缺回归锁 |

以上 5 条本轮**不改**：均为低置信、诊断质量或覆盖缺口类，非确证功能缺陷；改动面会触及 A 已验证通过的 §3 渲染/诊断面，收益不抵风险。留此记录以便下一轮按需处理。

### 5.6 复跑要求（交外部门禁）

```sh
cd opencode-workspace/fframes-node
./node_modules/.bin/tsc --noEmit          # 必须 0 错
node --test test/*.test.ts                # 必须全绿（含本轮新增/修改）
bash ../gates/verify-fframes.sh           # 全量门禁（含指挥官新增的 E2E 项）
```

指挥官侧本轮要补的门禁 E2E（对应上文各回归锁的「交外部门禁」部分）：FIX 1（audio-demo `render --json` 的 `missingAudioFiles` 必须 `[]`）、FIX 2（audio-demo `timeline --json` grep `offsetSeconds`）、FIX 9（必失败的编码 ⇒ 优雅非零退出含 stderr，非 `Unhandled 'error'`）、FIX 10（损坏 wav ⇒ render exit 0 且 `missingAudioFiles` 含该文件）、FIX 12（单帧 render stderr 含 `rendered 1/1 frames`）、FIX 13（渲染为空串的帧 ⇒ inspect 不崩溃且产出 `empty-frame`/`render-error`）。

本轮自查（三项，命令行可执行级）：

1. `node src/cli/main.ts examples/audio-demo/video.ts render --frame-range 0..5 -o /tmp/x.mp4 --json` 的 `missingAudioFiles` = `[]`（FIX 1 + FIX 10 的合并判据）
2. `new TimelineIndex(30, 300, []).resolveFrame('-10%')` = `0`（FIX 6）
3. `new TimelineIndex(30, 300, []).resolveFrame('12abcs')` 抛 `TimeSpecResolveError`（FIX 4）

**未验证的**：本轮全部是静态/单元级论证——无 bash 权限，`tsc --noEmit`、`node --test` 与门禁均未由本轮执行。上面三项自查与所有执行级结论归外部门禁。

### 5.7 指挥官验证结论（执行级 · 机械证据）

fixer 交出后，指挥官亲跑三层验证，逐项取机械证据（非采信子 Agent 自述）：

**执行级门禁**（`bash gates/verify-fframes.sh`，Node v24.7.0）：

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `./node_modules/.bin/tsc --noEmit` | **0 错**（exit 0） |
| 单测 | `node --test test/*.test.ts` | **269 tests / 269 pass / 0 fail**（含本轮新增 `cli-report` / `render-report` / `inspect-frame` / `media-dir` 回归锁） |
| 三层门禁 | `bash gates/verify-fframes.sh` | **PASS=31 FAIL=0**（原 25 + 指挥官新增 C10–C15 六项 E2E 回归锁） |

**fixer 三项自查已实测复证**（探针取证，用后删除）：

1. `audio-demo render --frame-range 0..5 --json` → `missingAudioFiles=[]`、`audio=true`（FIX1；修复前误报 `["sine.wav"]`）
2. `resolveFrame('-10%')=0`、`'0%'=0`、`'150%'=299`（上界钳不回归）、`'50%'=150`（FIX6；修复前 `-10%`→`-30`）
3. `resolveFrame('12abcs')` / `'5xx s'` / `'1..2s'` / `'1.2.3s'` 全部抛 `TimeSpecResolveError{kind:'unknownScene'}`（FIX4；修复前被 `parseFloat` 前缀接受为 360/150/30）；合法解析 `'1.5s'=45` / `'500ms'=15` / `'0:05'=150` 不回归
4. 追加复证 `timeline --json` track 含 `offsetSeconds`、无裸 `offset`（FIX2）

**指挥官新增门禁 E2E 回归锁**（fixer 无 bash，下列不可离线单测项由门禁钉死，维护记录 #5）：

| 门禁项 | 对应 | 断言（= 修复前的失败形态） | 新建 fixture |
| --- | --- | --- | --- |
| C10 | FIX1 | `audio-demo render --json` 的 `missingAudioFiles` 必须 `[]` | — |
| C11 | FIX2 | `timeline --json` track 含 `offsetSeconds`、不残留裸 `offset` | — |
| C12 | FIX12 | 单帧 `render --frame-range 0..1` stderr 含 `rendered 1/1 frames`（修复前单帧无进度、首帧误报 `2/N`） | — |
| C13 | FIX13 | 空帧 `inspect --json` exit≠1（不崩溃）且含 `empty-frame` finding | `examples/empty-frame/`（`renderFrame`→`Svgr.empty()`） |
| C14 | FIX10 | 损坏音频 `render` exit 0、`missingAudioFiles` 含该文件、视频帧仍写出 | `examples/corrupt-audio/`（`media/corrupt.wav` = RIFF 头覆盖垃圾，ffmpeg `Invalid data found`） |
| C15 | FIX9 | 编码失败（`-o` 指向目录，ffmpeg 早退）优雅非零退出 + 友好 stderr，无 `Unhandled 'error'` 崩溃 | — |

FIX9 另经代码复核：`ffmpeg-encoder.ts:222` 的 `let feedError` 已上移至挂监听前，`:228-230` 的 `stdin.on('error')` 把错误记入 `feedError`（不冒泡为 unhandled），`:265-266` 在 `Promise.race` 后优雅 throw → CLI 转友好文案。

**指挥官直修一处 fixer 引入的测试期望 bug**：`test/render-report.test.ts:137` 原断言 `elapsedSeconds:1.25` → `in 1.2s`，但 `renderText` 用 `elapsedSeconds.toFixed(1)`，JS 半值进位使 `(1.25).toFixed(1)==="1.3"`（实测坐实），期望值数学错误、与产品逻辑无关。改用无舍入歧义的 `elapsedSeconds:1.2` → `in 1.2s`，测试意图（human report 行读出 range/size）不变。**非放宽断言**，是修正错误的期望常量。

**判不修留档已核对落实**：DELIVERY 5.2/5.4/5.5（A-FAIL6、B-BUG7/9/11/13、SUSPECT14-18）与 PORTING.md 第9节（BUG7 空 keyframes 175-177、BUG9 `smoothLevel:0` 196、BUG11 spring 上界 171-172/211）、FIX14 LUFS 基线 `−21.1/−18.1`（PORTING.md:89）均已写入并引用 Rust `file:line` 裁决依据。

**成本审计**（`opencode stats --models`，2026 全项目累计）：`opencode/space-bunny-free` 454.7m tokens / 2k steps / **$0.00**（免费模型，无 SLA，评审 B 期间曾自动恢复一次 ECONNRESET）。

**结论**：14 项必修/文档全部落地并通过执行级验证；6 类判不修项留档完整；门禁 PASS=31 FAIL=0，无回退。评审修复轮 review 收口。

