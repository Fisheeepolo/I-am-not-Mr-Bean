import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {generatePattern as baseline} from './baseline-v2-engine.js';
import {sampleImageForPattern} from '../../public/image-sampling.js';
import {convertSourceToPattern} from '../../public/pattern-pipeline.js';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const split=process.argv.find(v=>v.startsWith('--split='))?.split('=')[1]||'regression';
if(!['regression','heldout'].includes(split))throw new Error('Use regression or heldout');
const fixtures=JSON.parse(await fs.readFile(path.join(ROOT,'fixtures.json'),'utf8')).filter(f=>f.split===split);
const palette=JSON.parse(await fs.readFile(path.join(ROOT,'../../public/palette.json'),'utf8')).colors;
const colorMap=new Map(palette.map(c=>[c.code,c.hex]));
const methods=[{id:'v2-20',title:'旧版 · 容差20',old:true,tolerance:20},{id:'v2-60',title:'旧版 · 容差60',old:true,tolerance:60},
 {id:'v3-preserve',title:'新版 · 保留全部',remove:false,tolerance:20},{id:'v3-edge-5',title:'新版去底 · 容差5',remove:true,tolerance:5},
 {id:'v3-edge-20',title:'新版去底 · 容差20',remove:true,tolerance:20},{id:'v3-edge-60',title:'新版去底 · 容差60',remove:true,tolerance:60}];
const digest=async p=>crypto.createHash('sha256').update((await fs.readFile(path.join(ROOT,p),'utf8')).replace(/\r\n?/g,'\n')).digest('hex');
const sourceHashes={};for(const p of ['baseline-v2-engine.js','../../public/pattern-pipeline.js','../../public/background-segmentation.js','../../public/image-sampling.js','../../public/engine.js','../../public/pattern-optimizer.js','../../public/color-utils.js','fixtures.json'])sourceHashes[p]=await digest(p);
const run={protocol:'white-mask-v2-2026-10-26',split,timestamp:new Date().toISOString(),node:process.version,
 hashNormalization:'UTF-8 text; CRLF/CR normalized to LF',sourceHashes,
 notes:'Round 2: 12 previously inspected original synthetic regression fixtures plus 4 newly fixed heldout fixtures. Initial heldout was reclassified after an independent native-grid integration test found boundary halos. New methods call the actual website pure pipeline. Identical all-white RGBA with two different masks is an explicit impossibility control.',rows:[]};

