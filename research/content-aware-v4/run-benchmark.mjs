import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {verifyLock} from './lock-protocol.mjs';
import {convertSourceToPattern as baseline} from './baseline/pattern-pipeline.js';
import {convertSourceToPattern as current} from '../../public/pattern-pipeline.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const split=process.argv.find(x=>x.startsWith('--split='))?.split('=')[1]??'development';
if(!['development','heldout','white-regression'].includes(split))throw new Error('Invalid split');
const protocolLock=await verifyLock();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function graph(file,out={}){
 const text=await fs.readFile(file,'utf8'),key=path.relative(root,file).replaceAll('\\','/');if(key in out)return out;
 out[key]=sha(text.replace(/\r\n?/g,'\n'));
 for(const m of text.matchAll(/(?:from|import)\s*['"](\.\/[^'"]+)['"]/g))await graph(path.resolve(path.dirname(file),m[1]),out);
 return out;
}
const sourceHashes=await graph(path.join(root,'../../public/pattern-pipeline.js'));await graph(path.join(root,'baseline/pattern-pipeline.js'),sourceHashes);
const palette=JSON.parse(await fs.readFile(path.join(root,'../../public/palette.json'),'utf8')).colors;
const available=new Set(palette.map(p=>p.code));
const methods=[{id:'v3',run:baseline,options:{}},{id:'full',run:current,options:{}},
 {id:'noSaliency',run:current,options:{saliencySampling:false}},{id:'noAbstraction',run:current,options:{abstraction:false}},
 {id:'noDefocus',run:current,options:{defocusAware:false}},
 {id:'noSpatial',run:current,options:{spatialRegularization:false}},{id:'noIslands',run:current,options:{islandPenalty:false}},
 {id:'noMicroProtection',run:current,options:{microProtection:false}},
 {id:'lab76',run:current,options:{colorMetric:'lab76'}}];
const white=split==='white-regression';
const fixtures=JSON.parse(await fs.readFile(path.join(root,white?'../white-preservation/fixtures.json':'fixtures.json'),'utf8')).filter(f=>white||f.split===split);
const run={protocol:protocolLock.protocol,startedAt:new Date().toISOString(),node:process.version,split,sourceHashes,
 protocolLockHash:sha(await fs.readFile(path.join(root,'protocol-lock.json'))),paletteHash:sha(JSON.stringify(palette)),palette,rows:[]};
for(const fixture of fixtures){
 const raw=new Uint8ClampedArray(await fs.readFile(path.join(root,white?'../white-preservation':'',fixture.source)));
 const plans=white?[{maxColors:18,removeBackground:false},{maxColors:18,removeBackground:true}]:[12,18,24].map(maxColors=>({maxColors,removeBackground:false}));
 for(const plan of plans){
  let expectedCells;
  for(const method of methods.filter(m=>!white&&plan.maxColors===18||['v3','full'].includes(m.id))){
   const options={optimizationMode:'balanced',imageStyle:'original',backgroundTolerance:20,...plan,...method.options};
   const execute=()=>method.run({data:raw},fixture.sourceWidth,fixture.sourceHeight,fixture.width,fixture.height,palette,options);
   execute();let pattern;const times=[];
   for(let i=0;i<3;i++){const start=performance.now();pattern=execute();times.push(performance.now()-start);}
   const used=new Set(pattern.cells.filter(c=>c!=null));if(used.size>plan.maxColors||[...used].some(c=>!available.has(c)))throw new Error('Hard palette budget violated');
   if(method.id==='v3')expectedCells=pattern.cells;
   const occupancyMismatchVsV3=pattern.cells.reduce((n,c,i)=>n+Number((c==null)!==(expectedCells[i]==null)),0);
   if(occupancyMismatchVsV3)throw new Error('Occupancy regression: '+fixture.id+' '+method.id);
   run.rows.push({fixture:fixture.id,split:fixture.split,kind:fixture.kind??'white-synthetic-regression',method:method.id,...plan,
    width:fixture.width,height:fixture.height,usedColors:used.size,timesMs:times,medianMs:[...times].sort((a,b)=>a-b)[1],occupancyMismatchVsV3,
    cells:pattern.cells,diagnostics:pattern.diagnostics??null,backgroundDiagnostics:pattern.backgroundDiagnostics??null,abstractionDiagnostics:pattern.abstractionDiagnostics??null});
  }
 }
 console.log('Measured '+fixture.id+' ('+run.rows.length+' rows)');
}
await verifyLock();const finalHashes=await graph(path.join(root,'../../public/pattern-pipeline.js'));await graph(path.join(root,'baseline/pattern-pipeline.js'),finalHashes);
if(JSON.stringify(sourceHashes)!==JSON.stringify(finalHashes))throw new Error('Algorithm source changed during run');
run.finishedAt=new Date().toISOString();await fs.mkdir(path.join(root,'results'),{recursive:true});
await fs.writeFile(path.join(root,'results',split+'-raw.json'),JSON.stringify(run,null,2)+'\n');console.log('Saved '+run.rows.length+' actual measurements.');
