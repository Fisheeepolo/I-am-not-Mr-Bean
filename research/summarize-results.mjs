import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'results');
const dev=JSON.parse(await fs.readFile(path.join(dir,'development.json'),'utf8'));
const hold=JSON.parse(await fs.readFile(path.join(dir,'heldout.json'),'utf8'));
if(JSON.stringify(dev.sourceHashes)!==JSON.stringify(hold.sourceHashes))throw new Error('Development and heldout used different code');
const methods=['baseline','full-detail','full-balanced','full-easy','quant-detail','quant-balanced','quant-easy'];
const labels={baseline:'旧量化器', 'full-detail':'全流程·细节', 'full-balanced':'全流程·均衡', 'full-easy':'全流程·好拼','quant-detail':'同网格·细节','quant-balanced':'同网格·均衡','quant-easy':'同网格·好拼'};
const metrics=['meanDeltaE76','edgeF1','smallCells','weakSmallCells','rowTransitions','medianMs'];
const groupDefs={all:()=>true,synthetic:r=>!r.fixture.startsWith('photo-'),photo:r=>r.fixture.startsWith('photo-'),mard:r=>r.plan.startsWith('full-'),shop:r=>r.plan.startsWith('shop-'),'mard-8':r=>r.plan==='full-8','mard-16':r=>r.plan==='full-16'};
const groupLabels={all:'所有图像及预算',synthetic:'合成图（所有预算）',photo:'照片（所有预算）',mard:'MARD 全色卡（8/16 色）',shop:'店铺 12 色子集（8 色）','mard-8':'MARD 全色卡（8 色）','mard-16':'MARD 全色卡（16 色）'};
function aggregate(run){return Object.fromEntries(Object.entries(groupDefs).map(([g,filter])=>[g,Object.fromEntries(methods.map(method=>{
const rows=run.rows.filter(r=>r.method===method&&filter(r));return [method,{n:rows.length,fixtures:new Set(rows.map(r=>r.fixture)).size,...Object.fromEntries(metrics.map(m=>[m,rows.reduce((s,r)=>s+r[m],0)/rows.length])),minimumSilhouetteIoU:Math.min(...rows.map(r=>r.silhouetteIoU)),markers:rows.reduce((s,r)=>s+r.markersPreserved,0),markerTotal:rows.reduce((s,r)=>s+r.markerCount,0)}];}))]));}
const summary={created:new Date().toISOString(),protocol:hold.protocol,sourceHashes:hold.sourceHashes,development:aggregate(dev),heldout:aggregate(hold)};
await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
const b=summary.heldout.all.baseline,n=summary.heldout.all['full-balanced'],e=summary.heldout.all['full-easy'];
const change=(v,ref)=>(100*(v/ref-1)).toFixed(1)+'%';
function table(group,full=true){return `| 方法 | 平均 ΔE76 ↓ | 强边缘 F1 ↑ | 1–2 格碎片 | 弱小碎片 | 行换色 | 中位耗时均值 ms |\n|---|---:|---:|---:|---:|---:|---:|\n`+(full?methods.slice(0,4):methods.filter(m=>m==='baseline'||m.startsWith('quant-'))).map(m=>{const r=group[m];return `| ${labels[m]} | ${r.meanDeltaE76.toFixed(3)} | ${r.edgeF1.toFixed(3)} | ${r.smallCells.toFixed(1)} | ${r.weakSmallCells.toFixed(1)} | ${r.rowTransitions.toFixed(1)} | ${r.medianMs.toFixed(2)} |`;}).join('\n');}
const markdown=`# 非 AI 图纸算法：第一轮研究结果

参数冻结后首次运行的 **5 张保留图 × 3 种色卡/颜色预算**上，默认“均衡”模式的全流程相对旧量化基线：

- 平均颜色误差 ΔE76：${b.meanDeltaE76.toFixed(3)} → ${n.meanDeltaE76.toFixed(3)}，基本持平（${change(n.meanDeltaE76,b.meanDeltaE76)}）。
- 1–2 格同色碎片的总格数：平均 ${b.smallCells.toFixed(1)} → ${n.smallCells.toFixed(1)}（${change(n.smallCells,b.smallCells)}）。
- 低对比的弱小碎片：平均 ${b.weakSmallCells.toFixed(1)} → ${n.weakSmallCells.toFixed(1)}（${change(n.weakSmallCells,b.weakSmallCells)}）。
- 行内换色次数：平均 ${b.rowTransitions.toFixed(1)} → ${n.rowTransitions.toFixed(1)}（${change(n.rowTransitions,b.rowTransitions)}）。
- 强边缘位置 F1：${b.edgeF1.toFixed(3)} → ${n.edgeF1.toFixed(3)}。这些变化是图像指标，不是人类拼装速度的实测提升。

这是小规模工程评估，不能证明对所有图片最优。三种预算属于同一张图的相关条件，不应当作 15 张独立图片；报告没有显著性检验或普适置信区间。

## 保留组全流程

${Object.entries(groupLabels).map(([g,title])=>`### ${title}\n\n${table(summary.heldout[g])}`).join('\n\n')}

