import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {generatePattern as oldGenerate, rgbToLab, hexToRgb, nearestColors} from './baseline-engine.js';
import {generatePattern} from '../public/engine.js';
import {sampleImageForPattern} from '../public/image-sampling.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const split=process.argv.find(s=>s.startsWith('--split='))?.split('=')[1]||'development';
if(!['development','heldout','all'].includes(split))throw new Error('Invalid split');
const fixtures=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8')).filter(f=>split==='all'||f.split===split);
const catalogue=JSON.parse(await fs.readFile(path.join(root,'../public/palette.json'),'utf8')).colors;
const restrictedHex=['#1C2431','#F4F0E8','#885C41','#E98A4D','#F4CD63','#DF5D73','#A34250','#469384','#3D729C','#91BDCF','#695A9B','#AAB577'];
const restricted=[...new Set(restrictedHex.map(hex=>nearestColors(hex,catalogue,1)[0].code))].map(code=>catalogue.find(c=>c.code===code));
const plans=[{id:'full-8',palette:catalogue,maxColors:8},{id:'full-16',palette:catalogue,maxColors:16},{id:'shop-8',palette:restricted,maxColors:8}];
const labDistance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const hexMap=new Map(catalogue.map(c=>[c.code,c.hex]));
const labMap=new Map(catalogue.map(c=>[c.code,rgbToLab(hexToRgb(c.hex))]));

// Explicit common sampler: exact rectangular area integration in premultiplied
// alpha. It makes the experiment independent of the browser's unspecified filter.
export function areaSample(data,sw,sh,w,h){
 const out=new Uint8ClampedArray(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const x0=x*sw/w,x1=(x+1)*sw/w,y0=y*sh/h,y1=(y+1)*sh/h;
  let area=0,a=0,r=0,g=0,b=0;
  for(let sy=Math.floor(y0);sy<Math.ceil(y1);sy++)for(let sx=Math.floor(x0);sx<Math.ceil(x1);sx++){
   const weight=(Math.min(x1,sx+1)-Math.max(x0,sx))*(Math.min(y1,sy+1)-Math.max(y0,sy));
   const p=(sy*sw+sx)*4,alpha=data[p+3]/255;area+=weight;a+=alpha*weight;
   r+=data[p]*alpha*weight;g+=data[p+1]*alpha*weight;b+=data[p+2]*alpha*weight;
  }
  const p=(y*w+x)*4;if(a){out[p]=r/a;out[p+1]=g/a;out[p+2]=b/a;}out[p+3]=255*a/area;
 }
 return {data:out,width:w,height:h};
}
function referenceLabs(data){return Array.from({length:data.length/4},(_,i)=>{let p=i*4,a=data[p+3]/255;return data[p+3]<100?null:rgbToLab([data[p],data[p+1],data[p+2]].map(v=>v*a+255*(1-a)));});}

export function measure(pattern,reference,fixture){
 const {cells,width:w,height:h}=pattern,n=cells.length;
 let error=0,errorN=0,intersection=0,union=0,transitions=0,refEdges=0,predEdges=0,trueEdges=0;
 const labs=cells.map(c=>c==null?null:labMap.get(c));
 for(let i=0;i<n;i++){
  if(reference[i]||labs[i])union++;if(reference[i]&&labs[i]){intersection++;error+=labDistance(reference[i],labs[i]);errorN++;}
  for(const j of [i%w<w-1?i+1:-1,i+w<n?i+w:-1]){
   if(j<0)continue;
   if(j===i+1&&cells[i]&&cells[j]&&cells[i]!==cells[j])transitions++;
   if(!reference[i]||!reference[j]||!labs[i]||!labs[j])continue;
   const re=labDistance(reference[i],reference[j])>=20,pe=labDistance(labs[i],labs[j])>=20;
   refEdges+=+re;predEdges+=+pe;trueEdges+=+(re&&pe);
  }
 }
 const seen=new Uint8Array(n);let smallComponents=0,smallCells=0,weakSmallCells=0;
 for(let start=0;start<n;start++){
  if(seen[start]||cells[start]==null)continue;
  const q=[start];seen[start]=1;let boundary=0,bn=0;
  for(let head=0;head<q.length;head++){
   const i=q[head],x=i%w;for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,i>=w?i-w:-1,i+w<n?i+w:-1]){
    if(j<0||cells[j]==null)continue;
    if(cells[j]===cells[start]){if(!seen[j]){seen[j]=1;q.push(j);}}
    else{boundary+=labDistance(labs[i],labs[j]);bn++;}
   }
  }
  if(q.length<=2){smallComponents++;smallCells+=q.length;if(bn&&boundary/bn<20)weakSmallCells+=q.length;}
 }
 const markers=fixture.markers||[];let markersPreserved=0;
 for(const m of markers){const lab=labs[m.y*w+m.x];if(lab&&labDistance(lab,rgbToLab(hexToRgb(m.hex)))<=15)markersPreserved++;}
 const precision=predEdges?trueEdges/predEdges:refEdges?0:1,recall=refEdges?trueEdges/refEdges:1;
 return {meanDeltaE76:errorN?error/errorN:0,edgePrecision:precision,edgeRecall:recall,edgeF1:precision+recall?2*precision*recall/(precision+recall):0,
  silhouetteIoU:union?intersection/union:1,smallComponents,smallCells,weakSmallCells,rowTransitions:transitions,
  usedColors:Object.keys(pattern.counts).length,beads:cells.filter(c=>c!=null).length,markersPreserved,markerCount:markers.length};
}

