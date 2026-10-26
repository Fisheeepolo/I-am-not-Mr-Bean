/** Build one offline, self-contained reading report from the measured artifacts.
 * node research/content-aware-v4/package-report.mjs
 * node research/content-aware-v4/package-report.mjs --preview
 * Optional: --output=<absolute-or-cwd-relative-file.html>
 * No algorithm, result, protocol or source file is modified by this script.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '../..');
const workspace = path.resolve(repo, '../..');
const preview = process.argv.includes('--preview');
const requestedOutput = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
const output = requestedOutput ? path.resolve(requestedOutput) : preview
  ? path.resolve(repo, '../v4-report-preview.html')
  : path.join(workspace, 'outputs', '豆豆工坊-v4算法研究报告.html');
const resultDir = path.join(root, 'results');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = async file => fs.readFile(path.resolve(root, file), 'utf8');
const json = async file => JSON.parse(await read(file));
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };
const downloads = new Map();
const downloadId = file => `source-${sha(file).slice(0, 12)}`;

async function registerSource(relative, label = relative) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(repo + path.sep)) throw new Error(`Source path escapes repository: ${relative}`);
  if (!await exists(absolute)) return null;
  const bytes = await fs.readFile(absolute), normalized = bytes.toString('utf8').replace(/\r\n?/g, '\n');
  const entry = { id: downloadId(relative), relative, label, name: relative.replace(/^(?:\.\.\/)+/, '').replace(/[\\/]/g, '__'), bytes, hash: sha(normalized) };
  downloads.set(relative, entry);
  return entry;
}

// Small deterministic TeX→native MathML renderer for the notation used by the
// research documents. Original TeX is retained beside every display formula.
// Unsupported commands throw; they never silently render an incorrect formula.
function mathML(tex) {
  let at = 0;
  const symbols = { alpha: 'α', beta: 'β', epsilon: 'ε', eta: 'η', lambda: 'λ', tau: 'τ', theta: 'θ', gamma: 'γ', mu: 'μ', sigma: 'σ', pi: 'π', rho: 'ρ', Delta: 'Δ', Sigma: 'Σ', ge: '≥', le: '≤', neq: '≠', parallel: '∥', perp: '⊥', langle: '⟨', rangle: '⟩', in: '∈', times: '×', cdot: '·', pm: '±' };
  const skip = () => { while (/\s/.test(tex[at] ?? '') && at < tex.length) at++; };
  function textGroup() {
    skip();
    if (tex[at] !== '{') throw new Error(`Expected TeX group near ${tex.slice(at, at + 30)}`);
    let depth = 1, start = ++at;
    while (at < tex.length && depth) { if (tex[at] === '{') depth++; if (tex[at] === '}') depth--; if (depth) at++; }
    if (depth) throw new Error('Unclosed TeX group');
    const value = tex.slice(start, at); at++; return value;
  }
  function atom() {
    skip();
    if (at >= tex.length) return '<mrow/>';
    if (tex[at] === '{') { at++; const body = sequence('}'); return `<mrow>${body}</mrow>`; }
    if (tex[at] === '\\') {
      at++;
      const m = tex.slice(at).match(/^[A-Za-z]+/);
      if (!m) { const punctuation = tex[at++]; return punctuation === '!' ? '' : [',', ';', ' '].includes(punctuation) ? '<mspace width="0.18em"/>' : `<mo>${esc(punctuation)}</mo>`; }
      const command = m[0]; at += command.length;
      if (command === 'frac') { const top = atom(), bottom = atom(); return `<mfrac>${top}${bottom}</mfrac>`; }
      if (command === 'sqrt') return `<msqrt>${atom()}</msqrt>`;
      if (command === 'hat' || command === 'bar') return `<mover accent="true">${atom()}<mo>${command === 'hat' ? '^' : '¯'}</mo></mover>`;
      if (command === 'mathrm' || command === 'text' || command === 'operatorname') return `<mtext>${esc(textGroup())}</mtext>`;
      if (command === 'left' || command === 'right') return atom();
      if (command === 'quad' || command === 'qquad') return `<mspace width="${command === 'quad' ? 1 : 2}em"/>`;
      if (command === 'sum') return '<mo largeop="true">∑</mo>';
      if (['exp', 'min', 'max', 'log', 'sin', 'cos'].includes(command)) return `<mi mathvariant="normal">${command}</mi>`;
      if (command === 'begin') {
        const environment = textGroup();
        if (!['bmatrix', 'pmatrix', 'matrix'].includes(environment)) throw new Error(`Unsupported TeX environment ${environment}`);
        const end = `\\end{${environment}}`, stop = tex.indexOf(end, at);
        if (stop < 0) throw new Error('Unclosed matrix');
        const matrix = tex.slice(at, stop); at = stop + end.length;
        const rows = matrix.split(/\\\\/).map(row => `<mtr>${row.split('&').map(cell => `<mtd>${mathML(cell).body}</mtd>`).join('')}</mtr>`).join('');
        const delimiters = environment === 'bmatrix' ? ['[', ']'] : environment === 'pmatrix' ? ['(', ')'] : ['', ''];
        return `<mrow><mo>${delimiters[0]}</mo><mtable>${rows}</mtable><mo>${delimiters[1]}</mo></mrow>`;
      }
      if (Object.hasOwn(symbols, command)) return `<${['ge', 'le', 'neq', 'parallel', 'perp', 'langle', 'rangle', 'in', 'times', 'cdot', 'pm'].includes(command) ? 'mo' : 'mi'}>${symbols[command]}</${['ge', 'le', 'neq', 'parallel', 'perp', 'langle', 'rangle', 'in', 'times', 'cdot', 'pm'].includes(command) ? 'mo' : 'mi'}>`;
      throw new Error(`Unsupported formula command: \\${command}`);
    }
    const number = tex.slice(at).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (number) { at += number[0].length; return `<mn>${number[0]}</mn>`; }
    const value = tex[at++];
    return /[A-Za-z]/.test(value) ? `<mi>${esc(value)}</mi>` : `<mo>${esc(value === '-' ? '−' : value)}</mo>`;
  }
  function sequence(end) {
    let body = '';
    while (at < tex.length) {
      skip(); if (end && tex[at] === end) { at++; return body; }
      if (at >= tex.length) break;
      let base = atom(), sub, sup;
      skip();
      while (tex[at] === '_' || tex[at] === '^') {
        const op = tex[at++], value = atom(); if (op === '_') sub = value; else sup = value; skip();
      }
      if (sub && sup) base = `<msubsup>${base}${sub}${sup}</msubsup>`;
      else if (sub) base = `<msub>${base}${sub}</msub>`;
      else if (sup) base = `<msup>${base}${sup}</msup>`;
      body += base;
    }
    if (end) throw new Error('Unclosed TeX formula');
    return body;
  }
  const body = sequence();
  return { body, html: `<div class="equation"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow>${body}</mrow><annotation encoding="application/x-tex">${esc(tex)}</annotation></semantics></math><details class="equation-source"><summary>公式源文</summary><pre>${esc(tex)}</pre></details></div>` };
}

function inline(source) {
  const stash = [], keep = html => `\u0001${stash.push(html) - 1}\u0002`;
  let text = source.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`));
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, href) => {
    const safe = /^https?:\/\//.test(href) || href.startsWith('#');
    return keep(safe ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : `<span class="source-name">${esc(label)} (${esc(href)})</span>`);
  });
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\u0001(\d+)\u0002/g, (_, i) => stash[Number(i)]);
}

function markdown(source, baseLevel = 2) {
  const lines = source.split(/\r?\n/); let html = '', index = 0;
  const tableDivider = line => /^\s*\|?[\s:|\-]+\|\s*$/.test(line ?? '') && (line ?? '').includes('-');
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(), code = []; index++;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      if (index >= lines.length) throw new Error('Unclosed Markdown code fence');
      index++; html += `<div class="code-block"><span class="code-label">${esc(language || '公式 / 伪代码')}</span><pre><code>${esc(code.join('\n'))}</code></pre></div>`; continue;
    }
    if (line.trim() === '\\[') {
      const formula = []; index++; while (index < lines.length && lines[index].trim() !== '\\]') formula.push(lines[index++]);
      if (index >= lines.length) throw new Error('Unclosed display formula');
      index++; html += mathML(formula.join('\n')).html; continue;
    }
    if (/^ {4}\S/.test(line)) {
      const block = []; while (index < lines.length && /^ {4}/.test(lines[index])) block.push(lines[index++].slice(4));
      html += `<pre class="formula-code">${esc(block.join('\n'))}</pre>`; continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { const level = Math.min(6, heading[1].length + baseLevel); html += `<h${level}>${inline(heading[2])}</h${level}>`; index++; continue; }
    if (line.trim().startsWith('|') && tableDivider(lines[index + 1])) {
      const cells = value => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(part => inline(part.trim()));
      html += `<div class="table-wrap" tabindex="0" aria-label="可横向滚动的数据表"><table><thead><tr>${cells(line).map(c => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>`;
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) html += `<tr>${cells(lines[index++]).map(c => `<td>${c}</td>`).join('')}</tr>`;
      html += '</tbody></table></div>'; continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line), re = ordered ? /^\d+\.\s+/ : /^\s*[-*]\s+/;
      html += ordered ? '<ol>' : '<ul>';
      while (index < lines.length && re.test(lines[index])) html += `<li>${inline(lines[index++].replace(re, ''))}</li>`;
      html += ordered ? '</ol>' : '</ul>'; continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !/^(?:#{1,6}\s|```| {4}|\s*[-*]\s|\d+\.\s|\s*\||\s*\\\[)/.test(lines[index])) paragraph.push(lines[index++]);
    html += `<p>${inline(paragraph.join(' '))}</p>`;
  }
  return html;
}

const sourceDocs = ['THEORY.md', 'SAMPLING.md', 'OPTIMIZER.md', 'PROTOCOL.md', 'SOURCES.md', 'TASK.md', 'REPRODUCE.md'];
const docs = Object.fromEntries(await Promise.all(sourceDocs.map(async file => [file, await read(file)])));
for (const file of sourceDocs) await registerSource(file);
const scriptFiles = ['package-report.mjs', 'run-benchmark.mjs', 'evaluate-results.py', 'report-results.py', 'metrics.py', 'lock-protocol.mjs', 'protocol-lock.json', 'fixtures.json', 'requirements.txt'];
for (const file of scriptFiles) await registerSource(file);
for (const name of ['pattern-pipeline.js', 'image-abstraction.js', 'image-sampling.js', 'pattern-optimizer.js', 'graph-cuts.js', 'color-utils.js', 'background-segmentation.js']) await registerSource(`../../public/${name}`);

let runs = {}, finalMarkdown = '', gallery = '', plots = '', summaryCards = '', outcome = '', regression = '', history = '', supplement = '', discussion = '', qa = '';
const historyDirs = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('development-')).map(entry => entry.name).sort();
const proxyCaution = `<div class="pending"><strong>边缘 F1 = 1，也可能没有保住细节</strong><p>低反差案例中，Canny 在源图上就可能检测不到那处细节；细节被擦掉后仍然没有检测边，按“两边均无边”的定义会得到 F1 = 1。这是自动参照的盲点，不是算法完美。必须同时核对指定小特征的保留指标和实际图纸。</p></div>`;
const historyIntro = `<p>开发中暴露的问题单独保留：低反差细节失败、眼睛参照点标注修复，以及显著性消融的混杂。v4.1 的 noSaliency 在关闭 W 时还提高了对比恢复强度，旧结果只能解释为混合干预；v4.2 修为仅关闭 W，并增加 noMicroProtection 消融。历史结果不替换最终同条件对比。</p>${proxyCaution}`;
if (preview) {
  outcome = '<p class="pending"><strong>方法布局预览 · 尚非最终结果</strong><br>本预览不显示评测数字、通过率或胜负结论。最终版只有在开发组、新保留组、白色安全回归齐全且源码核对通过后生成。</p>';
  finalMarkdown = '<p class="placeholder">最终结果区：读取独立评测生成的 RESULTS.md，完整保留逐图得失、消融和颜色预算比较。</p>';
  gallery = '<div class="placeholder">此处将内嵌全部新保留组与开发组逐图对照，图片包含在同一个 HTML 文件内。</div>';
  plots = '<div class="placeholder">此处将展示实际输出总览与色差—碎片取舍图。</div>';
  history = historyIntro + historyDirs.map(name => `<p><code>${esc(name)}</code>：历史证据已存档，预览不展示数值。</p>`).join('');
} else {
  const required = ['development.json', 'heldout.json', 'white-regression.json', 'RESULTS.md', 'summary.json', 'heldout-comparison.html', 'development-comparison.html', 'contact-sheet.png', 'pareto.svg'];
  for (const file of required) if (!await exists(path.join(resultDir, file))) throw new Error(`Final evidence incomplete: results/${file}. Use --preview for a non-numeric layout preview.`);
  runs = Object.fromEntries(await Promise.all(['development', 'heldout', 'white-regression'].map(async split => [split, await json(`results/${split}.json`)])));
  const fixtureList = await json('fixtures.json');
  const methods = [...new Set([...(await read('run-benchmark.mjs')).matchAll(/\{\s*id\s*:\s*['"]([^'"]+)['"]/g)].map(match => match[1]))];
  if (!methods.includes('v3') || !methods.includes('full') || methods.length < 8) throw new Error('Cannot determine the declared benchmark methods');
  const currentProtocolHash = sha(await fs.readFile(path.join(root, 'protocol-lock.json')));
  const currentMetricHash = sha((await read('metrics.py')).replace(/\r\n?/g, '\n'));
  for (const [split, run] of Object.entries(runs)) {
    if (!run.finishedAt || !Array.isArray(run.rows) || !run.rows.length) throw new Error(`Incomplete ${split} run`);
    if (run.protocolLockHash !== currentProtocolHash || run.evaluationHash !== currentMetricHash) throw new Error(`${split}: protocol or independent metrics changed after evaluation`);
    for (const [relative, expected] of Object.entries(run.sourceHashes ?? {})) {
      const absolute = path.resolve(root, relative);
      if (!absolute.startsWith(repo + path.sep)) throw new Error('Unexpected source hash path');
      if (sha((await fs.readFile(absolute, 'utf8')).replace(/\r\n?/g, '\n')) !== expected) throw new Error(`${split}: evaluated algorithm no longer matches ${relative}`);
    }
    if (!Object.keys(run.sourceHashes ?? {}).length) throw new Error(`${split}: missing algorithm hashes`);
    if (split !== 'white-regression') {
      const seen = new Set(run.rows.map(row => `${row.fixture}|${row.maxColors}|${row.method}`));
      let expectedRows = 0;
      for (const fixture of fixtureList.filter(f => f.split === split)) for (const budget of [12, 18, 24]) for (const method of budget === 18 ? methods : ['v3', 'full']) {
        expectedRows++; if (!seen.has(`${fixture.id}|${budget}|${method}`)) throw new Error(`${split}: missing ${fixture.id}/K${budget}/${method}`);
      }
      if (run.rows.length !== expectedRows || seen.size !== expectedRows) throw new Error(`${split}: incomplete or duplicated rows`);
    }
    if (run.rows.some(row => row.occupancyMismatchVsV3 !== 0 || row.usedColors > row.maxColors)) throw new Error(`${split}: hard occupancy or colour-budget invariant failed`);
    for (const suffix of ['json', 'csv']) await registerSource(`results/${split}.${suffix}`);
  }
  const latestEvaluation = Math.max(...await Promise.all(Object.keys(runs).map(async split => (await fs.stat(path.join(resultDir, `${split}.json`))).mtimeMs)));
  for (const file of ['RESULTS.md', 'summary.json', 'heldout-comparison.html', 'development-comparison.html', 'contact-sheet.png', 'pareto.svg']) {
    if ((await fs.stat(path.join(resultDir, file))).mtimeMs + 1000 < latestEvaluation) throw new Error(`Stale result presentation: ${file}; rerun report-results.py after all evaluations.`);
  }
  const main = runs.heldout.rows.filter(row => row.maxColors === 18), oldRows = main.filter(row => row.method === 'v3'), newRows = main.filter(row => row.method === 'full');
  const avg = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  const f = (value, decimals = 3) => Number.isFinite(value) ? value.toFixed(decimals) : '—';
  const pct = value => `${f(value * 100, 2)}%`;
  const metrics = [
    ['颜色误差', 'meanDeltaE2000', value => f(value), '↓ 越低越接近固定参考'],
    ['显著性加权色差', 'saliencyWeightedDeltaE2000', value => f(value), '↓ 固定源图权重'],
    ['边缘 F1 · 精确', 'edgeExactF1', value => f(value), '↑ 自动边缘参照'],
    ['边缘 F1 · 容差一豆', 'edgeTol1F1', value => f(value), '↑ 允许位置偏差'],
    ['原始碎片率', 'speckleRatio', pct, '↓ 包括眼睛与高光'],
    ['算法耗时', 'medianMs', value => `${f(value, 1)} ms`, '↓ 不等于实体拼装时间']
  ];
  summaryCards = `<div class="metric-grid">${metrics.map(([label, key, format, note]) => `<article class="metric"><span>${label}</span><div><small>v3 ${format(avg(oldRows, key))}</small><strong>v4 ${format(avg(newRows, key))}</strong></div><p>${note}</p></article>`).join('')}</div>`;
  const passed = newRows.filter(row => row.speckleBelow005).length;
  outcome = `<div class="outcome"><strong>先看目标有没有达成</strong><p>新保留组的 K18 主比较中，v4 有 <b>${passed} / ${newRows.length}</b> 张图的原始碎片率低于 0.5%。原始碎片包括有用的单颗眼睛和高光；不能用豁免后的数值代替这个目标。</p><p>下面同时列出颜色、结构、碎片和运行代价。某项改善不能证明其他项也改善；逐图失败与开发修订均保留。没有实体拼装测时或参与者辨认度实验。</p></div>${proxyCaution}`;
  finalMarkdown = markdown(await read('results/RESULTS.md'));
  await registerSource('results/RESULTS.md'); await registerSource('results/summary.json');
  async function embeddedGallery(split) {
    let body = await read(`results/${split}-comparison.html`);
    if (/<script\b/i.test(body) || /(?:src|href)\s*=\s*["'](?:javascript:|https?:\/\/[^"']+\.(?:js|css))/i.test(body)) throw new Error(`Unexpected active content in ${split} gallery`);
    body = body.replace(/<!doctype[^>]*>|<\/?html[^>]*>|<\/?head[^>]*>|<\/?body[^>]*>/gi, '').replace(/<meta\b[^>]*>|<title>[\s\S]*?<\/title>|<style>[\s\S]*?<\/style>/gi, '');
    if ([...body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)/gi)].some(m => !m[1].startsWith('data:image/'))) throw new Error(`${split} gallery contains a non-embedded image`);
    return `<details class="gallery-details" ${split === 'heldout' ? 'open' : ''}><summary>${split === 'heldout' ? '新保留组 · 全部图像' : '开发组 · 全部图像'}</summary><div class="evidence-gallery">${body.replaceAll('<h1>', '<h3>').replaceAll('</h1>', '</h3>')}</div></details>`;
  }
  gallery = await embeddedGallery('heldout') + await embeddedGallery('development');
  plots = `<figure><img src="data:image/png;base64,${(await fs.readFile(path.join(resultDir, 'contact-sheet.png'))).toString('base64')}" alt="全部保留图像的源图、v3、v4与无预抽象实际图纸对照"><figcaption>实际图纸总览。下方逐图区域提供全部指标、消融输出和颜色预算对照。</figcaption></figure><figure><img src="data:image/svg+xml;base64,${(await fs.readFile(path.join(resultDir, 'pareto.svg'))).toString('base64')}" alt="颜色误差与原始碎片率的取舍散点图"><figcaption>同一张图在不同色数预算下可能落到不同位置。左右、上下分别只表示相应指标，不构成总体最优排名。</figcaption></figure>`;
  const white = runs['white-regression'].rows;
  regression = `<p>这些白色专项图此前已经看过，属于安全回归，不重新称为独立保留。</p><div class="table-wrap"><table><thead><tr><th>处理模式</th><th>算法</th><th>测量条数</th><th>白色前景误删 / 白色前景</th><th>背景残留 / 背景</th><th>占位变化</th></tr></thead><tbody>${[false, true].flatMap(remove => ['v3', 'full'].map(method => {
    const rr = white.filter(row => row.removeBackground === remove && row.method === method), sum = key => rr.reduce((total, row) => total + row[key], 0);
    return `<tr><td>${remove ? '尝试去外底' : '保留原图'}</td><td>${method === 'full' ? 'v4' : 'v3'}</td><td>${rr.length}</td><td>${sum('deletedWhite')} / ${sum('whiteForeground')}</td><td>${sum('retainedBackground')} / ${sum('background')}</td><td>${sum('occupancyMismatchVsV3')}</td></tr>`;
  })).join('')}</tbody></table></div>`;
  history = historyIntro;
  for (const directory of historyDirs) {
    if (!await exists(path.join(root, directory, 'RESULTS.md'))) continue;
    await registerSource(`${directory}/RESULTS.md`); await registerSource(`${directory}/summary.json`);
    history += `<details class="history-entry"><summary>${esc(directory)} · 历史结果，非最终结论</summary>${markdown(await read(`${directory}/RESULTS.md`), 3)}</details>`;
  }
}

// Supplementary selection study is kept outside the predeclared main matrix.
const supplementDeclared = await exists(path.join(root, 'SUPPLEMENTAL-PROTOCOL.md')) || await exists(path.join(root, 'supplement-predeclaration.json'));
for (const relative of ['README.md', 'SUPPLEMENTAL-PROTOCOL.md', 'supplement-predeclaration.json', 'PALETTE-STUDY.md', 'QA.md']) await registerSource(relative);
if (!preview && !await exists(path.join(root, 'requirements.txt'))) throw new Error('Missing pinned reproduction requirements.txt');
if (preview) {
  supplement = '<p class="placeholder">补充选色实验单独呈现：真实频数 Top-K 与加权设施选色，首次主保留组运行前声明。评测完成前不展示数字或胜负结论。</p>';
  discussion = '<p class="placeholder">独立评估完成后，在此合并结果解读、负结果和自动指标的适用边界。</p>';
} else {
  const discussionFile = await exists(path.join(root, 'DISCUSSION.md')) ? 'DISCUSSION.md' : 'results/DISCUSSION.md';
  if (!await exists(path.join(root, discussionFile))) throw new Error('Final DISCUSSION.md is not ready');
  discussion = markdown(await read(discussionFile)); await registerSource(discussionFile);
  if (supplementDeclared) {
    for (const relative of ['PALETTE-STUDY.md', 'SUPPLEMENTAL-PROTOCOL.md', 'results/PALETTE-RESULTS.md', 'results/palette-study-development.json', 'results/palette-study-heldout.json']) {
      if (!await exists(path.join(root, relative))) throw new Error(`Declared supplementary evidence is not complete: ${relative}`);
      await registerSource(relative);
    }
    for (const split of ['development', 'heldout']) {
      const run = await json(`results/palette-study-${split}.json`);
      if (!Array.isArray(run.rows) || !run.rows.length) throw new Error(`Empty supplementary ${split} results`);
      for (const [relative, expected] of Object.entries(run.sourceHashes ?? {})) {
        const absolute = path.resolve(root, relative);
        if (!absolute.startsWith(repo + path.sep) || sha((await fs.readFile(absolute, 'utf8')).replace(/\r\n?/g, '\n')) !== expected) throw new Error(`Supplementary source mismatch: ${relative}`);
      }
      await registerSource(`results/palette-study-${split}.csv`);
    }
    supplement = `<p class="section-note">这项补充实验与主矩阵分开，不替换主结论，也不用于调整已冻结算法。比较方法、声明时间、全部正负结果和分阶段时延以原始报告为准。</p>${markdown(await read('PALETTE-STUDY.md'))}${markdown(await read('results/PALETTE-RESULTS.md'))}<details><summary>补充实验的预先声明</summary>${markdown(await read('SUPPLEMENTAL-PROTOCOL.md'), 3)}</details>`;
  } else supplement = '<p>本次没有声明或纳入补充选色实验。</p>';
}
if (await exists(path.join(root, 'QA.md'))) qa = markdown(await read('QA.md'));
else qa = '<p class="section-note">未合并单独的 QA.md；本报告不据此宣称网站验收已通过。</p>';
if (await exists(path.join(root, 'README.md'))) history += `<details><summary>研究过程总记录</summary>${markdown(await read('README.md'), 3)}</details>`;

const sourceLinks = [...downloads.values()].map(entry => `<a id="${entry.id}" class="download" href="data:text/plain;charset=utf-8;base64,${entry.bytes.toString('base64')}" download="${esc(entry.name)}"><strong>${esc(entry.label)}</strong><span>下载原文件 · SHA256 ${entry.hash.slice(0, 12)}…</span></a>`).join('');
const docSection = (id, title, file, note = '') => `<section id="${id}" class="report-section"><div class="section-heading"><span>${title}</span><a href="#${downloadId(file)}">下载 ${file}</a></div>${note ? `<p class="section-note">${note}</p>` : ''}${markdown(docs[file])}</section>`;
const css = `
:root{color-scheme:light;--ink:#2e2939;--muted:#71667d;--purple:#7552a8;--line:#e5dfed;--paper:#fff;--wash:#f5f1f8;--mint:#eaf6ef;--amber:#fff2de}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:30px}body{margin:0;background:#f8f6fa;color:var(--ink);font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif}a{color:#674592;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #b69bd9;outline-offset:4px}.layout{max-width:1540px;margin:auto;display:grid;grid-template-columns:220px minmax(0,1fr);gap:34px;padding:32px}.toc{position:sticky;top:28px;align-self:start;max-height:calc(100vh - 56px);overflow:auto;padding:8px}.toc .brand{font-size:19px;font-weight:750;letter-spacing:1px;margin:0 0 16px}.toc ol{list-style:none;padding:0;margin:0}.toc a{display:block;padding:8px 10px;text-decoration:none;border-radius:8px;font-size:14px}.toc a:hover{background:#ece4f5}.toc small{display:block;color:var(--muted);font-size:12px;margin:20px 10px}.report{min-width:0}.hero{background:linear-gradient(130deg,#eee6f8,#fff5e8);border:1px solid var(--line);border-radius:24px;padding:38px 42px}.eyebrow{font-size:12px;letter-spacing:2px;color:#8b6ba7;font-weight:700}.hero h1{font-size:clamp(28px,3vw,42px);line-height:1.3;letter-spacing:-1px;margin:14px 0}.hero p{font-size:17px;max-width:870px;color:#665873}.hero .meta{font-size:13px;color:#7d6e8c}.button{display:inline-block;background:var(--purple);color:white;border-radius:9px;padding:8px 16px;font-size:14px;text-decoration:none}.report-section{margin-top:28px;padding:30px 34px;background:var(--paper);border:1px solid var(--line);border-radius:18px;min-width:0}.section-heading{display:flex;gap:14px;justify-content:space-between;align-items:baseline;font-size:24px;font-weight:730;margin-bottom:20px}.section-heading>a{font-size:12px;font-weight:400;white-space:nowrap}.section-note,.muted{color:var(--muted)}h2{font-size:23px;line-height:1.5;margin-top:28px}h3{font-size:21px;line-height:1.5;margin:25px 0 12px;color:#58426f}h4{font-size:18px;margin-top:27px}h5,h6{font-size:16px}p{margin:12px 0}li{margin:7px 0}strong{font-weight:700}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:22px 0}.metric{background:#faf8fc;border:1px solid var(--line);border-radius:12px;padding:17px}.metric>span{font-size:14px;color:#655671}.metric small{font-size:14px;color:#84768e;display:block;margin:7px 0}.metric strong{font-size:24px;display:block;font-variant-numeric:tabular-nums}.metric p{font-size:12px;color:#84768e;margin:7px 0 0}.outcome,.pending{padding:19px 23px;background:var(--wash);border-left:4px solid var(--purple);border-radius:8px}.pending{background:var(--amber);border-color:#d8a15d}.outcome p:last-child{margin-bottom:0}.placeholder{padding:40px;color:#81738f;background:#faf8fc;border:1px dashed #cbbbdf;border-radius:12px;text-align:center;margin:18px 0}.table-wrap,.evidence-gallery .scroll{overflow:auto;border:1px solid var(--line);border-radius:10px;margin:18px 0}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}td,th{padding:10px 12px;text-align:right;border-bottom:1px solid #eee9f2;white-space:nowrap}td:first-child,th:first-child{text-align:left}th{background:#f3eef8;color:#584367;font-weight:650}tr:last-child td{border-bottom:0}tbody tr:hover{background:#fcfafc}code{background:#f0ebf6;padding:2px 5px;border-radius:4px;font:13px/1.7 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}pre{margin:0;overflow:auto;tab-size:2;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.8 ui-monospace,Consolas,monospace}pre code{background:none;padding:0}.code-block{background:#f7f4fa;border:1px solid #e8e0ef;border-radius:11px;margin:20px 0;overflow:hidden}.code-label{display:block;padding:5px 16px;border-bottom:1px solid #e8e0ef;color:#84718d;font-size:11px;text-transform:uppercase}.code-block pre{padding:17px 19px}.formula-code{padding:20px;background:#f7f4fa;border-left:3px solid #b5a0ce;border-radius:7px;font:16px/1.9 "Cambria Math","Segoe UI Symbol",serif;white-space:pre-wrap}.equation{padding:19px 20px;background:#faf8fc;border:1px solid #eee7f4;border-radius:10px;margin:20px 0;overflow:auto}.equation math{font-size:21px;min-width:max-content}.equation-source{font-size:11px;margin-top:12px;color:#94869d}.equation-source summary{padding:0;background:none}.equation-source pre{margin-top:8px;font-size:11px}.report figure{margin:22px 0}.report figure>img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:10px;background:white}.report figcaption{font-size:13px;color:var(--muted);margin-top:9px}details{margin:15px 0}summary{cursor:pointer;padding:12px 16px;border-radius:9px;background:#f3edf8;font-weight:650;color:#654a7e}.history-entry[open]{padding-bottom:20px;border-bottom:1px solid var(--line)}.evidence-gallery{padding-top:10px}.evidence-gallery>h3{font-size:19px}.evidence-gallery>section{padding:24px 0;border-bottom:1px solid var(--line)}.evidence-gallery .grid{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:12px}.evidence-gallery .grid img{width:100%;height:190px;object-fit:contain;image-rendering:pixelated;background:#f2edf6;border-radius:8px}.evidence-gallery .source img{image-rendering:auto}.evidence-gallery .tile b{display:block;font-size:13px;line-height:1.5;margin:9px 0}.evidence-gallery .tile small{display:block;font-size:11px;line-height:1.7;color:#786b83}.evidence-gallery footer{font-size:12px;color:var(--muted);border:0;padding:10px 0}.evidence-gallery details>img{max-width:100%;object-fit:contain}.download-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.download{display:block;border:1px solid var(--line);border-radius:10px;padding:13px 15px;text-decoration:none;overflow-wrap:anywhere}.download strong{font-size:12px;display:block}.download span{font-size:11px;color:#8a7b96;display:block;margin-top:4px}.download:hover{background:#faf6fe}.footnote{padding:24px 5px;font-size:12px;color:#887a94}.source-name{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
@media(max-width:1100px){.layout{grid-template-columns:170px minmax(0,1fr);gap:18px;padding:20px}.hero{padding:28px}.report-section{padding:24px}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.evidence-gallery .grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:720px){.layout{display:block;padding:12px}.toc{position:static;max-height:none;padding:0 8px 15px}.toc ol{display:flex;flex-wrap:wrap;gap:3px}.toc a{font-size:12px;padding:6px 8px;background:#f0eaf7}.toc small{display:none}.hero{padding:25px 22px;border-radius:17px}.hero p{font-size:15px}.report-section{padding:20px 16px;border-radius:13px;margin-top:16px}.section-heading{font-size:21px;display:block}.section-heading>a{display:block;margin-top:5px}.metric strong{font-size:20px}.download-grid{grid-template-columns:1fr}.evidence-gallery .grid img{height:155px}body{font-size:15px}.equation math{font-size:18px}}
@media print{body{background:white;font-size:11px}.layout{display:block;padding:0}.toc,.button,.equation-source,.download-grid{display:none}.hero,.report-section{border:0;border-radius:0;padding:10px 0;margin:0 0 20px;background:white}.metric-grid{grid-template-columns:repeat(3,1fr)}.report-section{break-before:page}.table-wrap{overflow:visible}table{font-size:9px}td,th{white-space:normal;padding:4px}.equation{break-inside:avoid}.hero h1{font-size:26px}.evidence-gallery .grid{grid-template-columns:repeat(4,1fr)}.evidence-gallery .grid img{height:120px}.footnote{font-size:9px}a{color:inherit}details:not([open]){display:block}summary{background:none;padding-left:0}}
`;
const date = preview ? '评测完成后生成正式版本' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'long', timeStyle: 'short' }).format(new Date(runs.heldout.finishedAt));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="豆豆工坊非AI图纸转换算法v4研究：实际输出、全部指标、方法、失败结果与复现源文件。"><title>豆豆工坊 · v4 算法研究报告${preview ? ' · 布局预览' : ''}</title><style>${css}</style></head><body><div class="layout"><nav class="toc" aria-label="报告目录"><p class="brand">豆豆工坊 · 研究</p><ol>${[['overview','先看结果'],['evidence','实际图纸对照'],['measurements','完整实测数据'],['discussion','结果怎样解读'],['supplement','补充选色实验'],['white','白色安全回归'],['qa','网站验收记录'],['history','失败与修订记录'],['theory','理论边界'],['sampling','源图处理与取样'],['optimizer','选色与拼装优化'],['protocol','怎么做实验'],['sources','图像与工具来源'],['reproduce','复现与源文件']].map(([id,label])=>`<li><a href="#${id}">${label}</a></li>`).join('')}</ol><small>图片、公式和下载源文内嵌。阅读本报告不需要联网；外部论文链接需联网打开。</small></nav><main class="report"><header class="hero"><span class="eyebrow">BEAD BY BEAD · RESEARCH V4</span><h1>保留图片特征，<br>也让图纸更容易拼</h1><p>这是一次非 AI 转换算法的工程研究：从源图整理、重要结构取样，到真实色卡匹配和色块优化。报告同时展示改善、退化和无法判断的部分。</p><p class="meta">${esc(date)} · ${preview ? '方法排版预览' : '同一管线输出 · 固定协议 · 独立指标'}</p><a class="button" href="https://doudou-studio-1025.breezymesa9.chatgpt.site/" target="_blank" rel="noreferrer">打开豆豆工坊</a></header><section id="overview" class="report-section"><div class="section-heading"><span>先看结果与代价</span></div>${outcome}${summaryCards}<p class="section-note">表中颜色数是实验预算，碎片是同色连通区域只有一两格的豆子。它们帮助比较算法，不能直接代表人实际要拼多久。</p></section><section id="evidence" class="report-section"><div class="section-heading"><span>实际图纸，完整摆在一起</span></div>${plots}${gallery}</section><section id="measurements" class="report-section"><div class="section-heading"><span>完整实测数据</span></div>${finalMarkdown}</section><section id="discussion" class="report-section"><div class="section-heading"><span>结果怎样解读</span></div>${discussion}</section><section id="supplement" class="report-section"><div class="section-heading"><span>补充：选色策略的独立比较</span></div>${supplement}</section><section id="white" class="report-section"><div class="section-heading"><span>白色前景安全回归</span></div>${regression || '<p class="placeholder">正式打包时读取白色安全回归的实际记录，不预填通过结果。</p>'}</section><section id="qa" class="report-section"><div class="section-heading"><span>网站验收记录</span></div>${qa}</section><section id="history" class="report-section"><div class="section-heading"><span>失败与修订都留下</span></div>${history}</section>${docSection('theory','理论边界','THEORY.md')}${docSection('sampling','源图处理与内容加权取样','SAMPLING.md')}${docSection('optimizer','真实色卡与拼装优化','OPTIMIZER.md')}${docSection('protocol','实验怎么做','PROTOCOL.md')}${docSection('sources','图像与工具从哪里来','SOURCES.md')}<section id="reproduce" class="report-section"><div class="section-heading"><span>复现与源文件</span></div><p>下面链接下载本报告生成时读取的原文件。结果 JSON 保留逐图测量与算法散列；完整图像和冻结基线仍在项目的 research/content-aware-v4 目录中。下载文件不会调用网络服务。</p>${markdown(docs['REPRODUCE.md'])}<p class="section-note">如需安装依赖，请使用下方 requirements.txt 所列版本；原电脑的独立 Python 路径与其他电脑的虚拟环境步骤均在正文中。复现说明本身不是执行证明，以结果 JSON 的运行记录为准。</p><div class="download-grid">${sourceLinks}</div></section><footer class="footnote">本报告没有使用人工辨认度打分或实体拼装试验。自动边缘、显著性和虚化图是明确披露的代理指标。不能从这一组样例推出普适最优、光学散焦真值或真实操作时间提升。${preview ? '<br><strong>预览文件不是最终验收证据。</strong>' : ''}</footer></main></div></body></html>`;

if (/<(?:img|script|link|iframe)\b[^>]*(?:src|href)=["']https?:\/\//i.test(html)) throw new Error('Report unexpectedly requires an external asset');
if (/<script\b/i.test(html)) throw new Error('Report must remain script-free');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, html, 'utf8');
console.log(JSON.stringify({ output, preview, bytes: Buffer.byteLength(html), embeddedSources: downloads.size, sha256: sha(html) }, null, 2));