## 开发组（用于调整参数，不能冒充独立验证）

${table(summary.development.all)}

## 消融：固定同一网格，只换选色与空间整理

保留组，全部预算：

${table(summary.heldout.all,false)}

同网格“细节”与“均衡/好拼”的差别主要来自空间整理；同档位的同网格与全流程差别包括局部对比恢复。此消融用于解释原因，不将它与主结果混为一谈。

## 不利结果与取舍

- 开发组全流程“均衡”的平均色差 ${summary.development.all.baseline.meanDeltaE76.toFixed(3)} → ${summary.development.all['full-balanced'].meanDeltaE76.toFixed(3)}，略有上升。细线图恢复局部对比后，与面积平均参考的误差增大，这是保锐与均值保真的冲突。
- 保留组 Chelsea 猫在 MARD 最多 8 色时，均衡模式的强边缘 F1 下降约 0.058；不能声称每张照片边缘都改善。该案例和其原图完整保留在对比页。
- 保留组合成人脸在 MARD 条件下新增了 2 个小碎片格；现成像素画的输入不需要取样增强。检测出的单格结构既可能是噪点，也可能是有用细节，所以没有无条件删除全部单格。
- “好拼”进一步把保留组碎片平均降到 ${e.smallCells.toFixed(1)}、行换色降到 ${e.rowTransitions.toFixed(1)}，但颜色误差升到 ${e.meanDeltaE76.toFixed(3)}；应允许用户在原图对照下选择，而不是自动认定越平滑越好。
- 开发组宇航员在 8 色条件下，均衡模式的总小碎片比旧基线增加 73 格，同时颜色误差和边缘 F1 改善。低颜色预算下恢复结构可能增加局部拼装复杂度。

## 测试范围与可复现性

- 12 张原始图（7 开发 / 5 保留），3 种色卡预算，7 种方法，共 252 条测量。每条耗时为预热后 3 次的中位数。
- 三档输出均检查最大颜色预算与色卡成员约束；统计透明轮廓交并比和合成关键点保留数量。具体值见 JSON/CSV。
- 旧函数原样保留；统一基线取样是显式面积平均，**不是原网站浏览器高质量缩放滤镜的逐像素复刻**。
- 全流程基准直接读取固定源 RGBA 后调用 sampler；网站还涉及图像解码及最大 4 倍目标网格的预缩小。照片 fixture 源 320 像素、目标 64 格时为 5 倍，基准与浏览器并非每格像素完全相同；浏览器使用流程单独验收。
- 尚无人体工效试验、真实拼装计时、盲评识别率，照片仅 3 张。未使用生成式 AI 或模型训练。
- 方法、数据源/许可、指标定义见 ../README.md。自含 development-comparison.html 和 heldout-comparison.html 可离线打开，包含全部样例、所有预算、原图与三档结果。

最终源文件 SHA-256（开发和保留组一致；UTF-8 文本 CRLF/CR 规范为 LF）：

\`\`\`json
${JSON.stringify(hold.sourceHashes,null,2)}
\`\`\`
`;
await fs.writeFile(path.join(dir,'RESULTS.md'),markdown);
console.log(JSON.stringify({heldout:summary.heldout.all,sourceHashes:summary.sourceHashes},null,2));
