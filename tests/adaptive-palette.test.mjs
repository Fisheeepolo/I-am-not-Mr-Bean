import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizePatternColors } from '../public/pattern-optimizer.js';
import { rgbToLab,hexToRgb } from '../public/color-utils.js';
const lab=hex=>rgbToLab(hexToRgb(hex));
const shades=Array.from({length:20},(_,i)=>({code:`R${i}`,hex:'#'+[160+i,40+Math.floor(i/3),50+Math.floor(i/3)].map(x=>x.toString(16).padStart(2,'0')).join('')}));
const subtle=Array.from({length:400},(_,i)=>lab(shades[Math.floor(i/20)].hex));
const count=r=>Object.keys(r.counts).length;
const run=(labs,palette,extra={})=>optimizePatternColors(labs,20,20,palette,{maxColors:20,optimizationMode:'balanced',...extra});

test('raising the colour ceiling does not spend it on near-identical flat shades',()=>{
 const large=Array.from({length:6400},(_,i)=>lab(shades[Math.floor(i/320)].hex));
 const render=extra=>optimizePatternColors(large,80,80,shades,{maxColors:20,optimizationMode:'balanced',...extra});
 const before=render({adaptivePalette:false});
 for(const maxColors of [8,16,20]){
  const after=render({maxColors});
  assert(count(before)>count(after));assert(count(after)<=2);assert.equal(after.cells.length,6400);
  assert(after.diagnostics.meanDeltaE2000<3);
  console.log(JSON.stringify({fixture:'subtle-red-bands',maxColors,before:count(before),after:count(after),meanDE:after.diagnostics.meanDeltaE2000}));
 }
});
test('one contrasting bead and explicit salient subtle details are not discarded by frequency',()=>{
 const palette=[...shades,{code:'eye',hex:'#111111'}];
 const input=subtle.slice();input[210]=lab('#111111');input[0]=null;
 const result=run(input,palette);assert.equal(result.cells[210],'eye');assert.equal(result.cells[0],null);assert(count(result)<=4);
 const colors=[{code:'base',hex:'#888888'},{code:'detail',hex:'#909090'}];
 const cells=Array.from({length:400},()=>lab(colors[0].hex));cells[210]=lab(colors[1].hex);
 const saliencyMap=new Float32Array(400);saliencyMap[210]=1;
 assert.equal(run(cells,colors,{saliencyMap}).cells[210],'detail');
});
test('real multi-tone gradients still receive several colours; detail mode retains exact swatches',()=>{
 const colors=Array.from({length:20},(_,i)=>({code:`G${i}`,hex:'#'+(20+i*11).toString(16).padStart(2,'0').repeat(3)}));
 const cells=Array.from({length:400},(_,i)=>lab(colors[Math.floor(i/20)].hex));
 const result=run(cells,colors);assert(count(result)>=8);assert(result.diagnostics.meanDeltaE2000<4);
 assert.equal(count(run(subtle,shades,{optimizationMode:'detail'})),20);
 console.log(JSON.stringify({fixture:'broad-grey-gradient',after:count(result),meanDE:result.diagnostics.meanDeltaE2000}));
});
test('single-colour input, absent stock and input immutability remain safe',()=>{
 const input=subtle.slice(), snapshot=structuredClone(input), palette=shades.filter((_,i)=>i%3===0);
 const a=run(input,palette),b=run(input,palette);assert.deepEqual(a,b);assert.deepEqual(input,snapshot);
 assert(a.cells.every(c=>palette.some(p=>p.code===c)));
 assert.equal(count(run(Array(400).fill(lab('#A32A34')),palette)),1);
});
