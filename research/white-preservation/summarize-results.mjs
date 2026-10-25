import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),dir=path.join(root,'results');
const dev=JSON.parse(await fs.readFile(path.join(dir,'regression.json'),'utf8')),
 hold=JSON.parse(await fs.readFile(path.join(dir,'heldout.json'),'utf8'));
if(JSON.stringify(dev.sourceHashes)!==JSON.stringify(hold.sourceHashes))throw new Error('Measured sources differ between regression and fresh heldout');
const labels={'v2-20':'旧版 · 容差20','v2-60':'旧版 · 容差60','v3-preserve':'新版 · 默认保留','v3-edge-5':'新版去底 · 容差5','v3-edge-20':'新版去底 · 容差20','v3-edge-60':'新版去底 · 容差60'};
const sum=(rows,key)=>rows.reduce((s,r)=>s+r[key],0),percent=x=>x==null?'—':(100*x).toFixed(2)+'%';
function aggregate(rows){return Object.fromEntries(Object.keys(labels).map(method=>{
 const a=rows.filter(r=>r.method===method),counts=Object.fromEntries(['foreground','whiteForeground','background','deletedForeground','deletedWhite','retainedBackground','retained'].map(k=>[k,sum(a,k)]));
 return[method,{cases:a.length,...counts,whiteDeletionRate:counts.whiteForeground?counts.deletedWhite/counts.whiteForeground:null,foregroundDeletionRate:counts.foreground?counts.deletedForeground/counts.foreground:null,backgroundRetentionRate:counts.background?counts.retainedBackground/counts.background:null,medianMsMean:a.length?sum(a,'medianMs')/a.length:null,
 reasons:Object.fromEntries([...new Set(a.map(r=>r.backgroundDiagnostics?.reason||'v2-no-diagnostic'))].map(reason=>[reason,a.filter(r=>(r.backgroundDiagnostics?.reason||'v2-no-diagnostic')===reason).length]))}];
}));}
const summary={protocol:hold.protocol,timestamp:hold.timestamp,sourceHashes:hold.sourceHashes,regression:aggregate(dev.rows),regressionNonAmbiguous:aggregate(dev.rows.filter(r=>!r.ambiguous)),heldout:aggregate(hold.rows)};
await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
function table(s){return '| 方法 | 白色误删格 / 真值白格 | 白色误删率 | 全部前景误删率 | 背景残留率 |\n|---|---:|---:|---:|---:|\n'+Object.entries(s).map(([method,r])=>`| ${labels[method]} | ${r.deletedWhite} / ${r.whiteForeground} | ${percent(r.whiteDeletionRate)} | ${percent(r.foregroundDeletionRate)} | ${percent(r.backgroundRetentionRate)} |`).join('\n');}
const b=summary.heldout['v2-20'],p=summary.heldout['v3-preserve'],e=summary.heldout['v3-edge-20'];
const caseRows=hold.rows.filter(r=>r.method==='v3-edge-20'),segmented=caseRows.filter(r=>r.backgroundDiagnostics?.status==='removed'||r.backgroundDiagnostics?.reason==='edge-background');
const removedBgs=sum(segmented,'background'),keptBgs=sum(segmented,'retainedBackground');
const md=`# 白色主体保护专项：实测结果

本轮先修正“哪些位置存在豆”，再进行颜色量化。问题版本的默认背景泛洪会穿过缩小后变浅的灰线，还可能把占据两个角的白色前景当成背景。上一轮算法研究关闭了去背景，因此未覆盖这项错误。

## 结论与代价

在第二轮参数冻结后的 **4 个新建带真值保留样例**上，旧默认容差20误删了 **${b.deletedWhite}/${b.whiteForeground} 个真值白格（${percent(b.whiteDeletionRate)}）**；新版默认保留和主动去底容差20均为 **${p.deletedWhite}/${p.whiteForeground}（${percent(p.whiteDeletionRate)}）**。这仅描述针对白色安全问题设计的合成样例，不能推断真实用户图片的平均改善率。

主动去底保留了前景，但不是每次都删除所有背景：4 例合计背景残留 **${percent(e.backgroundRetentionRate)}**。其中十字、斜框、白环三例进行了去底，残留 ${keptBgs}/${removedBgs} 格（${percent(keptBgs/removedBgs)}）；透明原图沿用原生 alpha。白环的封闭内孔属于不与外界相连的空白意图，新算法没有擅自推断并删除它，因此该例仍有16/115格背景残留。默认保留模式保留不透明背景，这是避免擅自删主体的产品行为，不应被称为自动抠图成功。

## 迭代历史没有被抹掉

首轮7个开发例、5个保留例的结果与代码散列保留在 round1/。随后原项目已有的9×9原尺寸黑环集成测试发现白色晕边：应保留25格，实际65格。修复针对这一已知集成失败，屏障不再同时覆盖边界外白色，并调整闭合的边界规则。由于旧5个保留例已经看过，**原12例全部转为回归组**，不再声称独立验证。第二轮另外固定4例，在参数再次冻结后首次运行；没有根据这4例的结果调参。

## 第二轮新保留组全部结果

${table(summary.heldout)}

### 主动去底容差20的逐例结果

| 样例 | 白色误删 / 白格 | 全部前景误删 / 前景格 | 背景残留 / 背景格 | 诊断 |
|---|---:|---:|---:|---|
${caseRows.map(r=>`| ${r.title} | ${r.deletedWhite}/${r.whiteForeground} | ${r.deletedForeground}/${r.foreground} | ${r.retainedBackground}/${r.background}（${percent(r.backgroundRetentionRate)}） | ${r.backgroundDiagnostics?.reason} |`).join('\n')}

## 12例回归组（已经看过，不能冒充独立验证）

${table(summary.regression)}

上表含两个**完全相同 RGBA、不同意图掩码**的纯白对照。它们用来展示信息不足，不是可自动推断的普通分割任务；单独排除这两个歧义例后的统计如下：

${table(summary.regressionNonAmbiguous)}

回归组的“两角白物、两角背景”例仍拒绝判断并保留全部背景；“触边白物”也可能保守保留。这是误删风险与去底覆盖面的取舍，报告没有隐藏这些残留。

## 为什么没有采用“看到白色就补回来”

白色 RGB 不等于空格。原生透明信息直接给出一部分前景证据；没有透明信息时，源图的灰线、边界一致性和连通性可以提供保守线索。但完全同色的前后景无法由 RGB 唯一拆开。先保留不透明内容，再允许用户确认主体范围和主动去底，才不会以猜测覆盖原始图像。

主体范围界面是额外的用户意图输入。当前专项直接评价网站纯函数的背景掩码和转换链路，**没有测量语义主体识别准确率，也没有把人工框选当成自动识别成功**。框选界面、存取参数与浏览器绘制另行验收。

## 数学模型、实验边界与复现

- 背景分割属于掩码估计，量化属于固定掩码上的受限颜色优化。将二者分开可避免颜色误差改善掩盖主体误删。
- 实际新背景算法是边界证据、屏障闭合与四连通重建，并带拒绝机制；不是完整 GrabCut、语义分割或保证全局最优的图割求解。
- 最终16个原创带真值样例，12回归、4新保留，6种设置，共 **96 条最终版本真实执行结果**；另保留首轮72条历史结果。新保留组在第二轮算法冻结后首次运行，没有据其调参。
- 新版调用网站实际 convertSourceToPattern；原尺寸十字为1倍，其余源图为目标网格4倍。图像解码、主体框选和浏览器绘制不包含在本数值测试内。
- 白格与前景真值由独立绘制的源掩码投影，定义与公式见 ../README.md。没有真值的实际照片没有被编造标注。
- regression-comparison.html、heldout-comparison.html 自含全部输入和输出；棋盘格是真空格，白色实块是豆；JSON/CSV 保存逐例原始计数。
- 每条时间预热后测3次中位数；源文件 SHA-256 按 UTF-8 文本 CRLF/CR→LF 规范化，最终回归组与新保留组散列一致。

原始论文依据与更完整推导见 ../README.md：alpha matting 的欠定性（Levin 等，2006）、有种子图割（Boykov–Jolly，2001）、GrabCut（Rother 等，2004）、CIELAB 色差定义，以及内容自适应降采样。论文证明与研究结果没有被移用于本站启发式算法。

实测源文件散列：

\`\`\`json
${JSON.stringify(hold.sourceHashes,null,2)}
\`\`\`
`;
await fs.writeFile(path.join(dir,'RESULTS.md'),md);
console.log(JSON.stringify({heldout:{old:b,preserve:p,edge:e},successfulRemovalCases:segmented.length,retainedBackgroundInSuccessfulCases:keptBgs,totalBackgroundInSuccessfulCases:removedBgs},null,2));
