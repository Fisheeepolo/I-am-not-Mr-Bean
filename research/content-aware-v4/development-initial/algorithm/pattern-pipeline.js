import { segmentBackground } from './background-segmentation.js';
import { sampleImageForPattern } from './image-sampling.js';
import { abstractImageForPattern } from './image-abstraction.js';
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
  // Geometry is fixed first. Abstraction and saliency can affect colour, never
  // the alpha coverage that decides which physical bead positions exist.
  const abstracted = abstractImageForPattern(segmented, sourceWidth, sourceHeight, {
    ...options, targetWidth: width, targetHeight: height,
  });
  const sampled = sampleImageForPattern(abstracted, sourceWidth, sourceHeight, width, height, {
    ...options, analysis: abstracted.analysis,
  });
  const styled = applyImageStyle(sampled, width, height, options.imageStyle ?? 'original');
  const result = generatePattern(styled, width, height, palette, {
    ...options, removeBackground: false,
    saliencyMap: sampled.saliency, defocusMap: sampled.defocus,
  });
  return { ...result, algorithm: 'content-aware-v4', backgroundDiagnostics: segmented.diagnostics,
    abstractionDiagnostics: abstracted.diagnostics };
}
