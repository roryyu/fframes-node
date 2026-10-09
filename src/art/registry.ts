/**
 * Art style registry: maps style IDs to their scene implementations.
 * Ported from huashu-art-motion's 35 art-style recipe cards.
 */

import type { ArtStyleScene, ExplainerGrammar, ArtTransition } from './types.ts';

/** All registered art styles */
const styles = new Map<string, ArtStyleScene>();

/** All registered explainer grammars */
const grammars = new Map<string, ExplainerGrammar>();

/** All registered transitions */
const transitions = new Map<string, ArtTransition>();

export function registerStyle(scene: ArtStyleScene): void {
  styles.set(scene.id, scene);
}

export function getStyle(id: string): ArtStyleScene | undefined {
  return styles.get(id);
}

export function listStyles(): ArtStyleScene[] {
  return [...styles.values()];
}

export function registerGrammar(grammar: ExplainerGrammar): void {
  grammars.set(grammar.id, grammar);
}

export function getGrammar(id: string): ExplainerGrammar | undefined {
  return grammars.get(id);
}

export function listGrammars(): ExplainerGrammar[] {
  return [...grammars.values()];
}

export function registerTransition(transition: ArtTransition): void {
  transitions.set(transition.id, transition);
}

export function getTransition(id: string): ArtTransition | undefined {
  return transitions.get(id);
}

export function listTransitions(): ArtTransition[] {
  return [...transitions.values()];
}

/**
 * Style metadata from huashu-art-motion's INDEX.md.
 * Used for reference and documentation; not all styles have SVG implementations yet.
 */
export const STYLE_INDEX = [
  { id: '01_cave', name: '洞穴岩画', period: '公元前 40000 年', quality: 3, shortcomings: '人形太卡通，不够原始' },
  { id: '02_egypt', name: '埃及墓室壁画', period: '公元前 1500 年', quality: 3, shortcomings: '端杯肘偏僵' },
  { id: '03_greek', name: '阿提卡黑绘', period: '公元前 500 年', quality: 3, shortcomings: '裙摆偏厚' },
  { id: '04_roman', name: '庞贝马赛克', period: '公元 79 年', quality: 3, shortcomings: '小尺度下脸部细节少' },
  { id: '05_gothic', name: '哥特泥金手抄本', period: '13 世纪', quality: 3, shortcomings: '金发像兜帽' },
  { id: '06_renaissance', name: '文艺复兴晕涂', period: '15 世纪', quality: 2, shortcomings: '猫偏卡通；整体偏静' },
  { id: '08_impressionism', name: '印象派', period: '1870s', quality: 2, shortcomings: '脸和手被笔触打碎' },
  { id: '09_postimp', name: '梵高', period: '1889', quality: 3, shortcomings: '每帧 120ms 最重' },
  { id: '10_nouveau', name: '慕夏新艺术', period: '1890s', quality: 3, shortcomings: '猫姿势僵' },
  { id: '11_cubism', name: '分析立体主义', period: '1910s', quality: 2, shortcomings: '偏亮，深褐大面不够' },
  { id: '12_bauhaus', name: '包豪斯', period: '1920s', quality: 3, shortcomings: '猫头偏离骨架位' },
  { id: '13_pop', name: '利希滕斯坦波普', period: '1960s', quality: 3, shortcomings: '' },
  { id: '14_8bit', name: '8-bit 像素', period: '1980s', quality: 3, shortcomings: '猫头压窗台' },
  { id: '15_raytrace', name: '早期光追 CGI', period: '1990s', quality: 2, shortcomings: '猫腿直柱、脸像面具' },
  { id: '16_2026', name: '当代扁平插画', period: '2026', quality: 3, shortcomings: '' },
  { id: '17_ink', name: '中国水墨写意', period: '传统', quality: 2, shortcomings: '人物不够写意' },
  { id: '18_klimt', name: '克里姆特金色时期', period: '1900s', quality: 3, shortcomings: '桌上的手没接袖子' },
  { id: '19_munch', name: '蒙克表现主义', period: '1893', quality: 2, shortcomings: '墙面曾被读成梵高' },
  { id: '20_dunhuang', name: '敦煌壁画', period: '4-14 世纪', quality: 2, shortcomings: '飞天造型粗' },
  { id: '21_kusama', name: '草间弥生波点', period: '当代', quality: 3, shortcomings: '人物与墙同色靠轮廓撑' },
  { id: '22_constructivism', name: '俄国构成主义', period: '1920s', quality: 3, shortcomings: '缺喇叭形文字锥' },
  { id: '23_dali', name: '达利超现实', period: '1930s', quality: 2, shortcomings: '人物偏矢量插画' },
  { id: '24_hopper', name: '霍珀美国现实主义', period: '1940s', quality: 3, shortcomings: '猫全程在阴影里' },
  { id: '25_ghibli', name: '吉卜力水彩背景', period: '当代', quality: 2, shortcomings: '人物不如背景' },
  { id: '26_vaporwave', name: '蒸汽波/赛博霓虹', period: '2010s', quality: 3, shortcomings: '部件交界也发光' },
  { id: '27_kirby', name: '漫威 Kirby 银河时代', period: '1960s', quality: 2, shortcomings: '更像利希滕斯坦' },
  { id: '28_monet', name: '莫奈睡莲与日本桥', period: '1890s', quality: 2, shortcomings: '墙是池水空间别扭' },
  { id: '29_seurat', name: '修拉点彩', period: '1880s', quality: 2, shortcomings: '偏静；网格规整' },
  { id: '30_matisse', name: '马蒂斯剪纸', period: '1940s', quality: 3, shortcomings: '水粉刷痕偏重' },
  { id: '31_haring', name: '凯斯·哈林', period: '1980s', quality: 3, shortcomings: '少女不够哈林' },
  { id: '32_rembrandt', name: '伦勃朗明暗', period: '17 世纪', quality: 1, shortcomings: '人物扁平，最该重做' },
  { id: '33_rubberhose', name: '1930 橡皮管卡通', period: '1930s', quality: 3, shortcomings: '运动大半是胶片噪声' },
  { id: '34_shadowpuppet', name: '中国皮影', period: '传统', quality: 3, shortcomings: '重叠处相乘发黑' },
  { id: '35_shinkai', name: '新海诚光影', period: '当代', quality: 2, shortcomings: '室内背景密度不够' },
  { id: '36_picasso_blue', name: '毕加索蓝色时期', period: '1901-1904', quality: 2, shortcomings: '造型不够忧郁' },
  { id: '37_xiaohei', name: '小黑漫画风', period: '当代', quality: 3, shortcomings: '' },
] as const;
