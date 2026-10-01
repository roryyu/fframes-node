/**
 * `corrupt-audio` — a video whose audio file exists but cannot be decoded, for the mix-skip rule.
 *
 * `media/corrupt.wav` is present in the media directory but is not valid audio (a RIFF header over
 * garbage), so ffmpeg refuses to decode it. The Rust mixer skips a track it cannot preload
 * (`audio_mix.rs:416-427`: `AudioData::Lazy => continue`) and reports it, rather than failing the
 * whole render. Before FIX10 the port threw out of `decodeAudioFileStereo`, which propagated through
 * `decodeSessionAudio` and killed `render` with exit 1 — turning "a referenced file is corrupt" into
 * "the render command failed", the exact failure mode the `resolveSessionAudio` doc warns against.
 *
 * The track carries an explicit `start`/`end` so the session never has to probe the corrupt file's
 * duration; the failure is isolated to the decode step, which is what the fix guards.
 *
 * ```sh
 * node src/cli/main.ts examples/corrupt-audio/video.ts render --frame-range 0..5 -o /tmp/c.mp4 --json
 * # exit 0, missingAudioFiles: ["corrupt.wav"], the video frames are still written
 * ```
 *
 * This fixture is the CLI-level regression lock for FIX10.
 */

import { svgr, seconds, AudioMap, audioTrack } from '../../src/index.ts';
import type { Svgr, Video, FFramesContext, Frame } from '../../src/index.ts';

class CorruptAudioVideo implements Video {
  readonly fps = 30;
  readonly width = 320;
  readonly height = 180;
  readonly defaultOutput = 'corrupt-audio.mp4';

  duration() {
    return seconds(2);
  }

  defineScenes(): null {
    return null;
  }

  /** One track on a file that exists but ffmpeg cannot decode; explicit range, so no duration probe. */
  audio(): AudioMap {
    return AudioMap.of([audioTrack('corrupt.wav', { start: 0, end: 2 })]);
  }

  fonts(): string[] {
    return ['/System/Library/Fonts/Helvetica.ttc'];
  }

  renderFrame(frame: Frame, _ctx: FFramesContext): Svgr {
    return svgr`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">
      <rect width="${this.width}" height="${this.height}" fill="#0f172a" />
      <text x="24" y="96" font-family="Helvetica" font-size="28" fill="#f8fafc">corrupt audio</text>
      <text x="24" y="132" font-family="Helvetica" font-size="20" fill="#94a3b8">frame ${frame.index}</text>
    </svg>`;
  }
}

export default new CorruptAudioVideo();
