---
name: fframes-node
description: Author and render programmatic videos with the fframes-node CLI. Use when the user wants to render/preview a video.ts, inspect frames, print SVG, list the timeline, mix or analyze audio, write a new fframes video script (Video/Scene/renderFrame, animation, audio map, fonts, media), or create art-style animations using the integrated huashu-art-motion module (35 art styles, 9 explainer grammars, transitions).
---

# fframes-node — CLI & video scripting

`fframes-node` is a programmatic video framework: a video is a TypeScript module that turns a
frame number into an SVG tree, which is rasterized on the CPU (resvg) and encoded with `ffmpeg`.
There is **no build step** — Node ≥ 24 strips the types and runs the `.ts` files directly.

Run every command **from the `fframes-node` repo root**.

---

## 0. Dependencies & setup

Before the first render, make sure the runtime dependencies are installed. From the repo root:

```sh
# 1. Node ≥ 24 (the sources are TypeScript run through Node's native type stripping)
node --version          # must print v24 or newer

# 2. npm packages — installs @resvg/resvg-js (the SVG rasterizer); no build step
npm install

# 3. ffmpeg + ffprobe must be on PATH — encoding, audio decoding, duration probing
ffmpeg -version && ffprobe -version
```

| Dependency | Why it is needed | How to get it |
| --- | --- | --- |
| **Node ≥ 24** | Runs `.ts` directly (type stripping); older Node cannot load the modules. | `nvm install 24 && nvm use 24` |
| **`@resvg/resvg-js`** | CPU rasterizer behind every frame (`src/render/`). | `npm install` (listed in `dependencies`) |
| **ffmpeg / ffprobe** | `render` / `audio render` encode video+audio; `duration()`/probing reads media lengths. | `brew install ffmpeg` (macOS) / your package manager |
| **Fonts** | The renderer registers **exactly** the files returned by `fonts()`; system font loading is off. | Reference real font files (e.g. `/System/Library/Fonts/Helvetica.ttc`). |

- Only `@resvg/resvg-js` is a runtime npm package; `typescript` and `@types/node` are dev-only
  (`npm run typecheck` uses them, rendering does not).
- If `npm install` fails on `@resvg/resvg-js`, it is almost always a Node version mismatch — check
  `node --version` first.
- `render`/`audio render` shell out to **ffmpeg**; if it is missing they fail at encode time even
  though `timeline`, `svg` and `inspect` still work.
- Optional: `npm link` registers a global `fframes` bin, so you can run `fframes <video.ts> …`
  instead of `node src/cli/main.ts <video.ts> …`.

Verify the setup with a cheap command before rendering:

```sh
node src/cli/main.ts examples/hello-world/video.ts timeline   # loads the module, no ffmpeg needed
node src/cli/main.ts examples/hello-world/video.ts render --draft -o draft.mp4   # full pipeline
```

---

## 1. The CLI

### Invocation

```sh
node src/cli/main.ts <video.ts> [command] [options]
```

- `<video.ts>` — path to a video module (relative paths resolve against the current directory).
- `[command]` — one of `render` (default), `frame`, `svg`, `timeline`, `inspect`, `audio`.
- The module is loaded by dynamic `import()`; its **default export** is a `Video`, or a factory
  `() => Video | Promise<Video>` (so a video can build itself from its own flags).

The package declares a `fframes` bin (`./src/cli/main.ts`). After `npm link` you can write
`fframes <video.ts> …` instead of `node src/cli/main.ts <video.ts> …`.

### Global options (every command)

| Flag | Meaning |
| --- | --- |
| `--json` | Print **exactly one** JSON document on stdout; everything else goes to stderr. |
| `--scale <n>` | Resolution factor, e.g. `0.5` for half resolution. |
| `--media-dir <dir>` | Folder audio/images resolve from (default: a `media/` folder next to the module). |
| `-h`, `--help` | Command help (the video module is not loaded for `--help`). |

### Output & exit codes

- The report goes to **stdout**; progress, warnings and errors go to **stderr**.
- Exit `0` on success, `1` on a usage/runtime failure (`error: <message>` on stderr),
  `2` when `inspect` finds something at the `--exit-code` severity.
- Unknown flags never crash a script (kept as booleans); `--frame-range -5..5` works because a
  value flag only consumes the next token if it is not itself a declared option.

### Commands

