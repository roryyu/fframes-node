/**
 * Art-style animation types for fframes-node.
 * Defines the contracts for art-style scenes, explainer grammars, and transitions.
 */

import type { FFramesContext } from '../core/types.ts';
import type { Frame } from '../core/frame.ts';
import type { Svgr } from '../core/svgr.ts';

/**
 * An art-style scene: renders one frame of an art-style animation as SVG.
 * Unlike the Canvas-based huashu-art-motion, this generates SVG trees.
 */
export interface ArtStyleScene {
  /** Unique style identifier (e.g. 'cave', 'egypt', 'postimp') */
  readonly id: string;
  /** Human-readable style name (Chinese) */
  readonly name: string;
  /** Art period / movement */
  readonly period: string;
  /** Quality rating: 3 = production-ready, 2 = recognizable with shortcomings, 1 = needs rework */
  readonly quality: 1 | 2 | 3;
  /** Known shortcomings to improve next time */
  readonly shortcomings?: string;
  /** Render one frame as SVG */
  renderFrame(frame: Frame, ctx: FFramesContext, params: ArtStyleParams): Svgr;
}

/**
 * Parameters that can be passed to any art style scene.
 */
export interface ArtStyleParams {
  /** Canvas width */
  readonly width: number;
  /** Canvas height */
  readonly height: number;
  /** Local time within this scene (seconds) */
  readonly localTime: number;
  /** Global time across the whole video (seconds) */
  readonly globalTime: number;
  /** Scene-specific data */
  readonly data?: Record<string, unknown>;
}

/**
 * An explainer grammar: parameterized animation clip driven by a JSON spec.
 * Ported from huashu-art-motion's clips/ system.
 */
export interface ExplainerGrammar {
  /** Grammar identifier (e.g. 'kurzgesagt', 'vox', 'whiteboard') */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Description of the grammar's visual language */
  readonly description: string;
  /** Render one frame of this grammar */
  renderFrame(frame: Frame, ctx: FFramesContext, spec: GrammarSpec): Svgr;
}

/**
 * Spec for a parameterized explainer clip.
 */
export interface GrammarSpec {
  /** Grammar ID */
  readonly grammar: string;
  /** Duration in seconds */
  readonly duration: number;
  /** FPS */
  readonly fps?: number;
  /** Width */
  readonly width: number;
  /** Height */
  readonly height: number;
  /** Safe area (px from each edge, for subtitle/platform UI) */
  readonly safe?: { top?: number; bottom?: number; left?: number; right?: number; fill?: string };
  /** Theme overrides */
  readonly theme?: Record<string, string>;
  /** Transparent background */
  readonly alpha?: boolean;
  /** Grammar-specific data */
  readonly data?: Record<string, unknown>;
  /** Timed cues */
  readonly cues: GrammarCue[];
}

export interface GrammarCue {
  /** Time in seconds when this cue becomes visible */
  readonly at: number;
  /** Cue type (grammar-specific: 'text', 'number', 'image', 'chart', etc.) */
  readonly kind: string;
  /** Primary text */
  readonly text?: string;
  /** Secondary text */
  readonly sub?: string;
  /** Additional data */
  readonly data?: Record<string, unknown>;
  /** Image URL/path */
  readonly image?: string;
  /** Duration of this cue's animation */
  readonly dur?: number;
}

/**
 * A transition between two art-style scenes.
 */
export interface ArtTransition {
  /** Transition identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Duration in seconds */
  readonly duration: number;
  /** Render the transition frame: p goes 0→1 (0 = fully scene A, 1 = fully scene B) */
  renderFrame(p: number, sceneA: Svgr, sceneB: Svgr, width: number, height: number): Svgr;
}

/**
 * Choreography values shared across scenes (cup cycle, tail wag, blink, breathe, etc.)
 */
export interface Choreography {
  /** Cup position: 0 = on table, 1 = at mouth */
  readonly cup: number;
  /** Cup position following global time (continuous across scenes) */
  readonly cupG: number;
  /** Sip head tilt */
  readonly sip: number;
  /** Cat tail wag (radians) */
  readonly tail: number;
  /** Blink: 1 = eyes closed */
  readonly blink: number;
  /** Ear twitch */
  readonly ear: number;
  /** Breathing (subtle scale) */
  readonly breathe: number;
  /** Steam time */
  readonly steam: number;
}

/**
 * Compute shared choreography values.
 * Ported from huashu-art-motion's PAINT.choreo / KIT.choreo.
 */
export function choreo(lt: number, t: number): Choreography {
  const cupCycle = (tt: number, period = 2.4) => {
    const q = ((tt % period) + period) % period;
    if (q < 0.9) return 0.5 - 0.5 * Math.cos((q / 0.9) * Math.PI);
    if (q < 1.6) return 1;
    return 0.5 + 0.5 * Math.cos(((q - 1.6) / 0.8) * Math.PI);
  };
  const k = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 2.34375);
  let q = Math.max(0, Math.min(1, (k - 0.15) / 0.7));
  q = q * q * (3 - 2 * q);
  return {
    cupG: cupCycle(t),
    cup: q,
    sip: Math.max(0, Math.sin(t * 6)) * 0.15 * q,
    tail: Math.sin(t * 5.2) * 0.35 + Math.sin(t * 11) * 0.08,
    blink: (t % 2.3) > 2.18 ? 1 : 0,
    ear: Math.max(0, Math.sin(t * 9)) > 0.97 ? 1 : 0,
    breathe: Math.sin(t * 4) * 0.012,
    steam: t,
  };
}
