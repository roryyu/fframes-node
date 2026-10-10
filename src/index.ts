/**
 * The public API of fframes-node.
 *
 * ```ts
 * import { svgr, seconds, timeline, Easing, AudioMap, audioTrack, Color } from './src/index.ts';
 * import type { Video, Frame, FFramesContext, Duration, Svgr, Scene } from './src/index.ts';
 * ```
 *
 * A user imports from here (and the CLI) and nothing else: the individual modules are the port's
 * internal structure, mirroring the Rust crates, and their layout is not part of the contract.
 * Everything the modules of the port export is re-exported below, so no symbol has to be reached
 * for through a deep path.
 *
 * ## Two renames
 *
 * `dbToGain` exists in both `audio/mixer.ts` and `audio/analysis.ts` with the same meaning, so
 * the analyser's is exported as `analysisDbToGain`; a re-export of the same name twice would be a
 * compile error, and picking one arbitrarily would be worse than naming both.
 *
 * `SampleSize` and `WindowFunction` are re-exported from `core/types.ts` (the single source of
 * truth, as `audio/visualize.ts` itself re-exports them), not from `audio/visualize.ts`.
 */

// --- core: the user facing contracts ---------------------------------------
export type {
  FFramesContext,
  FFramesMode,
  InspectFinding,
  InspectResult,
  RenderOptions,
  SampleSize,
  Scene,
  TimeBase,
  Video,
  VideoSize,
  VisualizeFrameInput,
  WindowFunction,
} from './core/types.ts';

// --- core: frames, duration, time specs ------------------------------------
export { Frame, getVisualizationResolver, setVisualizationResolver } from './core/frame.ts';
export type { VisualizationResolver } from './core/frame.ts';

export { addDuration, auto, fromAudio, frames, seconds, secondsToFramesFloor, subDuration, toFrames, usedAudioFiles } from './core/duration.ts';
export type { Duration, DurationAudioMapHint, DurationAudioTrackHint, ResolveAudioDuration, ToFramesOptions } from './core/duration.ts';

export {
  formatTimeSpecError,
  normalizeSceneName,
  parseTimeSpec,
  shortSceneName,
  TimelineIndex,
  TimeSpec,
  TimeSpecResolveError,
} from './core/time-spec.ts';
export type { FrameRange, TimeSpecError, TimelineScene } from './core/time-spec.ts';

// --- core: values ----------------------------------------------------------
export { Color } from './core/color.ts';
export { Rotate, Scale, Transform } from './core/transform.ts';
export { concatSvgr, stringifySvgrValue, svgr, Svgr } from './core/svgr.ts';
export type { SvgrValue } from './core/svgr.ts';

// --- core: scenes ----------------------------------------------------------
export { renderScenes, sceneFullName, sceneName, Scenes } from './core/scenes.ts';
export type { ResolvedScene, ResolvedScenesTimeline } from './core/scenes.ts';

// --- core: animation -------------------------------------------------------
export { Easing, solveEasing } from './core/animation/easing.ts';
export type { EasingKind, EasingLike, SpringEasingOptions } from './core/animation/easing.ts';
export { CubicBezierRuntime } from './core/animation/cubic-bezier.ts';
export { SpringRuntime } from './core/animation/spring.ts';
export type { SpringOptions } from './core/animation/spring.ts';
export { applyProgress, animationRuntimeFor, KeyFramesAnimation, timeline } from './core/animation/timeline.ts';
export type { Animatable, AnimationRuntime, KeyFrame, Tween } from './core/animation/timeline.ts';
// --- audio: the map and its tracks -----------------------------------------
export {
  audioTrack,
  audioTrackAll,
  AudioMap,
  AudioTrack,
  DEFAULT_DUCKING,
  DEFAULT_FADE_CURVE,
  DEFAULT_TRACK_MIX,
  FADE_CURVES,
  fadeCurveGain,
  framesFromSeconds,
  resolve,
  resolveAudioFrames,
  resolveAudioMap,
  resolveDucking,
  ResolvedAudioMap,
  samplesFromSeconds,
  samplesToFrames,
  secondsFromSamples,
} from './audio/audio-map.ts';
export type {
  AudioDuration,
  AudioRange,
  AudioTimeBase,
  Ducking,
  FadeCurve,
  ResolvedAudioTrack,
  ResolvedDucking,
  ResolveAudioOptions,
  SceneAudio,
  TrackMix,
} from './audio/audio-map.ts';