**`render`** — the whole video, or a range.
```sh
node src/cli/main.ts examples/hello-world/video.ts render -o hello.mp4
node src/cli/main.ts examples/hello-world/video.ts render Intro..Outro --draft
```
| Flag | Meaning |
| --- | --- |
| `--frame-range <spec>`, or a positional RANGE | Only render this range (e.g. `Intro`, `10s..20s`). |
| `-o`, `--output <file>` | Output file; `out.mp4` (or `Video.defaultOutput`) by default. |
| `--draft` | Half resolution (unless `--scale`) + `ultrafast` preset + `crf 30`. |
| `--crf <n>` | x264 quality; `23` by default, `30` with `--draft`. |
| `--preset <name>` | libx264 preset; `medium` by default, `ultrafast` with `--draft`. |
| `--float-audio` | Write the temporary audio mix as 32-bit float. |

**`frame`** — render single frames to PNG and report what is wrong with them.
```sh
node src/cli/main.ts examples/hello-world/video.ts frame 1s,50%,Intro@end -o frames --svg
```
`--at <specs>` (comma/space separated) or positional specs; `-o <dir>` for the PNGs (`.` default);
`--svg` also writes the converted SVG next to each PNG.

**`svg`** — print one frame as SVG (to stdout, or `-o file.svg`).
```sh
node src/cli/main.ts examples/hello-world/video.ts svg 1.5s -o frame.svg
```

**`timeline`** — scenes, duration and audio tracks (a good first command on an unknown video).
```sh
node src/cli/main.ts examples/hello-world/video.ts timeline --json
```

**`inspect`** — check for missing media, fonts and empty/transparent frames.
```sh
node src/cli/main.ts examples/hello-world/video.ts inspect --every-frame --exit-code error
```
| Flag | Meaning |
| --- | --- |
| `--frame-range <spec>` | Range to check (all of it by default). |
| `--every-frame` | Check every single frame. |
| `--distance <n>` | Frames between checks; `30` by default. |
| `--exit-code <error\|warning\|info>` | Severity that fails with exit code 2. |
| `--info` | Report informational findings too. |
| `--no-empty-check` | Skip the fully-transparent-frame check. |

**`audio`** — `render` (to WAV), `analyze` (LUFS, peaks), or `at` (which track plays when).
```sh
node src/cli/main.ts examples/audio-demo/video.ts audio render -o mix.wav
node src/cli/main.ts examples/audio-demo/video.ts audio analyze --json
node src/cli/main.ts examples/audio-demo/video.ts audio at 4.2s,Intro
```
`render` writes `<defaultOutput>.wav` (`out.wav` if none); `--float` writes 32-bit float;
`--frame-range` limits the mix. `analyze --waveform` is **not** part of this port.

### Time specs & ranges

Time specs work for `--at`, `--frame-range` and positional times alike:

```
120, 120f          frame 120                3.2s, 500ms, 1:05.5   a timestamp
50%                half of the video         start, end            first / last frame
Intro              first frame of a scene (case-insensitive)      #3   scene index 3
Intro[1]           second scene of type Intro
Intro@1.2s         1.2s into the scene (also @12, @50%, @end)
```

Ranges: `a..b` (end exclusive), `a..`, `..b`, `all`, or a bare scene name for the whole scene.
Run `timeline` to list scene names.

---

## 2. Writing a video script

A video module default-exports a `Video`. Import the API from `src/index.ts` (relative path with
the `.ts` extension) — that is the only supported entry point besides the CLI.

### The `Video` contract

```ts
interface Video {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly defaultOutput?: string;               // what `render` writes when no -o is given
  duration(): Duration;                           // seconds(n) | frames(n) | auto | fromAudio(file)
  audio(): AudioMap;                              // AudioMap.none() or AudioMap.of([...tracks])
  defineScenes(): readonly Scene[] | Scenes | null;
  fonts(): readonly string[];                     // font FILES registered for the render
  renderFrame(frame: Frame, ctx: FFramesContext): Svgr;
}
```

### A `Scene`

```ts
interface Scene {
  readonly name?: string;                         // defaults to the class name
  duration(): Duration;
  audio?(): AudioMap;                             // audio this scene adds on top of the video map
  renderFrame(frame: Frame, ctx: FFramesContext): Svgr;
}
```

Inside a scene `frame.index` is **relative to the scene start** (first frame of a scene is `0`);
`frame.globalIndex` always refers to the whole video.

### Minimal working video

```ts
import { svgr, seconds, timeline, Easing, AudioMap, Color, auto } from '../src/index.ts';
import type { Scene, Svgr, Video, FFramesContext, Frame } from '../src/index.ts';

class Title implements Scene {
  readonly name = 'Title';
  duration() { return seconds(3); }
  renderFrame(frame: Frame): Svgr {
    // animate y from 300 -> 320 over the first 0.2s, linearly
    const y = frame.animate(timeline<number>(
      { start: 0, end: 0.2, from: 300, to: 320, easing: Easing.linear },
    ));
    return svgr`<text x="100" y="${y}" font-size="120" font-family="Helvetica">Hello</text>`;
  }
}

class MyVideo implements Video {
  readonly fps = 30;
  readonly width = 1920;
  readonly height = 1080;
  duration() { return auto; }                     // inferred from the scenes
  audio() { return AudioMap.none(); }
  defineScenes() { return [new Title()]; }
  fonts() { return ['/System/Library/Fonts/Helvetica.ttc']; }
  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">
      <rect width="${this.width}" height="${this.height}" fill="${frame.animate(BACKGROUND)}" />
      ${ctx.renderScenes(frame)}
    </svg>`;
  }
}