function svg(pattern){
 const {width:w,height:h,cells}=pattern;let s=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#f2f2f2"/>`;
 for(let y=0;y<h;y++){let x=0;while(x<w){const c=cells[y*w+x],start=x;while(x<w&&cells[y*w+x]===c)x++;if(c)s+=`<rect x="${start}" y="${y}" width="${x-start}" height="1" fill="${hexMap.get(c)}"/>`;}}
 return s+'</svg>';
}
const digest=async p=>crypto.createHash('sha256').update((await fs.readFile(path.join(root,p),'utf8')).replace(/\r\n?/g,'\n'),'utf8').digest('hex');
const run={timestamp:new Date().toISOString(),split,protocol:'v1-fixed-2026-10-25',node:process.version,hashNormalization:'UTF-8 source text; CRLF/CR normalized to LF',
 sourceHashes:{baseline:await digest('baseline-engine.js'),engine:await digest('../public/engine.js'),optimizer:await digest('../public/pattern-optimizer.js'),sampler:await digest('../public/image-sampling.js')},
 note:'Exact old quantizer. Common area sampler for controlled comparison; not a pixel-exact emulation of browser imageSmoothingQuality=high. 3 measured iterations after 1 warmup; median timing. Metrics are proxies, not human assembly time.',rows:[]};