function targetTruth(f,raw,mask){
 const fg=new Uint8Array(f.width*f.height),white=new Uint8Array(f.width*f.height),sx=f.sourceWidth/f.width,sy=f.sourceHeight/f.height;
 if(!Number.isInteger(sx)||!Number.isInteger(sy))throw new Error('Ground-truth projection expects integer source scale');
 for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++){
  let coverage=0,whiteCoverage=0;
  for(let yy=y*sy;yy<(y+1)*sy;yy++)for(let xx=x*sx;xx<(x+1)*sx;xx++){
   const i=yy*f.sourceWidth+xx,p=i*4,m=mask[i]/255;
   coverage+=m;
   if(Math.min(raw[p],raw[p+1],raw[p+2])>=230&&Math.max(raw[p],raw[p+1],raw[p+2])-Math.min(raw[p],raw[p+1],raw[p+2])<=20)whiteCoverage+=m;
  }
  const at=y*f.width+x;fg[at]=+(coverage/(sx*sy)>=100/255);white[at]=+(whiteCoverage/(sx*sy)>=100/255&&fg[at]);
 }
 return{fg,white};
}
function measure(cells,truth){
 let foreground=0,whiteForeground=0,background=0,deletedForeground=0,deletedWhite=0,retainedBackground=0,retained=0;
 for(let i=0;i<cells.length;i++){
  const keep=cells[i]!=null;retained+=+keep;
  if(truth.fg[i]){foreground++;if(!keep)deletedForeground++;}else{background++;if(keep)retainedBackground++;}
  if(truth.white[i]){whiteForeground++;if(!keep)deletedWhite++;}
 }
 return {foreground,whiteForeground,background,deletedForeground,deletedWhite,retainedBackground,retained,
  foregroundDeletionRate:foreground?deletedForeground/foreground:null,whiteDeletionRate:whiteForeground?deletedWhite/whiteForeground:null,
  backgroundRetentionRate:background?retainedBackground/background:null,foregroundIoU:(foreground+retainedBackground)?(foreground-deletedForeground)/(foreground+retainedBackground):1};
}
function renderSvg(cells,w,h,mask=false){
 let s=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><defs><pattern id="checker" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#c8c0d0"/><path d="M0 0h2v2H0zm2 2h2v2H2z" fill="#ebe7ef"/></pattern></defs><rect width="100%" height="100%" fill="url(#checker)"/>`;
 for(let y=0;y<h;y++){let x=0;while(x<w){const c=cells[y*w+x],start=x;while(x<w&&cells[y*w+x]===c)x++;if(c!=null)s+=`<rect x="${start}" y="${y}" width="${x-start}" height="1" fill="${mask?'#255C46':colorMap.get(c)}"/>`;}}
 return s+'</svg>';
}
const dataUri=svg=>'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
const gallery=[];
for(const f of fixtures){
 const raw=new Uint8ClampedArray(await fs.readFile(path.join(ROOT,f.source))),mask=new Uint8Array(await fs.readFile(path.join(ROOT,f.mask))),truth=targetTruth(f,raw,mask);
 const images={source:'data:image/png;base64,'+(await fs.readFile(path.join(ROOT,f.png))).toString('base64'),truth:dataUri(renderSvg([...truth.fg].map(v=>v?'mask':null),f.width,f.height,true))};
 for(const method of methods){
  const execute=()=>method.old?baseline(sampleImageForPattern({data:raw},f.sourceWidth,f.sourceHeight,f.width,f.height,{optimizationMode:'balanced'}),f.width,f.height,palette,{maxColors:16,optimizationMode:'balanced',removeBackground:true,backgroundTolerance:method.tolerance}):
   convertSourceToPattern({data:raw},f.sourceWidth,f.sourceHeight,f.width,f.height,palette,{maxColors:16,optimizationMode:'balanced',imageStyle:'original',removeBackground:method.remove,backgroundTolerance:method.tolerance});
  execute();let pattern,times=[];for(let i=0;i<3;i++){let t=performance.now();pattern=execute();times.push(performance.now()-t);}
  run.rows.push({fixture:f.id,title:f.title,split:f.split,ambiguous:f.ambiguous,width:f.width,height:f.height,method:method.id,...measure(pattern.cells,truth),medianMs:times.sort((a,b)=>a-b)[1],backgroundDiagnostics:pattern.backgroundDiagnostics??null});
  images[method.id]=dataUri(renderSvg(pattern.cells,f.width,f.height));
 }
 gallery.push({fixture:f,images});console.log('Measured '+f.id);
}
await fs.mkdir(path.join(ROOT,'results'),{recursive:true});await fs.writeFile(path.join(ROOT,`results/${split}.json`),JSON.stringify(run,null,2));
const fields=Object.keys(run.rows[0]).filter(k=>k!=='backgroundDiagnostics');await fs.writeFile(path.join(ROOT,`results/${split}.csv`),'\uFEFF'+fields.join(',')+'\n'+run.rows.map(r=>fields.map(k=>JSON.stringify(r[k])).join(',')).join('\n'));
const pct=v=>v==null?'—':(v*100).toFixed(2)+'%';
const figures=gallery.map(({fixture:f,images})=>`<section><h2>${f.title}${f.ambiguous?' <em>意图歧义对照</em>':''}</h2><p>${f.note}</p><div class="grid">${[{id:'source',title:'原图'},{id:'truth',title:'独立标注：需要豆的位置'},...methods.filter(m=>['v2-20','v3-preserve','v3-edge-20'].includes(m.id))].map(m=>{const r=run.rows.find(r=>r.fixture===f.id&&r.method===m.id);return `<article><h3>${m.title}</h3><img alt="${f.title} ${m.title}" src="${images[m.id]}">${r?`<p>白色误删 ${r.deletedWhite}/${r.whiteForeground}（${pct(r.whiteDeletionRate)}）<br>全部前景误删 ${pct(r.foregroundDeletionRate)}<br>背景残留 ${pct(r.backgroundRetentionRate)}</p>`:''}</article>`;}).join('')}</div><div class="scroll"><table><thead><tr><th>方法</th><th>白色前景误删</th><th>全部前景误删</th><th>背景残留</th><th>前景IoU</th><th>保留豆数</th><th>状态</th></tr></thead><tbody>${run.rows.filter(r=>r.fixture===f.id).map(r=>`<tr><td>${methods.find(m=>m.id===r.method).title}</td><td>${pct(r.whiteDeletionRate)}</td><td>${pct(r.foregroundDeletionRate)}</td><td>${pct(r.backgroundRetentionRate)}</td><td>${r.foregroundIoU.toFixed(3)}</td><td>${r.retained}</td><td>${r.backgroundDiagnostics?.reason??r.backgroundDiagnostics?.status??''}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>白色主体保护专项实验</title><style>body{font:15px system-ui;background:#faf9fc;color:#30273a;margin:28px}p{line-height:1.65}.intro{max-width:1120px}.grid{display:grid;grid-template-columns:repeat(5,minmax(140px,1fr));gap:16px}section{padding:20px;border:1px solid #ded5e6;border-radius:12px;background:white;margin:24px 0}img{width:100%;height:210px;object-fit:contain;image-rendering:pixelated;background:conic-gradient(#c8c0d0 25%,#ebe7ef 0 50%,#c8c0d0 0 75%,#ebe7ef 0) 0 0/16px 16px}h3{font-size:16px}h2{font-size:21px}em{font-size:14px;color:#9d5d32}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}td,th{text-align:right;padding:8px;border-bottom:1px solid #eee}td:first-child,th:first-child{text-align:left}article p{font-size:13px}footer{font-size:13px;color:#7b6b84}@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}body{margin:12px}}</style><h1>白色主体保护 · ${split==='heldout'?'第二轮新保留组':'已看样例回归组'}</h1><div class="intro"><p>棋盘格表示空格，白色实块仍是一颗豆。原图与需要豆的位置分开绘制，评价包括误删前景和残留背景，避免把“全部不删除”误称为去底成功。</p><p>旧版：先降至图纸尺寸，再按两角共识和 Lab 色差从边缘泛洪。新版：调用网站同一纯函数，先在源分辨率处理背景，再取样、量化。关闭去底的默认模式保留不透明像素；主动去底模式遇到证据不足可保守保留。</p><p>第二轮为已看12例回归组与4例新保留组；首轮7开发/5保留结果已归档，随后因独立9×9集成测试发现晕边而修复，原保留组不再作为独立证明。全部为原始程序绘制，不使用 AI。两个相同纯白输入对应不同标注，是“图像本身不足以推断用户意图”的不可辨识对照，不作为能被自动正确解决的任务。仅适用于本组测试，不代表真实照片全部情况。</p></div>${figures}<footer>协议 white-mask-v1 · ${run.timestamp} · 结果为真实执行输出。完整诊断、指标、代码与数据散列见同目录 JSON。具体数学模型和论文依据见研究说明。</footer></html>`;
await fs.writeFile(path.join(ROOT,`results/${split}-comparison.html`),html);console.log(`Saved ${run.rows.length} actual measurements.`);
