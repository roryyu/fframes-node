# PORTING

What this port covers, what it leaves out, and everything that behaves differently from the Rust
original. The source of truth for the *intended* contract is `.verify/fframes/gen-prompt.txt`; this
file records what was actually built against it.

Upstream: <https://github.com/dmtrKovalenko/fframes> (MIT).

## Scope of this round

The roadmap's **M1** (core contract + render pipeline), **M3** (the audio chain) and **M4-lite**
(the `inspect` / `svg` / `frame` / `timeline` check surface). Concretely:

| area | what is here |
| --- | --- |
| core | `Video` / `Scene` / `FFramesContext`, `Frame`, `Duration`, `TimeSpec`, `Color`, `Transform`, the `svgr` tagged template, `Scenes` |
| animation | `Easing` (linear, the three CSS presets, cubic bezier, spring), `timeline`, `KeyFramesAnimation` |
| render | the resvg CPU backend, the render session (timeline, context, frame loop) |
| encode | the ffmpeg CLI encoder: PNG frames on a pipe, libx264, an optional WAV muxed as a second input |
| audio | `AudioMap` / `AudioTrack` / fades / ducking, the mixer (resample, de-click, fades, gain, pan, ducking, −1 dBFS lookahead limiter), windowed-sinc resampling, BS.1770 loudness and true peak, WAV writing, FFT visualisation |
| media | ffmpeg decoding, ffprobe durations, `MediaDirectory` |
| check surface | `inspect`, `frame`, `svg`, `timeline`, `audio render\|analyze\|at` |
| CLI | `render`, `frame`, `svg`, `timeline`, `inspect`, `audio …` |

## Deliberately not implemented

Each item is a real feature of the original that this round does not have.

| not implemented | why |
| --- | --- |
| **Skia / GPU backend** (`fframes-skia-renderer`) | the renderer here is resvg, a CPU rasteriser. No SkSL, no shaders, no Vulkan/Metal. |
| **`fframes-native-player`** (`preview` command) | a real-time window needs a native player; out of scope. `strip` and `render --draft` cover the "look at it quickly" need. |
| **`strip` / `onion` / `snapshot` / `preview` commands** | contact sheets, onion skinning, pixel regression and the player window are all M2+ work. |
| **compile-time `svgr!` tree and static-subtree hashing** | the Rust macro builds a typed SVG tree and caches subtrees that contain no interpolation. TypeScript has no procedural macros, so `svgr` is a runtime string template and every frame re-parses. This is the single biggest performance difference from the original. |
| **Worker pool / parallel rendering** | the Rust CPU backend splits the video into segments and renders them on rayon threads, then concatenates. This port renders serially (contract §7). On a 12 core machine that is most of the remaining headroom. |
| **text layout: `text_fit`, `text_break_lines`, `text_width`** | these measure text from the font files, which needs a shaping engine. `resvg` shapes text at rasterisation time, so what you write is what you get, but nothing can be measured in advance. |
| **video input** (`Duration::FromVideo`, `getSyncedVideoFrame`) | decoding a video inside `renderFrame` is not implemented. |
| **WebVTT subtitles** | `ctx.getSubtitles` / `getSubtitlePhrase` are absent. |
| **Scene overlap / cross-fade** (`Scene::overlap`) | scenes are placed strictly back to back, so a frame belongs to at most one scene. The Rust renderer allows two and blends them. |
| **`analyze --waveform`** (the waveform PNG) | the flag is rejected with a message rather than silently ignored. |
| **compilation macros** (`include_media_dir!`, `clap` derive for user flags) | a Node module resolves its media at runtime from a `media/` folder next to it; there is no build step to embed files. |
| **`AudioTimestamp` variants** (`Frame`, `Time{minutes,seconds}`, `DurationOfAudio`, `+`, `-`) | the port's `AudioDuration { start?, end? }` expresses the same thing in seconds; a missing `end` means "to the end of the file". |
| **the editor / WASM bridge** | `fframes-editor`, `fframes-editor-controller` and the ReScript UI. |

## Behaviour that differs from the original

