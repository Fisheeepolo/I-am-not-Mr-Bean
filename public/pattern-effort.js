/** Planning estimates only: hand placement speed varies with experience and setup. */
function dimensions(project) {
  if (!project || !Number.isInteger(project.width) || !Number.isInteger(project.height)
    || project.width < 1 || project.height < 1 || !Array.isArray(project.cells)
    || project.cells.length !== project.width * project.height) throw new Error('图纸尺寸与格子数据不一致。');
  return project;
}

/** Ignore empty margins when presenting a thumbnail; retain every occupied cell. */
export function getPatternBounds(project) {
  const { width, height, cells } = dimensions(project);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  cells.forEach((code, index) => {
    if (code == null) return;
    const x = index % width, y = Math.floor(index / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  });
  return maxX < 0 ? null : { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function rangeLabel(minimum, maximum) {
  if (maximum < 90) return `约 ${minimum}–${maximum} 分钟`;
  const hours = minutes => Math.round(minutes / 60 * 10) / 10;
  return `约 ${hours(minimum)}–${hours(maximum)} 小时`;
}

/**
 * A deliberately broad estimate, not a measured completion forecast. Complexity
 * includes adjacent color changes and beads without a same-color side neighbor.
 * Blank margins and already-marked progress do not change the full-work estimate.
 */
export function estimatePatternEffort(project) {
  const { width, height, cells } = dimensions(project);
  const colors = new Set();
  let beads = 0, neighbors = 0, changes = 0, isolated = 0;
  for (let index = 0; index < cells.length; index++) {
    const code = cells[index];
    if (code == null) continue;
    beads++; colors.add(code);
    const x = index % width, y = Math.floor(index / width);
    const around = [];
    if (x > 0) around.push(index - 1);
    if (x + 1 < width) around.push(index + 1);
    if (y > 0) around.push(index - width);
    if (y + 1 < height) around.push(index + width);
    if (!around.some(at => cells[at] === code)) isolated++;
    // Count each adjacent pair once. Empty background is not a color change.
    for (const next of [x + 1 < width ? index + 1 : -1, y + 1 < height ? index + width : -1]) {
      if (next < 0 || cells[next] == null) continue;
      neighbors++;
      if (cells[next] !== code) changes++;
    }
  }
  if (!beads) return { version: 1, difficulty: '入门', level: 1, minutesMin: 0, minutesMax: 0, label: '约 0 分钟' };
  const transitionRatio = neighbors ? changes / neighbors : 0;
  const isolatedRatio = isolated / beads;
  const score = (beads >= 500 ? 1 : 0) + (beads >= 1500 ? 1 : 0) + (beads >= 4000 ? 2 : 0)
    + (colors.size >= 8 ? 1 : 0) + (colors.size >= 16 ? 1 : 0)
    + (transitionRatio >= .35 ? 1 : 0) + (transitionRatio >= .65 ? 1 : 0)
    + (isolatedRatio >= .15 ? 1 : 0);
  const level = score >= 4 ? 3 : score >= 2 ? 2 : 1;
  const secondsPerBead = 2.5 + 2 * transitionRatio + 3 * isolatedRatio + .12 * Math.min(colors.size, 24);
  const setupMinutes = 3 + .75 * colors.size;
  const baseline = setupMinutes + beads * secondsPerBead / 60;
  const roundDown = minutes => Math.max(5, Math.floor(minutes / (minutes >= 60 ? 15 : 5)) * (minutes >= 60 ? 15 : 5));
  const roundUp = minutes => Math.ceil(minutes / (minutes >= 60 ? 15 : 5)) * (minutes >= 60 ? 15 : 5);
  const minutesMin = roundDown(baseline * .85), minutesMax = Math.max(minutesMin + 5, roundUp(baseline * 1.6));
  return { version: 1, difficulty: ['入门', '适中', '挑战'][level - 1], level, minutesMin, minutesMax, label: rangeLabel(minutesMin, minutesMax) };
}
