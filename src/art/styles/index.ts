/**
 * Art style implementations index.
 * Registers all available art styles with the registry.
 */

import { registerStyle } from '../registry.ts';
import { postimpScene } from './postimp.ts';
import { pixel8bitScene } from './pixel8bit.ts';
import { bauhausScene } from './bauhaus.ts';
import { popScene } from './pop.ts';
import { vaporwaveScene } from './vaporwave.ts';
import { inkScene } from './ink.ts';
import { caveScene } from './cave.ts';

// Register all implemented styles
registerStyle(postimpScene);
registerStyle(pixel8bitScene);
registerStyle(bauhausScene);
registerStyle(popScene);
registerStyle(vaporwaveScene);
registerStyle(inkScene);
registerStyle(caveScene);

export { postimpScene } from './postimp.ts';
export { pixel8bitScene } from './pixel8bit.ts';
export { bauhausScene } from './bauhaus.ts';
export { popScene } from './pop.ts';
export { vaporwaveScene } from './vaporwave.ts';
export { inkScene } from './ink.ts';
export { caveScene } from './cave.ts';
