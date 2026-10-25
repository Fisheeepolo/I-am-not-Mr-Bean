import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePattern,countCells} from '../public/engine.js';
const palette=[{code:'INK',hex:'#151515'},{code:'PAPER',hex:'#FFFFFF'},{code:'RED',hex:'#D52E36'},{code:'CREAM',hex:'#FFE4A8'}];
const image=(w,h,at)=>({data:Uint8ClampedArray.from(Array.from({length:w*h},(_,i)=>at(i%w,Math.floor(i/w))).flat())});

test('background removal keeps enclosed whites and foreground across optimization modes',()=>{
 const input=image(9,9,(x,y)=>x===2&&y>=2&&y<=6||x===6&&y>=2&&y<=6||y===2&&x>=2&&x<=6||y===6&&x>=2&&x<=6?[21,21,21,255]:[255,255,255,255]);
 for(const optimizationMode of ['detail','balanced','easy']){
  const result=generatePattern(input,9,9,palette,{maxColors:2,removeBackground:true,backgroundTolerance:5,optimizationMode});
  assert.equal(result.cells[0],null);assert.equal(result.cells[4*9+4],'PAPER');assert.equal(result.cells[2*9+4],'INK');
  assert.equal(result.cells.filter(c=>c!==null).length,25);
 }
});

test('available colour, cardinality, transparency and count invariants across deterministic inputs',()=>{
 for(let seed=1;seed<=8;seed++){
  let state=seed;const rnd=()=>((state=Math.imul(state,1664525)+1013904223>>>0)>>>24);
  const input=image(17,13,()=>[rnd(),rnd(),rnd(),rnd()%5===0?0:255]);
  for(const optimizationMode of ['detail','balanced','easy'])for(const maxColors of [1,2,4]){
   const result=generatePattern(input,17,13,palette,{maxColors,optimizationMode});
   assert.equal(result.cells.length,221);assert.ok(Object.keys(result.counts).length<=maxColors);
   assert.deepEqual(result.counts,countCells(result.cells));
   for(let i=0;i<221;i++){assert.equal(result.cells[i]===null,input.data[i*4+3]===0);if(result.cells[i])assert.ok(palette.some(c=>c.code===result.cells[i]));}
   assert.deepEqual(result,generatePattern(input,17,13,palette,{maxColors,optimizationMode}));
  }
 }
});

test('empty and one-colour inputs are safe; invalid input cannot become a saved pattern',()=>{
 const empty=generatePattern(image(8,8,()=>[231,48,67,0]),8,8,palette);
 assert.deepEqual(empty.counts,{});assert.ok(empty.cells.every(c=>c===null));
 const red=generatePattern(image(8,8,()=>[213,46,54,255]),8,8,[palette[2]],{maxColors:64});
 assert.deepEqual(red.counts,{RED:64});
 assert.throws(()=>generatePattern({data:new Uint8Array(4)},8,8,palette));
 assert.throws(()=>generatePattern(image(8,8,()=>[0,0,0,255]),8,8,[]));
});