// --- audio: resampling, mixing, measuring, writing -------------------------
export {
  besselI0,
  getResampler,
  KAISER_BETA,
  resample,
  resampledLength,
  RESAMPLE_PHASES,
  SincResampler,
  ZERO_CROSSINGS,
} from './audio/resample.ts';

export {
  AudioMixer,
  dbToGain,
  DECLICK_SECONDS,
  DEFAULT_LIMITER_OPTIONS,
  DEFAULT_MIXER_OPTIONS,
  DEFAULT_MIX_SAMPLE_RATE,
  duckDb,
  Limiter,
  mergeRanges,
  mixAudioToFile,
  panGains,
} from './audio/mixer.ts';
export type {
  ActiveTrack,
  AudioMixerInput,
  LimiterOptions,
  MixAudioToFileOptions,
  MixerOptions,
  SampleRange,
  TrackAudio,
} from './audio/mixer.ts';

export {
  ABSOLUTE_GATE_MEAN_SQUARE,
  analyzeAudio,
  Biquad,
  dbToGain as analysisDbToGain,
  energyToLufs,
  finiteLufs,
  kWeighting,
  LoudnessAnalysis,
  MOMENTARY_HOPS,
  RELATIVE_GATE_FACTOR,
  SHORT_TERM_HOPS,
  toDb,
  truePeak,
  TRUE_PEAK_COEFFICIENT_COUNT,
  TRUE_PEAK_PHASES,
} from './audio/analysis.ts';
export type {
  AnalysisSection,
  AudioAnalysis,
  AnalyzeAudioInput,
  LoudnessWindow,
  SectionAnalysis,
} from './audio/analysis.ts';

export {
  encodeWav,
  encodeWavInterleaved,
  fromInt16,
  parseWavHeader,
  readWav,
  readWavHeader,
  toInt16,
  TpdfDither,
  WAVE_FORMAT_IEEE_FLOAT,
  WAVE_FORMAT_PCM,
  writeWav,
  writeWavSync,
} from './audio/wav.ts';
export type { EncodeWavOptions, WavBitDepth, WavFile, WavHeader, WriteWavOptions } from './audio/wav.ts';

export {
  applyWindowFunction,
  blackmanWindow,
  centerSpectrumLowFrequencies,
  fftRadix2,
  getVisualization,
  hammingWindow,
  hannWindow,
  SAMPLE_SIZES,
  WINDOW_FUNCTIONS,
} from './audio/visualize.ts';

// --- media -----------------------------------------------------------------
export {
  decodeAudioFile,
  decodeAudioFileStereo,
  decodeAudioSamples,
  DecodedAudio,
  DEFAULT_SAMPLE_RATE,
  deinterleave,
  parseF32le,
  probeDurationSeconds,
  toDecodedAudio,
} from './media/audio-decode.ts';