export default new MyVideo();
```

`examples/hello-world/video.ts` is the golden reference (two scenes, an animated background, and a
frame-index readout). `examples/audio-demo/video.ts` shows an `AudioMap`.

### Rendering a frame

- `svgr` is a **tagged template**: `${...}` interpolations are stringified, and interpolating
  another `Svgr` concatenates it. Return one `Svgr` from `renderFrame`.
- `ctx.renderScenes(frame)` renders every scene that contains the current frame and concatenates
  the results — call it from `Video.renderFrame` to composite the scene layer.
- `ctx` also gives `getImage(file)` (data URI), `getAudio(file)`, `hasMedia(file)`,
  `currentVideoSize`, `durationInFrames`, `timeBase`, and `mode` (`editor`/`renderer`).
- `renderFrame` runs **once per frame**, so keep it allocation-light.

### Animation

`frame.animate(timeline(...))` evaluates a keyframe timeline at the frame's timestamp.

```ts
const anim = timeline<Color>(
  { start: 0, end: 5, from: Color.fromHex('#fff'), to: Color.fromHex('#f8fafc'), easing: Easing.linear },
  { start: 5, end: 10, from: Color.fromHex('#f8fafc'), to: Color.fromHex('#fff7ed'), easing: Easing.linear },
);
const bg = frame.animate(anim);   // a Color at the current second
```

- A keyframe is `{ start, end?, from, to, easing }`, times in **seconds**. Keyframes are sorted by
  `start`; gaps are filled with a static hold; a tween's duration is `end ?? nextStart − start`.
- `Easing`: `Easing.linear`, `Easing.easeIn`, `Easing.easeOut`, `Easing.easeInOut`,
  `Easing.cubicBezier(x1,y1,x2,y2)`, `Easing.spring({ mass, stiffness, damping })`. A spring infers
  its own settle time, so give it **no** explicit `end`.
- `Animatable` values tween per-field: numbers, `Color`, and arrays/objects of them.
- Other `Frame` helpers: `frame.seconds()`, `frame.index`, `frame.globalIndex`, `frame.fps`,
  `frame.animateLoop(anim)`, `frame.animateRuntime({ onSecond, from, to, duration, easing })`,
  `frame.visualizeAudioFrame({ audio, sampleSize, smoothLevel })` for audio-reactive frames.

### Duration

`duration()` returns one of: `seconds(n)`, `frames(n)`, `auto` (infer from scenes/audio), or
`fromAudio(file)` (match a media file's length). Scene `duration()` uses the same helpers.

### Audio

```ts
import { AudioMap, audioTrack } from '../src/index.ts';

audio(): AudioMap {
  return AudioMap.of([
    audioTrack('music.mp3').gainDb(-14).fadeOut(2).duckUnderVoice(),
    audioTrack('voice.wav', { start: 1.5 }).voice(),
    audioTrack('whoosh.wav', { start: 4.25 }).pan(-0.5),
  ]);
}
```

- `audioTrack(file, range?)` — `range` is `{ start?, end? }` in seconds.
- Builder methods (chainable): `gainDb`, `volume`, `pan`, `fadeIn`, `fadeOut`, `offset`, `voice`,
  `duckUnderVoice`. `AudioMap.none()` is silence; `AudioMap.of([...])` builds a map.
- Audio files resolve from the media directory. Verify with `audio analyze` / `audio at`.

### Media & fonts

- **Media directory**: a `media/` folder next to the module by default, or `--media-dir`.
  `ctx.getImage('logo.png')` / `ctx.getAudio('music.mp3')` / `ctx.hasMedia(...)` resolve against it.
- **Fonts**: the renderer registers **exactly** the files returned by `fonts()`; system font
  loading is off. Reference them from SVG by `font-family`. If `inspect` reports a missing font,
  add its file path to `fonts()`.

---

## 3. Rules & gotchas

- **No build step**: run `.ts` directly with Node ≥ 24. Use **erasable syntax only** — no `enum`,
  no `namespace`, no parameter properties, no decorators. `as` casts and interfaces are fine.
- **ESM imports need the `.ts` extension** and are relative: `import { svgr } from '../src/index.ts'`.
- **Import only from `src/index.ts`** (and the CLI). Deep module paths are internal and may move.
- `src/index.ts` deliberately does **not** re-export `src/cli/main.ts`: doing so would close a cycle
  through `loadVideo`'s dynamic import and hang direct execution. To drive the CLI programmatically,
  import it by path: `import { run, runCli, loadVideo } from '../src/cli/main.ts'`.
- `render`/`audio render` shell out to **ffmpeg** — it must be on `PATH`.
- Typical loop: `timeline` to see scenes → `svg 1s` / `frame 1s` to eyeball a frame →
  `inspect --every-frame` for missing media/fonts/empty frames → `render --draft` for a fast
  preview → `render -o out.mp4` for the final encode.

---

## 4. Art-style animation module (`src/art/`)

The `src/art/` module integrates the **huashu-art-motion** knowledge base: 35 art styles,
9 explainer grammars, and 9 transition effects, all as SVG/TypeScript modules.

### Quick start

```ts
import { getStyle, getGrammar, getTransition, listStyles, STYLE_INDEX } from '../src/art/index.ts';
import '../src/art/styles/index.ts';      // auto-registers all styles
import '../src/art/grammars/index.ts';    // auto-registers all grammars
import '../src/art/transitions/index.ts'; // auto-registers all transitions