These are the places where the port is observably *not* the Rust program. Each one is a decision,
not an accident.

### 1. Fonts are never loaded from the system

`resvg-js` rescans the system font directory for **every** `Resvg` instance when
`loadSystemFonts` is on. Measured (`.verify/fframes/M0-probe-results.md`):

| configuration | per frame | fps |
| --- | --- | --- |
| `loadSystemFonts: true`, 1080p with text, cold | 427 ms | 2.3 |
| `loadSystemFonts: true`, warm | 351 ms | — |
| `loadSystemFonts: false` + `fontFiles: [Helvetica.ttc]` | 25.8 ms | 38.8 |
| 300 text nodes, Helvetica.ttc (2.3 MB) | 242 ms | 4.1 |
| 300 text nodes, Arial.ttf (0.77 MB) | 131 ms | 7.6 |
| typical scene (rect + 2 text), Arial.ttf | 25.5 ms | 39.3 |

So `loadSystemFonts` is **always** `false` here and the font set is exactly `Video.fonts()`. Two
consequences: a video that does not list a font gets no text (the Rust editor, and any local
workflow, could rely on system fonts), and **font file size matters** — a 2.3 MB family costs
roughly 2× a 0.77 MB one on a text-dense frame. Ship a subset.

### 2. PNG into ffmpeg, not raw RGBA

The Rust CPU backend hands `pixmap.data()` (raw RGBA) to a segment writer. `resvg-js` 2.6 does
expose `RenderedImage.pixels`, so raw video would have been possible, but the contract pins the
route that was measured end to end:

| route | measured |
| --- | --- |
| resvg → PNG → `-f image2pipe -vcodec png -r FPS -i pipe:0` → x264 medium | 90 frames in 2.40 s = **37.5 fps** at 1080p |
| ffmpeg rawvideo rgba pipe + x264 medium (encode step alone) | 300 frames in 0.82 s = 363.6 fps |

PNG is the default; `inputFormat: 'rawvideo'` selects the other one. Both end up as the same
pixels in the `.mp4` — ffmpeg decodes the PNG stream, and `-f image2pipe` with no width/height
flags takes the size from the first image.

The probe also fixed the **loudness** baseline the BS.1770 analyser has to agree with, which is
the one number in the port that is not derived from reading the sources:

| measurement | value |
| --- | --- |
| ffmpeg `ebur128`, 1 kHz sine, 10 s, `lavfi` default amplitude | integrated **−21.1 LUFS**, true peak **−18.1 dBFS** |

That is `M0-probe-results.md` P3, and it is the cross-check oracle for gate item C7 and for the
range assertions in `test/analysis.test.ts` (amplitude 0.1245 ≈ −18.1 dBFS must land in
[−21.6, −20.6]). If a change to `audio/analysis.ts` moves the integrated loudness away from −21.1
for this signal, the change is wrong — or the K-weighting coefficients are, which is the same thing.

`resvg-backend.ts` exports `renderSvgToPng` (the pipeline) and `renderSvgToRgba` (the contract §3
name, and what `inspect` reads to decide whether a frame is empty).

### 3. The render loop is serial

One frame at a time, in one thread, straight into the pipe. With 25.5 ms of rasterisation and
25 ms of encoding per 1080p frame, a 12 core machine is mostly idle. The roadmap's M2 (Worker pool)
is the fix; nothing else about the pipeline has to change for it, because the frame source is
already a lazy callback.

### 4. `Resvg` is rebuilt for every frame

`new Resvg(svg, options)` parses the document and loads the font files, so it is per frame by
construction. The Rust backend keeps a font database, a converter cache and a subtree cache across
frames (`CpuRenderingBackend { cache_capacity, text_cache_capacity, concurrency }`); none of those
caches exist here. A `Video` that can precompute its static markup into module-level constants
helps nothing today, but it is what a future static-subtree cache would key on.

### 5. `svg` prints the pre-render markup

