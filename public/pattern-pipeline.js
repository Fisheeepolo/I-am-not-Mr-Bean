import { segmentBackground } from './background-segmentation.js';
import { sampleImageForPattern } from './image-sampling.js';
import { applyImageStyle } from './image-styles.js';
import { generatePattern } from './engine.js';

/** Occupancy is decided before resizing or palette/style changes, not by whiteness. */
export function convertSourceToPattern(imageData, sourceWidth, sourceHeight, width, height, palette, options = {}) {
  const segmented = segmentBackground(imageData, sourceWidth, sourceHeight, {
    mode: options.removeBackground === true ? 'edge' : 'preserve',
    tolerance: options.backgroundTolerance ?? 20,
    contentBounds: options.contentBounds,
    scale: Math.max(sourceWidth / width, sourceHeight / height),
  });
  const sampled = sampleImageForPattern(segmented, sourceWidth, sourceHeight, width, height, options);
  const styled = applyImageStyle(sampled, width, height, options.imageStyle ?? 'original');
  const result = generatePattern(styled, width, height, palette, { ...options, removeBackground: false });
  return { ...result, algorithm: 'local-structure-v3', backgroundDiagnostics: segmented.diagnostics };
}