// In a Scene's renderFrame:
const style = getStyle('09_postimp');     // Van Gogh style
if (style) {
  return style.renderFrame(frame, ctx, {
    width: 1920,
    height: 1080,
    localTime: frame.seconds(),
    globalTime: frame.seconds(),
  });
}
```

### Available art styles

| ID | Name | Period | Quality |
| --- | --- | --- | --- |
| `01_cave` | 洞穴岩画 | 公元前 40000 年 | ★★★ |
| `09_postimp` | 梵高（后印象派） | 1889 | ★★★ |
| `12_bauhaus` | 包豪斯 | 1920s | ★★★ |
| `13_pop` | 波普艺术 | 1960s | ★★★ |
| `14_8bit` | 8-bit 像素 | 1980s | ★★★ |
| `17_ink` | 中国水墨 | 传统 | ★★★ |
| `26_vaporwave` | 蒸汽波 | 2010s | ★★★ |

See `STYLE_INDEX` for the full list of 35 styles with metadata.

### Explainer grammars

| ID | Name | Description |
| --- | --- | --- |
| `kurzgesagt` | Kurzgesagt 扁平科普 | 深色系、发光体、有机形状、神经网络 |
| `finance_chart` | 财经图表 | Economist 风格、红柱蓝线、标注、计数动画 |

### Transitions

| ID | Name | Duration |
| --- | --- | --- |
| `fade` | 淡入淡出 | 0.5s |
| `cut` | 硬切 | 0s |
| `swirl` | 星空漩涡 | 0.8s |
| `pixel` | 像素化 | 0.6s |
| `page_turn` | 翻页 | 0.7s |
| `bauhaus` | 包豪斯几何 | 0.8s |
| `vhs` | VHS 撕裂 | 0.5s |
| `ink_bloom` | 墨晕扩散 | 0.9s |
| `pop_flash` | 波普闪光 | 0.4s |

### Core utilities

- **`math.ts`** — `clamp`, `lerp`, `ss` (smoothstep), `rng` (mulberry32), `hash`, `ease`,
  `smooth`, `thereAndBack`, `rushInto`, `rushFrom`, `wiggle`, `lagged`, `spring`, `noise` (Perlin 2D), `fbm`
- **`color.ts`** — `hex`, `rgb`, `toHex`, `mix`, `jitter`, `swatch`, `luminance`, `warmShift`, `hsl`, `toHsl`
- **`svg-path.ts`** — `densify` (Catmull-Rom), `resample` (等弧长), `pointsToPath`, `ribbonPath`,
  `roughPathData`, `starPath`, `blobPath`, `cutPath`, `spiralPts`, `wavyPts`
- **`types.ts`** — `ArtStyleScene`, `ArtStyleParams`, `ExplainerGrammar`, `ArtTransition`, `choreo`

### Example

`examples/art-styles/video.ts` demonstrates 7 styles in a 31-second journey through art history:

```sh
node src/cli/main.ts examples/art-styles/video.ts timeline
node src/cli/main.ts examples/art-styles/video.ts frame --at 5s -o /tmp/frames
node src/cli/main.ts examples/art-styles/video.ts render --draft -o art-styles.mp4
```

### Font note

The art module uses `font-family="Helvetica"` and `font-family="PingFang SC"` (for Chinese text).
Make sure your `fonts()` returns the corresponding font files:

```ts
fonts() {
  return [
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/PingFang.ttc',
  ];
}
```
