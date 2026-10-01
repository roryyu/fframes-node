/**
 * The runtime media directory: the folder a video resolves its audio, images, subtitles and
 * fonts from.
 *
 * Port of `.source/fframes/fframes/src/renderer/media_directory.rs` (`MediaDirectory::read_folder`
 * and `process_media_source`). The Rust version eagerly reads every file into a
 * `DynamicMediaProvider`; this port keeps the folder and decodes on demand, because the only
 * thing the renderer needs from it before rendering is *which* files exist (the `missing-media`
 * check) and the duration of the audio (probed with ffprobe).
 *
 * The extension lists are the ones `read_folder` filters on, so a video that works with the Rust
 * port finds the same files here.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  decodeAudioFileStereo,
  probeDurationSeconds,
} from './audio-decode.ts';
import type { DecodedAudio } from './audio-decode.ts';

/** `read_folder` reads these into memory (`RawMediaFile::Data`). */
export const AUDIO_EXTENSIONS: readonly string[] = ['mp3', 'wav', 'flac', 'aac', 'pcm', 'ogg', 'mp2'];
export const IMAGE_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'gif'];
export const SUBTITLE_EXTENSIONS: readonly string[] = ['vtt'];

/** `read_folder` keeps these by path (`RawMediaFile::Stream`). */
export const VIDEO_EXTENSIONS: readonly string[] = [
  'mp4',
  'webm',
  'mkv',
  'avi',
  'mov',
  'flv',
  'wmv',
  'm4v',
];
export const FONT_EXTENSIONS: readonly string[] = ['ttf', 'ttc', 'otf', 'otc'];

/** The kinds `process_media_source` dispatches on. */
export type MediaKind = 'audio' | 'image' | 'subtitle' | 'video' | 'font' | 'unknown';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The {@link MediaKind} of a file name, or `'unknown'` for extensions fframes does not read. */
export function mediaKindFor(name: string): MediaKind {
  const extension = extensionOf(name);
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (SUBTITLE_EXTENSIONS.includes(extension)) return 'subtitle';
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (FONT_EXTENSIONS.includes(extension)) return 'font';
  return 'unknown';
}

/** One file of the directory. */
export interface MediaDirectoryEntry {
  /** The file name as the video refers to it, e.g. `sine.wav`. */
  readonly name: string;
  /** The absolute path of the file. */
  readonly path: string;
  readonly kind: MediaKind;
  /** Size in bytes. */
  readonly size: number;
}

/** The result of {@link MediaDirectory.usedFiles}. */
export interface MediaDirectoryCheck {
  /** The referenced files, de-duplicated, in first-seen order. */
  readonly used: string[];
  /** The referenced files the directory does not have. */
  readonly missing: string[];
  /** `missing.length === 0` */
  readonly ok: boolean;
}

/**
 * `MediaDirectory` — a folder of media, resolved by name.
 *
 * ```ts
 * const media = new MediaDirectory('media');
 * media.path('sine.wav'); // /abs/path/to/media/sine.wav
 * media.exists('sine.wav');
 * ```
 */
export class MediaDirectory {
  /** The absolute path of the directory. */
  readonly dir: string;

  /**
   * The directory does not have to exist yet, so nothing is read here: {@link list} and
   * {@link readFolder} are the operations that touch the file system.
   */
  constructor(dir: string) {
    this.dir = isAbsolute(dir) ? dir : resolve(dir);
  }

  /** The absolute path of `name` inside the directory. */
  path(name: string): string {
    return join(this.dir, name);
  }

  /**
   * Whether `name` is a file of this directory.
   *
   * A name that would escape the directory (`../…`, an absolute path) is never contained, so
   * `inspect` reports it as missing rather than reading an unrelated file.
   */
  exists(name: string): boolean {
    if (isAbsolute(name)) return false;
    const full = this.path(name);
    // Containment is a path relation, not a string prefix: `startsWith` accepts
    // `/proj/media-secret/keys.wav` for a directory of `/proj/media`, so a `../` name could read a
    // sibling folder's file. `relative` answers it per segment: `..` (or an absolute result, which
    // a different Windows drive gives) means "outside", and the empty string is the directory
    // itself, which is a directory and not a file.
    const rel = relative(this.dir, full);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return false;
    }
    try {
      return existsSync(full) && statSync(full).isFile();
    } catch {
      return false;
    }
  }

  /** Every media file of the directory, sorted by name. */
  list(): MediaDirectoryEntry[] {
    return this.readFolder().entries;
  }

  /** The file names of the directory, sorted. */
  names(): string[] {
    return this.list().map((entry) => entry.name);
  }

  /** Names of the media files of one kind. */
  namesOf(kind: MediaKind): string[] {
    return this.list()
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.name);
  }

  /** Audio file names, the ones `Video.audio()` refers to. */
  audioFiles(): string[] {
    return this.namesOf('audio');
  }

  /** Image file names, the ones `ctx.getImage()` resolves. */
  imageFiles(): string[] {
    return this.namesOf('image');
  }

  /** Font file names; `Video.fonts()` normally lists them explicitly. */
  fontFiles(): string[] {
    return this.namesOf('font');
  }

  /**
   * `MediaDirectory::read_folder` — reads the directory.
   *
   * Files whose extension fframes does not read are skipped, exactly as in Rust. Throws when
   * `dir` is not a directory, which is what `read_folder` does.
   */
  readFolder(): { dir: string; entries: MediaDirectoryEntry[] } {
    let isDirectory = false;
    try {
      isDirectory = statSync(this.dir).isDirectory();
    } catch {
      throw new Error(`MediaDirectory: "${this.dir}" does not exist`);
    }
    if (!isDirectory) {
      throw new Error(`MediaDirectory: resources_dir must be a folder, "${this.dir}" is not`);
    }

    const entries: MediaDirectoryEntry[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      const kind = mediaKindFor(name);
      if (kind === 'unknown') continue;
      const full = this.path(name);
      let size = 0;
      try {
        const fileStat = statSync(full);
        if (!fileStat.isFile()) continue;
        size = fileStat.size;
      } catch {
        continue;
      }
      entries.push({ name, path: full, kind, size });
    }
    return { dir: this.dir, entries };
  }

  /**
   * The `missing-media` helper of `inspect`: which of the referenced files are absent.
   *
   * ```ts
   * const check = media.usedFiles(video.audio().trackNames());
   * for (const file of check.missing) report(frame, 'missing-media', file);
   * ```
   */
  usedFiles(names: Iterable<string>): MediaDirectoryCheck {
    const used: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      used.push(name);
      if (!this.exists(name)) {
        missing.push(name);
      }
    }
    return { used, missing, ok: missing.length === 0 };
  }

  /** Whether every referenced file exists. */
  hasAll(names: Iterable<string>): boolean {
    return this.usedFiles(names).ok;
  }

  /** Decoded audio of `name`, or `null` when the file does not exist. */
  async loadAudio(name: string, sampleRate?: number): Promise<DecodedAudio | null> {
    if (!this.exists(name)) return null;
    return decodeAudioFileStereo(this.path(name), sampleRate);
  }

  /** Duration of `name` in seconds, or `null` when it can not be probed. */
  async durationOf(name: string): Promise<number | null> {
    if (!this.exists(name)) return null;
    return probeDurationSeconds(this.path(name));
  }
}