export {
  AUDIO_EXTENSIONS,
  FONT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  mediaKindFor,
  MediaDirectory,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './media/media-dir.ts';
export type { MediaDirectoryCheck, MediaDirectoryEntry, MediaKind } from './media/media-dir.ts';

// --- rendering -------------------------------------------------------------
export {
  buildResvgOptions,
  createRenderSession,
  createSessionMixer,
  decodeSessionAudio,
  flattenAudioMap,
  fontFamilyIsRegistered,
  framePngs,
  framesToSamples,
  isFullyTransparent,
  makeFrame,
  missingAudioFiles,
  missingAudioFilesOf,
  normalizeFontFamily,
  probeDurationSync,
  registeredFontFamilies,
  renderFramePng,
  renderFrameSvg,
  renderSvgToPng,
  renderSvgToRgba,
  resolveDuration,
  resolveScenes,
  resolveSessionAudio,
  scaledSize,
  undecodableAudio,
  videoSize,
} from './render/resvg-backend.ts';
export type {
  DurationResolution,
  PipelineOptions,
  RenderSession,
  RenderSize,
  ResvgBackendOptions,
  RgbaImage,
} from './render/resvg-backend.ts';

export { buildFfmpegArgs, encodeVideo } from './encode/ffmpeg-encoder.ts';
export type { EncodeVideoOptions, EncodeVideoResult, FrameInputFormat } from './encode/ffmpeg-encoder.ts';

// --- diagnostics -----------------------------------------------------------
export {
  fontFamiliesInSvg,
  inspectFrame,
  inspectFrames,
  inspectMedia,
  inspectVideo,
  inspectVideoDetailed,
} from './inspect/diagnostics.ts';
export type {
  DetailedInspectResult,
  ExitSeverity,
  FrameInspection,
  InspectOptions,
  MergedFinding,
  Severity,
} from './inspect/diagnostics.ts';

// --- typeset: Chinese typography (font metrics, wrapping, cards) -----------
// Ported from cy-carousel (chengyi-ai/cy-carousel-skill, MIT) — see README's "Typeset" section.
export { FontMetrics } from './typeset/font-metrics.ts';
export type { FontMetricsOptions, GlyphBounds } from './typeset/font-metrics.ts';

export {
  atoms,
  CLAUSE_END,
  CLOSING,
  FRIENDLY_AFTER,
  NO_START,
  OPENING,
  visibleLength,
  wrapText,
  wrapTextDetailed,
} from './typeset/wrap.ts';
export type { AtomsOptions, WrapLine, WrapOptions } from './typeset/wrap.ts';

export { typeset } from './typeset/text.ts';
export type { FontFace, TypeSetGlyph, TypeSetOptions, TypeSetResult, TypeSetSpecial } from './typeset/text.ts';

export { cardScene, renderCard } from './typeset/card.ts';
export type {
  AppearSpec,
  CardBlock,
  CardImageBlock,
  CardPlacement,
  CardResult,
  CardRuleBlock,
  CardSpacerBlock,
  CardSpec,
  CardTextBlock,
  TextRole,
} from './typeset/card.ts';

// --- the CLI, importable (the commands, not the entry point) ---------------
export { defaultOutputFor, ensureParent, renderText, renderVideo, RENDER_SPECS } from './cli/render.ts';
export type { RenderReport, RenderVideoOptions } from './cli/render.ts';
export { frameCommand, frameFileName, framesJson, framesText, frameSvgFileName, FRAME_SPECS, renderFrames } from './cli/frame.ts';
export type { FrameReport } from './cli/frame.ts';
export { frameSvg, svgCommand, SVG_SPECS } from './cli/svg.ts';
export { timelineCommand, timelineReport, timelineText } from './cli/timeline.ts';
export type { TimelineReport, TimelineSceneReport, TimelineTrackReport } from './cli/timeline.ts';
export { inspectCommand, inspectText, INSPECT_SPECS, parseExitSeverity } from './cli/inspect.ts';
export type { InspectJsonReport } from './cli/inspect.ts';
export {
  analyzeAudioRange,
  analyzeJson,
  analyzeText,
  audioAnalyzeCommand,
  audioAt,
  audioAtCommand,
  audioAtText,
  audioRenderCommand,
  AUDIO_SPECS,
  defaultAudioOutput,
  renderAudioToFile,
  sectionsForRange,
} from './cli/audio-cmd.ts';
export type { AudioAtReport } from './cli/audio-cmd.ts';
export { helpText, parseArgs, printError, printReport, processIo, TIME_SPECS_HELP, UsageError } from './cli/args.ts';
export type { ArgKind, ArgSpec, CliIo, ParsedArgs } from './cli/args.ts';

// `cli/main.ts` is deliberately **not** re-exported here, and this is a hard requirement, not a
// style choice.
//
// `main.ts` ends in a top-level `if (isEntryPoint()) await runCli()`. A video module
// (`examples/*/video.ts`) imports this file for its public API, so re-exporting `main.ts` from
// here closes a cycle through the dynamic import in `loadVideo`:
//
//   node src/cli/main.ts <video.ts> …
//     -> main.ts TLA `await runCli()` starts
//        -> `loadVideo` does `await import('<video.ts>')`
//           -> video.ts statically imports `src/index.ts`
//              -> index.ts statically re-exports `cli/main.ts`
//                 -> main.ts's top-level await has not settled yet
//                    => index.ts never finishes evaluating, video.ts never settles, `runCli` waits
//                       forever (Node reports "unsettled top-level await" and exits 13).
//
// The same cycle is absent on the programmatic path (`await import('cli/main.ts')` first, then
// `runCli(argv)`), which is why only direct execution hung.
//
// The commands above are safe to re-export because none of them imports `main.ts`; the CLI is a
// separate entry point, imported by path:
//
//   import { run, runCli, loadVideo } from './src/cli/main.ts';
//
// This comment is normative (DELIVERY.md decision 21): the fix for the hang is the *absence* of
// the re-export, not a change to `main.ts`. Its `if (isEntryPoint()) await runCli()` guard is the
// contract's own entry-point check and stays as it is — every video module reaches this file, so
// this file is the only side of the cycle that can be cut.
//
// If that cycle ever has to be broken differently, the fix belongs in `main.ts` (no top-level
// await — wrap it in `void runCli()` plus an explicit `process.on('beforeExit')` if needed), not in
// this file, because every video module goes through here.
