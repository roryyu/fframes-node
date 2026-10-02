# fframes-node

A Node.js port of [**fframes**](https://github.com/dmtrKovalenko/fframes) — a programmatic video
framework. You describe one frame at a time as an SVG tree; the framework renders the frames, mixes
the audio and hands both to FFmpeg.

The Rust original is MIT licensed; this port is a derivative work and carries the same licence.
The rendering backend is a different one (`@resvg/resvg-js` instead of tiny-skia), the CLI is
hand-written instead of `clap`, and there is no GPU backend — see [PORTING.md](./PORTING.md) for the
full list of what is and is not here.

```sh
node src/cli/main.ts examples/hello-world/video.ts render -o out.mp4
```

## Requirements

- **Node ≥ 24** — the sources are TypeScript run through Node's native type stripping, so there is
  no build step. The code only uses *erasable* syntax: no `enum`, no `namespace`, no constructor
  parameter properties, no decorators.
- **ffmpeg and ffprobe** in `PATH` — for encoding, for decoding audio and for probing durations.

## Quick start

```sh
git clone <this repo> && cd fframes-node
npm install

# what the video is: size, fps, length, scenes, audio tracks
node src/cli/main.ts examples/hello-world/video.ts timeline

# check it before spending 30 seconds of CPU on it
node src/cli/main.ts examples/hello-world/video.ts inspect --every-frame

# a cheap preview first: half resolution, fastest encoder preset
node src/cli/main.ts examples/hello-world/video.ts render --draft -o draft.mp4

# the real thing
node src/cli/main.ts examples/hello-world/video.ts render -o out.mp4
```

`examples/hello-world/main.ts` is the same thing as a script:

```sh
node examples/hello-world/main.ts render -o out.mp4
```

### Install the Agent Skill

This repo ships a coding-agent skill at [`skill/SKILL.md`](./skill/SKILL.md). Paste the prompt
below into your agent (Qoder, Claude Code, Codex, …) and it will fetch the skill from the online
address and register it, so the agent knows how to author and render `video.ts` scripts for you.

```text
Install the Agent Skill located at https://github.com/roryyu/fframes-node/tree/master/skill
into this project's skills directory. Read its SKILL.md, keep the frontmatter `name` and
`description` intact, and make the skill available so that future requests to create, render,
inspect or mix a fframes-node video use it.
```

## Writing a video

A video is an object with a geometry, a length, an audio map and a `renderFrame`. Nothing else.

```ts
import { svgr, seconds, timeline, Easing, AudioMap, audioTrack, Color } from './src/index.ts';
import type { Video, Frame, FFramesContext, Svgr } from './src/index.ts';

class HelloWorld implements Video {
  readonly fps = 30;
  readonly width = 1920;
  readonly height = 1080;
  readonly defaultOutput = 'hello.mp4';

  duration() {
    return seconds(5);          // or { kind: 'auto' }, frames(150), fromAudio('x.wav')
  }

  audio(): AudioMap {
    return AudioMap.of([
      audioTrack('music.mp3').gainDb(-14).fadeIn(1).fadeOut(2).duckUnderVoice(),
      audioTrack('voice.wav', { start: 1.5 }).voice(),
    ]);
  }

  fonts(): string[] {
    // Exactly the files the renderer loads. `loadSystemFonts` is never on: scanning the system
    // font directory costs 351 ms per frame, loading these costs 25.8 ms.
    return ['/System/Library/Fonts/Helvetica.ttc'];
  }

  renderFrame(frame: Frame, ctx: FFramesContext): Svgr {
    const background = frame.animate(
      timeline<Color>(
        { start: 0, end: 5, from: Color.fromHex('#fff'), to: Color.fromHex('#f8fafc'), easing: Easing.linear },
      ),
    );

    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">
      <rect width="${this.width}" height="${this.height}" fill="${background}" />
      ${ctx.renderScenes(frame)}
      <text x="100" y="440" font-family="Helvetica" font-size="74" fill="#4b5563">frame ${frame.index}</text>
    </svg>`;
  }
}