`fframes svg TIME` prints the frame *after* conversion — text laid out, styles resolved, the tree
re-serialized. This port has no layout engine (§`text_*` above), so `svg` prints what `renderFrame`
produced with the scenes concatenated: the exact bytes the rasteriser receives. Useful for
diffing what your code emits, not a substitute for the converted form.

### 6. `missing-font` compares file names, not a font database

`resvg-js` does not expose the font database it built, so `registeredFontFamilies` recovers family
names from the `fontFiles` paths: the basename without its extension, the style suffix
(`-Regular`, `-Bold`, …) removed, lower-cased and stripped of non-alphanumerics. A `font-family`
matches when the normalized names are equal or one is a prefix of the other — that is what makes
`font-family="Dm Sans"` match `DMSans-Regular.ttf`. A video that registers **no** font is never
asked to have one, so the check stays silent instead of flagging every text element.

This is a heuristic and it can be wrong in both directions: a family whose name bears no relation
to its file name will be reported missing, and a font file whose name happens to be a prefix of
another family will be accepted. The Rust check asks a real `fontdb` and is exact.

### 7. `empty-frame` needs a rasterisation

The other three `inspect` checks (`render-error`, `missing-font`, `missing-media`) are decided
from the produced SVG string. Deciding whether a frame *drew* anything needs pixels, so `inspect`
rasterizes to RGBA with **no background fill** and looks for full transparency. That means `inspect`
rasterizes a frame it has already stringified, and it does so without the black background the
encoder applies.

A rasterization failure is a **finding**, not a crash: an empty document (`Svgr.empty()` is `''`) or
malformed markup becomes `empty-frame` (warning) or `render-error` (error) respectively, because the
frames this check exists to catch are exactly the ones that fail to rasterize. Rust reports both as
findings too.

### 8. `ffmpeg` and `ffprobe` are subprocesses

The Rust port links libavformat through `ffmpeg_sys_fframes`. A dependency-free Node port spawns
the same tools:

```sh
ffmpeg  -v error -i <file> -f f32le -ac 2 -ar 44100 pipe:1     # decode
ffprobe -v error -print_format json -show_format <file>        # duration
```

Durations are probed **synchronously** (`execFileSync`) because `ResolveAudioDuration` is a plain
function in this port and `Scenes.resolveTimeline` / `toFrames` are synchronous like the Rust
originals. The probe is memoized per file and only runs for a video that actually needs one
(`fromAudio`, an `Eof` range, or `auto` without scenes). `media/audio-decode.ts` also has the
asynchronous form for library callers.

### 9. Known deviations inherited from GEN-1 / GEN-2

These were recorded by the slices that wrote the code and are repeated here so PORTING.md is the
one place to look.

- **`SpringRuntime.getDuration()` is copied verbatim, and its last line looks like a bug.** The
  Rust source ends with `elapsed * frame_duration` even though `elapsed` is already in seconds, so
  the reported duration is seconds × 0.166667 rather than the ~28.8 s the physics implies. The port
  copies it as written; if you need the real settle time, divide by `SPRING_FRAME_DURATION`
  yourself. `SPRING_MAX_SETTLE_STEPS` (1e6) is an addition: Rust uses `f32`, whose exponential
  term underflows to exactly `0.0` and makes `solve() == 1.0` reachable; `f64` with zero damping
  never reaches it and the loop would not terminate.
- **Empty keyframes settle on the number `0`.** Rust `animation.rs:180-186` warns for an empty
  `tweens` list and falls back to `T::default()`, and says outright that the behaviour is undefined.
  The contract pins the signature as `timeline(...keyframes)` with no fallback argument, and
  `KeyFramesAnimation<T>` is generic over a type that erasable syntax cannot inspect at runtime, so
  there is no way to produce a `T::default()` — the port uses `0 as unknown as T`. It is undefined
  behaviour either way (this port fails loudly at the use site instead of silently rendering a
  default-constructed value), but the two would not have agreed.
- **`hammingWindow` does not copy a typo.** `audio_window_functions.rs:29` writes
  `0.54 - (0.46 * (2.0 * PI * i as f32 / cosf(samples_len - 1.0)))` — the `cos` is in the
  denominator and its argument is `len - 1` rather than `i`, so the expression is not a Hamming
  window at all. The port implements the definition, `0.54 − 0.46·cos(2πi/(n−1))`, and the test
  asserts both ends ≈ 0.08.
