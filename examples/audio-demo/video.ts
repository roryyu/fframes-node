/**
 * `audio-demo` — the audio chain, end to end, on a synthetic signal.
 *
 * 10 s at 30 fps, 640x360, a solid background and the frame number. What it demonstrates is the
 * audio: two tracks on the same file, one ducked under the other.
 *
 * ```ts
 * const music = audioTrack('sine.wav').gainDb(-6).fadeIn(0.5).fadeOut(1);
 * const voice = audioTrack('sine.wav', { start: 3, end: 5 }).offset(3).voice();
 * ```
 *
 * `sine.wav` is a 10 s 440 Hz tone in `media/`, which the commander placed there. It stands in for
 * a music bed and a voice take: the point is the *placement*, not the content. Note the two
 * differences from the same file being one track:
 *
 * - `voice` covers 3 s..5 s **of the file** and is placed at 3 s on the timeline, so it plays
 *   between 3 s and 5 s,
 * - `music` is the whole file, so it is ducked to −12 dB exactly while the voice plays, and the
 *   ducking ramps rather than jumping (attack 0.2 s, hold 0.3 s, release 0.8 s).
 *
 * ```sh
 * node src/cli/main.ts examples/audio-demo/video.ts render -o demo.mp4
 * node src/cli/main.ts examples/audio-demo/video.ts audio analyze
 * node src/cli/main.ts examples/audio-demo/video.ts audio at 4s
 * ```
 */

import { svgr, seconds, AudioMap, audioTrack } from '../../src/index.ts';
import type { Svgr, Video, FFramesContext, Frame } from '../../src/index.ts';

class AudioDemo implements Video {
  readonly fps = 30;
  readonly width = 640;
  readonly height = 360;
  readonly defaultOutput = 'audio-demo.mp4';

  duration() {
    return seconds(10);
  }

  // The interface requires `defineScenes`; this example has none, and `null` is how the port says
  // so (`Scenes.fromValue(null)` is the empty timeline, as `Scenes::default()` is in Rust).
  defineScenes(): null {
    return null;
  }

  audio(): AudioMap {
    // The music bed: quieter, fading in and out.
    const music = audioTrack('sine.wav').gainDb(-6).fadeIn(0.5).fadeOut(1);
    // The voice: 3 s..5 s of the file, placed at 3 s, and it ducks the music.
    const voice = audioTrack('sine.wav', { start: 3, end: 5 }).offset(3).voice();
    return AudioMap.of([music.duckUnderVoice(), voice]);
  }

  fonts(): string[] {
    return ['/System/Library/Fonts/Helvetica.ttc'];
  }

  renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">
      <rect width="${this.width}" height="${this.height}" fill="#0f172a" />
      <text x="40" y="120" font-family="Helvetica" font-size="48" fill="#f8fafc">audio demo</text>
      <text x="40" y="200" font-family="Helvetica" font-size="32" fill="#94a3b8">frame ${frame.index}</text>
      <text x="40" y="250" font-family="Helvetica" font-size="24" fill="#94a3b8">${frame.seconds().toFixed(2)}s</text>
      <text x="40" y="320" font-family="Helvetica" font-size="20" fill="#475569">music is ducked -12 dB while the voice plays (3s..5s)</text>
    </svg>`;
  }
}

export default new AudioDemo();
