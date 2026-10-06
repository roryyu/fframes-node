/**
 * Explainer grammar implementations index.
 * Registers all available grammars with the registry.
 */

import { registerGrammar } from '../registry.ts';
import { kurzgesagtGrammar } from './kurzgesagt.ts';
import { financeChartGrammar } from './finance-chart.ts';

// Register all implemented grammars
registerGrammar(kurzgesagtGrammar);
registerGrammar(financeChartGrammar);

export { kurzgesagtGrammar } from './kurzgesagt.ts';
export { financeChartGrammar } from './finance-chart.ts';