const gallery=[];
for(const fixture of fixtures){
 const raw=new Uint8ClampedArray(await fs.readFile(path.join(root,fixture.source))),{sourceWidth:sw,sourceHeight:sh,width:w,height:h}=fixture;
 const area=areaSample(raw,sw,sh,w,h),reference=referenceLabs(area.data);
 const images=new Map([['source',`data:image/png;base64,${(await fs.readFile(path.join(root,fixture.png))).toString('base64')}`]]);
 for(const plan of plans){
  const methods=[{name:'baseline',stage:'common-grid',mode:null},...['detail','balanced','easy'].map(mode=>({name:`quant-${mode}`,stage:'common-grid',mode})),...['detail','balanced','easy'].map(mode=>({name:`full-${mode}`,stage:'source-to-pattern',mode}))];
  for(const method of methods){
   const execute=()=>{
    let input=method.stage==='source-to-pattern'?sampleImageForPattern({data:raw},sw,sh,w,h,{optimizationMode:method.mode}):area;
    return (method.mode?generatePattern:oldGenerate)(input,w,h,plan.palette,{maxColors:plan.maxColors,optimizationMode:method.mode,removeBackground:false});
   };
   execute();const times=[];let result;
   for(let t=0;t<3;t++){const start=performance.now();result=execute();times.push(performance.now()-start);}
   const row={fixture:fixture.id,title:fixture.title,split:fixture.split,width:w,height:h,plan:plan.id,maxColors:plan.maxColors,availableColors:plan.palette.length,method:method.name,stage:method.stage,...measure(result,reference,fixture),medianMs:times.sort((a,b)=>a-b)[1]};
   if(row.usedColors>plan.maxColors||result.cells.some(c=>c!=null&&!plan.palette.some(p=>p.code===c)))throw new Error('Palette invariant failed');
   run.rows.push(row);
   images.set(`${plan.id}:${method.name}`,`data:image/svg+xml;base64,${Buffer.from(svg(result)).toString('base64')}`);
  }
 }
 gallery.push({fixture,images});console.log(`Measured ${fixture.id}`);
}
await fs.mkdir(path.join(root,'results'),{recursive:true});
await fs.writeFile(path.join(root,`results/${split}.json`),JSON.stringify(run,null,2));
const fields=Object.keys(run.rows[0]);await fs.writeFile(path.join(root,`results/${split}.csv`),'\uFEFF'+fields.join(',')+'\n'+run.rows.map(r=>fields.map(f=>JSON.stringify(r[f])).join(',')).join('\n'));
const names={'baseline':'旧算法','quant-detail':'新选色 · 细节','quant-balanced':'新选色 · 均衡','quant-easy':'新选色 · 好拼','full-detail':'全流程 · 细节','full-balanced':'全流程 · 均衡','full-easy':'全流程 · 好拼'};
const planTitles={'full-8':'MARD 291 色 · 最多 8 色','full-16':'MARD 291 色 · 最多 16 色','shop-8':'店铺 12 色子集 · 最多 8 色'};
const sections=gallery.map(({fixture:f,images})=>`<section class="case"><h2>${f.title} · ${f.width} × ${f.height}</h2>${plans.map((plan,pi)=>{
 const rows=run.rows.filter(r=>r.fixture===f.id&&r.plan===plan.id);
 return `<details ${pi===0?'open':''}><summary>${planTitles[plan.id]}</summary><div class="grid"><div class="tile source"><b>原图</b><img src="${images.get('source')}"><small>${f.note}</small></div>${['baseline','full-detail','full-balanced','full-easy'].map(m=>{const r=rows.find(r=>r.method===m);return `<div class="tile"><b>${names[m]}</b><img src="${images.get(`${plan.id}:${m}`)}"><small>色差 ${r.meanDeltaE76.toFixed(2)} · 边缘 F1 ${r.edgeF1.toFixed(3)}<br>1–2 格碎片 ${r.smallCells} 格 · 弱小碎片 ${r.weakSmallCells} 格<br>行换色 ${r.rowTransitions} · 用色 ${r.usedColors}<br>耗时 ${r.medianMs.toFixed(1)} ms${r.markerCount?` · 特征 ${r.markersPreserved}/${r.markerCount}`:''}</small></div>`;}).join('')}</div><div class="table-wrap"><table><thead><tr><th>同网格选色对比（隔离取样影响）</th><th>平均 ΔE76 ↓</th><th>强边缘 F1 ↑</th><th>弱小碎片格 ↓</th><th>1–2 格碎片</th><th>行换色</th><th>用色</th></tr></thead><tbody>${rows.filter(r=>r.stage==='common-grid').map(r=>`<tr><td>${names[r.method]}</td><td>${r.meanDeltaE76.toFixed(2)}</td><td>${r.edgeF1.toFixed(3)}</td><td>${r.weakSmallCells}</td><td>${r.smallCells}</td><td>${r.rowTransitions}</td><td>${r.usedColors}</td></tr>`).join('')}</tbody></table></div></details>`;
 }).join('')}</section>`).join('');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>非 AI 图纸算法实验对比</title><style>body{font:15px system-ui;margin:32px;background:#faf9fc;color:#30273a}h1{font-size:26px}p{max-width:1100px;line-height:1.6}.case{margin:30px 0;padding:20px;background:white;border:1px solid #e3dce9;border-radius:16px}.grid{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:16px}.tile img{width:100%;height:230px;object-fit:contain;background:#f2f2f2;image-rendering:pixelated}.source img{image-rendering:auto}.tile b{display:block;margin:9px 0}.tile small{display:block;line-height:1.6;color:#74667d}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;margin-top:20px}td,th{border-bottom:1px solid #eee;padding:7px;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}footer{margin:40px 0;font-size:13px;color:#74667d}details{margin:20px 0}summary{padding:12px;background:#f4effa;cursor:pointer;border-radius:8px;font-weight:bold}@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}body{margin:16px}}</style><h1>非 AI 拼豆算法：${split==='development'?'开发组':split==='heldout'?'保留评估组':'全部样例'}</h1><p>每张图片比较同尺寸、同可用色卡、同颜色预算下的旧量化器与新算法三档。展开每张图下的栏目可查看 MARD 最多 8 色、16 色及店铺 12 色子集。下方显示全部样例，包括改善与退步。</p><p><strong>实验方法：</strong>旧量化器原样保留自部署提交 d92334a。基线统一使用 alpha 预乘的精确面积平均取样；它不是浏览器旧滤镜的逐像素复刻。全流程图包括新取样与新选色；表格固定相同网格输入，只比较选色和空间整理。每个方法预热 1 次后测量 3 次，记录中位耗时，未包含浏览器绘制和解码。</p><details><summary>如何读这些指标</summary><p><strong>平均 ΔE76：</strong>与面积平均参考的 Lab 色差，越小越接近参考，但参考可能模糊细线。<strong>强边缘 F1：</strong>邻接颜色差 ≥20 的边在同一位置的精确率/召回率调和均值，越大越接近参考。<strong>1–2 格碎片：</strong>同色四连通区域面积 1–2 格的总格数，包含有用的眼睛，不能一概越少越好。<strong>弱小碎片：</strong>这些碎片与周围的平均色差小于20。<strong>行换色：</strong>横向相邻非空格换色次数，只是操作复杂度代理。<strong>特征：</strong>合成图指定眼睛位置与期望黑色的色差 ≤15。上述指标都不是人类辨认度或实际拼装工时。</p><p>7 张开发图用于选择参数；5 张保留图仅在参数冻结后运行。完整精度、召回率、透明轮廓交并比、原始数据与代码 SHA-256 见同目录 JSON/CSV。照片没有语义标注，无法自动评价真实面部特征的识别程度。</p></details>${sections}<footer>实验协议 v1 · ${run.timestamp}<br>照片来自 <a href="https://scikit-image.org/docs/stable/api/skimage.data">scikit-image 官方样例</a>；NASA / SpaceX 公共领域；Chelsea: Stefan van der Walt, CC0。合成图为本项目程序生成，无生成式 AI。<br>方法参考：<a href="https://johanneskopf.de/publications/downscaling/">Content-Adaptive Image Downscaling</a>、<a href="https://cragl.cs.gmu.edu/pixelate/">Pixelated Image Abstraction</a>，本站实现不等同于这些论文的复现。</footer></html>`;
await fs.writeFile(path.join(root,`results/${split}-comparison.html`),html);
console.log(`Saved ${run.rows.length} measurements for ${fixtures.length} fixtures.`);