- **`svgr` does not escape interpolated strings**, exactly like the Rust macro. A string
  interpolated into markup is inserted verbatim, so a value containing `<` or `&` will produce
  invalid SVG. This is faithful to the original and is a footgun in both.
- **The whole audio chain is `f64`, not `f32`.** TypeScript has no `f32`; `Math.fround` would only
  add error. Every threshold in the tests carries more slack than `f32` rounding needs, so the
  conclusions hold, but the last bits of a mix will not be bit-identical to the Rust renderer.
- **`Color.a` is `0..1`, not a `u8`.** The contract asks for a float alpha; the Rust `Color` keeps
  it as a byte. `alphaByte` and `Color.fromAlphaByte` bridge the two, and `withAlpha` takes a byte
  to match `Color::with_alpha(a: u8)`.
- **`smoothLevel: 0` returns an empty spectrum instead of panicking.** `frame.rs:212-228` takes the
  exclusive range `(index - smooth)..(index + smooth)`, which is empty for `smooth_level == 0`, so
  Rust panics on `frames_to_smooth[1]`. The loop boundaries are copied 1:1; only the degenerate
  input is handled by returning `[]`.
- **`Color.interpolate` truncates the rgb channels** the way Rust's `as u8` cast does, so
  `#000 → #fff` at `t = 0.5` is `127`, not `128`.
- **`Transform.toSvgAttribute()` serializes in the Rust order** `translate → rotate → scale → skewX
  → skewY`, not the order the contract's prose happens to list. The Rust `Display` and the matrix
  path have to agree or the string form and the matrix form render differently, so the prose is
  read as "each part's format", not "the order".
- **The 16-bit WAV path dithers** (TPDF, fixed seed `0x9E3779B9`), which is what `encode_wav`
  does. Same input gives the same bytes, so renders are reproducible; pass `dither: false` for
  exact round-trips.
- **`SpringRuntime.getDuration()` is bounded where Rust is not.** Rust's `spring.rs:54-74`
  `get_duration` has no step limit, and with `damping: 0` the solution `1 - cos(w0·t)` never reaches
  exactly `1.0`, so the loop never terminates. `SPRING_MAX_SETTLE_STEPS` (1e6) turns that hang into
  a ~33 ms return. Reporting a configuration error instead would be an improvement over the
  original, not a port of it, so the port keeps Rust's semantics and bounds the loop.

## Not verified at execution time

The generator had no shell (contract §0), so nothing below was run:

- `tsc --noEmit`,
- `node --test test/`,
- any render, any `ffmpeg` invocation, any `ffprobe` probe.

Everything in this file is derived from reading the sources and from the M0 probe, whose scripts and
measurements are in `.verify/fframes/probe/` and `.verify/fframes/M0-probe-results.md`.

## Roadmap after this round

1. **Worker pool.** The frame source is already a lazy async callback, so a pool is a change to
   `encodeVideo`'s producer, not to the rest of the pipeline. Expected gain is roughly the core
   count, minus what the encoder already uses.
2. **`@napi-rs/canvas` direct drawing.** Skipping the SVG parse entirely would remove the per-frame
   `new Resvg` cost and the font re-parse, and would need no `text_*` layout port to get correct text.
3. **Static subtree cache.** Key the parsed tree on the markup of subtrees without interpolation —
   the same idea as the Rust `SvgrCache`, and the reason to keep decorative geometry lexically
   static.
4. **A real font database for `missing-font`.** `@resvg/resvg-js` does not expose one; reading the
   `name` table of the registered files would make the check exact.
5. **Text measurement**, if `text_fit` / `text_break_lines` are wanted — probably via
   `@napi-rs/canvas`'s `measureText`, which is consistent with item 2.
6. **`strip` / `onion` / `snapshot`.** Small once the frame PNG path is fast, and the contact sheet
   is the best way to review motion without playing the file.