export default new HelloWorld();
```

Run it:

```sh
node src/cli/main.ts video.ts render -o out.mp4
```

`default export` may also be a factory — `export default () => new HelloWorld()` — or an async
one, which is how a video builds itself from its own flags.

### Scenes

Split a long video into parts. Each scene gets its own `renderFrame`, and `frame.index` inside a
scene is **relative to the scene start** while `frame.globalIndex` always refers to the whole video.

```ts
import { seconds } from './src/index.ts';
import type { Scene, Frame, FFramesContext, Svgr } from './src/index.ts';

class Intro implements Scene {
  duration() {
    return seconds(3);
  }

  renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
    return svgr`<text x="100" y="300" font-family="Helvetica" font-size="150">intro ${frame.seconds()}</text>`;
  }
}

// on the video
defineScenes() {
  return [new Intro(), new Outro()];
}
duration() {
  return { kind: 'auto' };    // the sum of the scenes
}
```

### Animating

`timeline` builds a keyframe animation once; `frame.animate` samples it at the frame's time.

```ts
const slide = frame.animate(
  timeline<Transform>(
    { start: 0, from: Transform.translate(0, 80), to: Transform.translate(0, 0), easing: Easing.spring({ mass: 1, stiffness: 300, damping: 26 }) },
    { start: 2.2, end: 2.8, from: Transform.translate(0, 0), to: Transform.translate(0, -80), easing: Easing.easeIn },
  ),
);
```

Numbers, `Color` and `Transform` are animatable. Easings are `Easing.linear`, `easeIn`, `easeOut`,
`easeInOut`, `Easing.cubicBezier(x1, y1, x2, y2)` and `Easing.spring({ mass, stiffness, damping })`.
`frame.animateLoop` wraps the time around the animation's own duration.

## Commands

`node src/cli/main.ts <video.ts> [command] [options]`, or `node <video-module-dir>/main.ts …`.

| command | what it does |
| --- | --- |
| `render [RANGE]` | render the video, or a range of it, to a file (default command) |
| `frame <spec...>` | render single frames to PNG and report what is wrong with them |
| `svg <spec>` | print a frame as SVG |
| `timeline` | size, fps, length, scenes with their frame and second ranges, audio tracks |
| `inspect [RANGE]` | missing fonts, missing media, empty frames and render errors |
| `audio render` | mix the audio to a stereo WAV (`<defaultOutput>.wav`, or `out.wav`) |
| `audio analyze` | integrated loudness (LUFS), true peak, clipping, silence, loudness per scene |
| `audio at <spec...>` | which tracks play at a time, where in the file and at what level |

Global options: `--json` (exactly one JSON document on stdout; progress and warnings on stderr),
`--scale <f>`, `--media-dir <path>`, `--help`.

Per command:

| command | options |
| --- | --- |
| `render` | `--frame-range <a..b>`, `-o/--output`, `--draft`, `--crf`, `--preset`, `--float-audio` |
| `frame` | `-o/--output <dir>`, `--svg` |
| `svg` | `-o/--output` |
| `inspect` | `--frame-range <a..b>`, `--every-frame`, `--distance <frames>`, `--exit-code error\|warning\|info`, `--info`, `--no-empty-check` |
| `audio render` | `-o/--output`, `--float`, `--frame-range` |
| `audio analyze` | `--frame-range` |
| `audio at` | the time specs, comma or space separated |

`--draft` is half resolution (unless `--scale` says otherwise) with the fastest encoder preset.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | success |
| `1` | a usage or runtime error; the message is on stderr as `error: …` |
| `2` | `inspect` found something at `--exit-code` severity |

### Time specs

Every command that takes a time speaks the same language.

| spec | meaning |
| --- | --- |
| `120`, `120f` | frame 120 |
| `3.2s`, `500ms`, `1:05.5`, `1:02:03` | a timestamp |
| `50%` | half of the video |
| `start`, `end` | the first / last frame |
| `Intro` | the first frame of the scene named `Intro` (case-insensitive, `IntroScene` matches too) |
| `#3` | the first frame of the scene with index 3 (0-based) |
| `Intro[1]` | the second scene of type `Intro` |
| `Intro@1.2s`, `Intro@12`, `Intro@50%`, `Intro@end` | an offset into the scene |
| `a..b`, `a..`, `..b`, `all`, `Intro` | ranges; the end is exclusive |

