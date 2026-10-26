import fs from 'node:fs/promises';
import {convertSourceToPattern} from '../../public/pattern-pipeline.js';
const base=new URL('../content-aware-v4/',import.meta.url);
const fixtures=JSON.parse(await fs.readFile(new URL('fixtures.json',base),'utf8')).filter(f=>f.split==='development');
const palette=JSON.parse(await fs.readFile(new URL('../../public/palette.json',import.meta.url),'utf8')).colors;
const rows=[];
for(const f of fixtures){
 const data=new Uint8ClampedArray(await fs.readFile(new URL(f.source,base)));
 for(const maxColors of [16,20]){
  const results=[false,true].map(adaptivePalette=>convertSourceToPattern({data},f.sourceWidth,f.sourceHeight,f.width,f.height,palette,{maxColors,optimizationMode:'balanced',removeBackground:false,adaptivePalette}));
  const [before,after]=results;
  if(before.cells.some((c,i)=>(c===null)!==(after.cells[i]===null)))throw Error('Occupancy changed');
  const row={fixture:f.id,maxColors,beforeColors:Object.keys(before.counts).length,afterColors:Object.keys(after.counts).length,beforeDE:before.diagnostics.meanDeltaE2000,afterDE:after.diagnostics.meanDeltaE2000};
  rows.push(row);console.log(JSON.stringify(row));
 }
}
await fs.writeFile(new URL('development-results.json',import.meta.url),JSON.stringify(rows,null,2)+'\n');
