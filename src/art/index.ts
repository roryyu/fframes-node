/**
 * Art-style animation module for fframes-node.
 * Integrated from huashu-art-motion: 35 art styles, 9 explainer grammars, transitions.
 *
 * Usage:
 * ```ts
 * import { getStyle, getGrammar, getTransition, listStyles, STYLE_INDEX } from './src/art/index.ts';
 * ```
 */

// --- Core utilities ---
export * from './math.ts';
export * from './color.ts';
export * from './svg-path.ts';
export * from './types.ts';

// --- Registry ---
export {
  registerStyle,
  getStyle,
  listStyles,
  registerGrammar,
  getGrammar,
  listGrammars,
  registerTransition,
  getTransition,
  listTransitions,
  STYLE_INDEX,
} from './registry.ts';

// --- Style implementations (auto-registers on import) ---
export * from './styles/index.ts';

// --- Grammar implementations (auto-registers on import) ---
export * from './grammars/index.ts';

// --- Transition implementations (auto-registers on import) ---
export * from './transitions/index.ts';