```sh
node src/cli/main.ts video.ts render --frame-range Intro..Outro -o outro.mp4
node src/cli/main.ts video.ts frame Intro@end,50% -o shots/
node src/cli/main.ts video.ts audio at 4.2s
```

## Audio

Audio is placed on the timeline by file name, at sample accuracy: `audioTrack('take.wav',
{ start: 10, end: 14 }).offset(3.2)` plays 3.2 s..7.2 s **of the file** at 10 s on the timeline,
starting at sample 187425 — not at a frame boundary, not at a whole second.

```ts
AudioMap.of([
  audioTrack('music.mp3').gainDb(-14).fadeIn(1).fadeOut(2).duckUnderVoice(),
  audioTrack('voice.wav', { start: 1.5 }).voice(),
  audioTrack('whoosh.wav', { start: 4.25 }).pan(-0.4),
]);
```

Overlapping tracks are summed linearly, the master bus has a −1 dBFS lookahead limiter, and other
sample rates are resampled with a windowed sinc. `duckUnderVoice()` lowers a track by 12 dB while
any `.voice()` track plays, ramping rather than jumping. Fades default to the equal power curve;
`linear`, `sCurve` and `exponential` are available through `.fadeCurve(…)`.

Files resolve from the `media/` folder next to the video module, or from `--media-dir`.

Verify without listening:

```sh
node src/cli/main.ts video.ts audio analyze      # aim for about -14 LUFS and a true peak below -1 dBTP
node src/cli/main.ts video.ts audio at 4.2s       # which file, where in it, how loud, ducked or not
```

## Using it as a library

```ts
import { createRenderSession, renderFramePng, renderVideo, analyzeAudio } from './src/index.ts';

const session = createRenderSession(video, { fps: 30, width: 1920, height: 1080 });
session.durationInFrames;                 // 900
session.index.resolveRange('Intro..Outro') // { start: 0, end: 450 }
renderFramePng(session, 0);                // one frame, as a PNG Buffer

await renderVideo(session, { range: session.index.fullRange(), output: 'out.mp4' });
```

Everything the modules export is re-exported from `src/index.ts`; the deep paths are the port's
internal structure, not part of the contract. The one exception is `src/cli/main.ts`: the CLI is a
separate entry point, imported by path, because `index.ts` cannot statically depend on a module
that ends in a top-level `await` (that would deadlock every direct `node src/cli/main.ts …` run).

```ts
import { run } from './src/cli/main.ts';   // not re-exported from src/index.ts
```

## Examples

| example | what it shows |
| --- | --- |
| `examples/hello-world` | two scenes, a six stop background animation, the frame counter (ported from the Rust example) |
| `examples/audio-demo` | two tracks on one file, one ducked under the other; `media/sine.wav` is a 10 s 440 Hz tone |
| `examples/broken-video` | a missing font and a missing audio file, for `inspect` to find (exit code 2) |

## Repository layout

```
src/core/       Video, Frame, Duration, TimeSpec, Color, Transform, svgr, Scenes, animation
src/audio/      AudioMap, mixer, resampler, BS.1770 analysis, WAV, FFT visualisation
src/media/      audio decoding through ffmpeg, the media directory
src/render/     the resvg backend and the render session
src/encode/     the ffmpeg encoder
src/inspect/    the diagnostics behind `inspect`
src/cli/        the command line
src/index.ts    the public API
```

`DELIVERY.md` records what was built, which Rust file each part was ported from, and the decisions
taken along the way. `PORTING.md` records what was left out and why.

## Licence

MIT, as the original. See the upstream project for the full text.
