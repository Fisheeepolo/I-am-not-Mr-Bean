import {convertSourceToPattern} from './pattern-pipeline.js';
import {createSubjectEditor} from './subject-editor.js';
import { generatePattern, makeDemo, nearestColors, countCells, replaceColor, hexToRgb } from './engine.js';
import { parsePalette } from './palette-import.js';
import { openLibrary, listProjects, getProject, saveProject as storeProject, renameProject, deleteProject, normalizeProjectName, newProjectId } from './library-store.js';
import { installAI } from './ai-workflow.js';
import { createPatternRenderer, drawBeadGrid } from './pattern-renderer.js';
import { estimatePatternEffort, getPatternBounds } from './pattern-effort.js';
import { listBeadingSessions, getBeadingSession, createBeadingSession, findPendingSession, createSessionTimer } from './beading-sessions.js';

import { createHostStudio } from './host-studio.js';
import { createDifficultyExamples, matchesLibraryFilters } from './difficulty-examples.js';
import { applyImageStyle } from './image-styles.js';

const $ = id => document.getElementById(id);
 const canvas = $('patternCanvas');
const patternRenderer = createPatternRenderer(canvas, $('canvasArea'), $('canvasStage'));
let hoverFrame=null, indexedCells=null, colorIndex=new Map();
const STORAGE_KEY = 'bead-studio-project-v1';
const INITIALIZED_KEY = 'bead-studio-library-initialized';
let palettes = {}, paletteId = 'mard', activePalette = [], pattern = null;
let imageSource = null, sourceName = '', projectName = '小狐狸的午后', isDemo = true;
let selected = -1, hovered = -1, highlighted = null, done = new Set(), exclusions = {};
let cellSize = 10, fitSize = 10, ruler = 23, view = 'grid', undoStack = [], saveTimer;
let customPalettes = {}, basePalette, autoSaveAvailable = true;
let libraryReady=false, libraryEntries=[], currentProjectId=null, currentCreatedAt=null;
let sourceBlob=null, savedSourceBlob=null, savedSourceName='', pendingImport=false;
let appliedSettings=null, parametersDirty=false, suppressSaving=true, screen='library';
let writeQueue=Promise.resolve(), openingProject=false, generationPromise=null, loadingImage=false;
let originalBlob=null, originalName='', savedOriginalBlob=null, savedOriginalName='';
let aiEdited=false, savedAiEdited=false, sourceRevision=0, activeDraft=true, libraryMutation=false;
let sourceTask=0;
let libraryFilters={levels:[],time:'all'},difficultyExamples=[],hostReturnScreen='library';
let sessionTimer=null,sessionView=false,sessionBusy=false,recordEntries=[],recordRequest=0;
const subjectEditor=createSubjectEditor({container:$('subjectEditor'),onChange:()=>{syncRatio('width');markParametersDirty();}});

const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paletteMap = () => new Map(activePalette.map(c => [c.code, c]));
const availablePalette = () => activePalette.filter(c => !(exclusions[paletteId] || []).includes(c.code));
const counts = () => countCells(pattern.cells);
const total = () => pattern.cells.reduce((n,c) => n + (c !== null ? 1 : 0), 0);
function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.remove('visible'), 3500); }
function modal(title, body, eyebrow = 'BEAD STUDIO') { $('modalTitle').textContent = title; $('modalEyebrow').textContent = eyebrow; $('modalBody').innerHTML = body; if (!$('modal').open) $('modal').showModal(); }
function closeModal() { $('modal').close(); }
$('closeModal').onclick = closeModal;
$('modal').addEventListener('click', e => { if (e.target === $('modal')) { const r = $('modal').getBoundingClientRect(); if(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeModal(); } });
function setPalette(id) { paletteId = id; activePalette = palettes[id].colors; $('paletteSelect').value = id; updateAvailable(); }
function updateAvailable() { $('availableInfo').textContent = `${availablePalette().length} / ${activePalette.length} 色可用`; }
function syncPaletteOptions() { $('paletteSelect').innerHTML = Object.entries(palettes).map(([id,p]) => `<option value="${escapeHTML(id)}">${escapeHTML(p.name)}</option>`).join(''); $('paletteSelect').value = paletteId; }
function snapshot() { return { pattern: structuredClone(pattern), done: [...done], paletteId, customPalettes: structuredClone(customPalettes), projectName, isDemo, settings:structuredClone(appliedSettings), sourceBlob:savedSourceBlob, sourceName:savedSourceName, originalBlob:savedOriginalBlob, originalName:savedOriginalName, aiEdited:savedAiEdited }; }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 15) undoStack.shift(); $('undoBtn').disabled = false; }
function readSettings(){return {...subjectEditor.getState(),optimizationMode:$('optimizationMode').value,imageStyle:$('imageStyle').value,shopId:$('buyerShop').value,width:+$('gridWidth').value,height:+$('gridHeight').value,maxColors:+$('maxColors').value,keepRatio:$('keepRatio').checked,removeBackground:$('removeBackground').checked,backgroundTolerance:+$('tolerance').value};}
function applySettings(settings){
 const value=settings||{};subjectEditor.setState({subjectMode:value.subjectMode||'whole',subjectRegion:value.subjectRegion});
 $('optimizationMode').value=['detail','balanced','easy'].includes(value.optimizationMode)?value.optimizationMode:'balanced';
 $('imageStyle').value=['original','clean','vivid'].includes(value.imageStyle)?value.imageStyle:'original';syncBuyerShops(value.shopId||'');
 const clamp=(n,min,max,fallback)=>Number.isFinite(+n)?Math.max(min,Math.min(max,Math.round(+n))):fallback;
 setDimensionInputs(clamp(value.width,8,160,pattern.width),clamp(value.height,8,160,pattern.height));
 $('maxColors').value=clamp(value.maxColors,2,64,16);$('maxColorsValue').textContent=$('maxColors').value;
 $('keepRatio').checked=value.keepRatio!==false;$('removeBackground').checked=value.removeBackground===true;
 $('tolerance').value=clamp(value.backgroundTolerance,5,60,20);$('toleranceValue').textContent=$('tolerance').value;
}
function settingsDiffer(){const current=readSettings();return Object.keys(current).some(key=>current[key]!==appliedSettings?.[key]);}
function markParametersDirty(){if(suppressSaving)return;parametersDirty=true;setSaveStatus(pendingImport?'新图片待生成':'参数已调整 · 保存时应用');}
function setSaveStatus(text){$('saveState').textContent=text;if($('focusSaveStatus'))$('focusSaveStatus').textContent=text;}
function beginSourceTask(message){const task=++sourceTask;loadingImage=true;openingProject=false;setSaveStatus(message);updateSourceControls();return task;}
function finishSourceTask(task){if(task!==sourceTask)return;loadingImage=false;openingProject=false;updateSourceControls();}
function saveSoon(){if(sessionView){if(!suppressSaving&&!sessionReadOnly())sessionTimer?.setDone([...done]).catch(sessionError);return;}if(suppressSaving||!libraryReady||pendingImport||libraryMutation||!activeDraft)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>persistCurrent().catch(()=>{}),350);}
function serializable() { return { format:'bead-studio', version:1, algorithm:pattern.algorithm||'legacy', width:pattern.width, height:pattern.height, cells:pattern.cells, palette: {name:palettes[paletteId].name, colors:activePalette}, paletteId, customPalettes, projectName, isDemo, aiEdited:savedAiEdited, done:[...done], exclusions, settings:appliedSettings||readSettings(), savedAt:new Date().toISOString() }; }
function createThumbnail(data=serializable()){
 const size=320,c=document.createElement('canvas');c.width=size;c.height=size;const g=c.getContext('2d');g.fillStyle='#faf8fc';g.fillRect(0,0,size,size);
 const bounds=getPatternBounds(data);if(!bounds)return c.toDataURL('image/png');
 const unit=Math.min((size-22)/bounds.width,(size-22)/bounds.height),left=(size-bounds.width*unit)/2,top=(size-bounds.height*unit)/2;
 const map=new Map(data.palette.colors.map(color=>[color.code,color]));
 data.cells.forEach((code,i)=>{if(code!==null){g.fillStyle=map.get(code)?.hex||'#aaa';g.fillRect(left+(i%data.width-bounds.minX)*unit,top+(Math.floor(i/data.width)-bounds.minY)*unit,unit+.1,unit+.1);}});return c.toDataURL('image/png');
}
function persistCurrent(notify=false){
 clearTimeout(saveTimer);
 if(sessionView){if(suppressSaving||sessionReadOnly())return Promise.resolve(false);return sessionTimer.setDone([...done]).then(()=>sessionTimer.flush()).then(()=>true);}
 if(suppressSaving||!pattern||libraryMutation||!activeDraft)return Promise.resolve(false);
 if(!libraryReady){setSaveStatus('仓库不可用 · 请导出备份');if(notify)toast('当前浏览器无法保存仓库，请先导出图纸备份。');return Promise.reject(new Error('仓库不可用'));}
 if(pendingImport){if(notify)toast('请先生成新图片的图纸。');return Promise.resolve(false);}
 if(!currentProjectId){currentProjectId=newProjectId();currentCreatedAt=new Date().toISOString();}
 const record={id:currentProjectId,name:projectName,createdAt:currentCreatedAt,updatedAt:new Date().toISOString(),project:structuredClone(serializable()),sourceBlob:savedSourceBlob,sourceName:savedSourceName,originalBlob:savedOriginalBlob,originalName:savedOriginalName,thumbnail:createThumbnail()};
 setSaveStatus('正在保存到仓库…');
 const operation=writeQueue.catch(()=>{}).then(()=>storeProject(record)).then(summary=>{
  libraryEntries=libraryEntries.filter(p=>p.id!==summary.id);libraryEntries.push(summary);
  if(currentProjectId===record.id){setSaveStatus(parametersDirty?'参数已调整 · 保存时应用':'已保存到本机仓库');try{localStorage.setItem(STORAGE_KEY,JSON.stringify({...record.project,libraryId:record.id}));localStorage.setItem(INITIALIZED_KEY,'1');}catch{}}
  if(screen==='library')renderLibrary();if(notify)toast('图纸、原图、参数与进度已保存到仓库。');return true;
 }).catch(error=>{if(error.code==='PROJECT_DELETED'){activeDraft=false;clearBackup(record.id);setSaveStatus('图纸已被删除');}else setSaveStatus('保存失败 · 请重试或导出');if($('libraryStatus'))$('libraryStatus').textContent='保存失败：'+error.message;toast('保存失败：'+error.message);throw error;});
 writeQueue=operation;return operation;
}
function saveLocal(){return persistCurrent().catch(()=>false);}
function validateProject(data) { if(data.format !== 'bead-studio' || data.version !== 1) throw new Error('这不是豆豆工坊图纸文件。'); if(!Number.isInteger(data.width)||!Number.isInteger(data.height)||data.width<8||data.height<8||data.width>160||data.height>160) throw new Error('图纸宽高须为 8–160。'); if(!Array.isArray(data.cells)||data.cells.length !== data.width*data.height) throw new Error('图纸格子数量与尺寸不一致。'); const p=parsePalette(JSON.stringify(data.palette),'palette.json'); const codes=new Set(p.colors.map(c=>c.code)); if(data.cells.some(c=>c !== null && (typeof c!=='string'||!codes.has(c)))) throw new Error('图纸中有未定义的色号。'); if(data.done && (!Array.isArray(data.done)||data.done.some(i=>!Number.isInteger(i)||i<0||i>=data.cells.length||data.cells[i]===null))) throw new Error('已拼进度数据无效。'); return p; }
function restoreProject(data) {
 const p=validateProject(data);
 // Restore the catalogue first. The palette embedded in the actual drawing is
 // authoritative and must never be overwritten by a historical catalogue entry.
 if(data.customPalettes && typeof data.customPalettes==='object') for(const [key,value] of Object.entries(data.customPalettes).slice(0,10)) {
  if(/^custom-[a-z0-9-]+$/.test(key)) try { const safe=parsePalette(JSON.stringify(value),'palette.json'); customPalettes[key]=safe; palettes[key]=safe; } catch {}
 }
 let id=typeof data.paletteId==='string'?data.paletteId:'';
 const existing=Object.hasOwn(palettes,id)?palettes[id]:null;
 const matches=existing && JSON.stringify(existing.colors.map(c=>[c.code,c.hex]))===JSON.stringify(p.colors.map(c=>[c.code,c.hex]));
 if(/^custom-[a-z0-9-]+$/.test(id)) { customPalettes[id]=p; palettes[id]=p; }
 else if(!matches) {
  const root='custom-restored-'+Date.now().toString(36); id=root; let suffix=1;
  while(Object.hasOwn(palettes,id)) id=root+'-'+suffix++;
  customPalettes[id]=p; palettes[id]=p;
 }
 syncPaletteOptions(); setPalette(id); pattern={width:data.width,height:data.height,cells:[...data.cells],algorithm:['local-structure-v2','local-structure-v3'].includes(data.algorithm)?data.algorithm:'legacy'}; projectName=String(data.projectName||'我的拼豆图纸').slice(0,80); isDemo=!!data.isDemo; done=new Set(data.done||[]); exclusions={};
 if(data.exclusions && typeof data.exclusions==='object') for(const [key,value] of Object.entries(data.exclusions)) {
  const restoredKey=key===data.paletteId?id:key;
  if(Object.hasOwn(palettes,restoredKey) && Array.isArray(value)) exclusions[restoredKey]=value.filter(c=>palettes[restoredKey].colors.some(p=>p.code===c));
 }
 updateAvailable(); if(imageSource?.src?.startsWith('blob:'))URL.revokeObjectURL(imageSource.src);imageSource=null;subjectEditor.setImage(null); sourceName=''; $('sourcePreview').hidden=true; selected=-1; highlighted=null; hovered=-1; applySettings(data.settings);appliedSettings=readSettings();parametersDirty=false; updateAll(true);
}

function updateAll(fit=false) { if(!pattern) return; pattern.counts=counts(); $('projectName').textContent=projectName;if($('focusProjectName'))$('focusProjectName').textContent=projectName;if($('focusSummary'))$('focusSummary').textContent=`${pattern.width} × ${pattern.height} · ${total()} 颗 · ${Object.keys(counts()).length} 色`; $('projectMeta').textContent=`${pattern.width} × ${pattern.height} · ${isDemo?'原创示例':palettes[paletteId].name}`; $('statSize').textContent=`${pattern.width} × ${pattern.height}`; $('statTotal').textContent=total().toLocaleString(); $('statColors').textContent=Object.keys(pattern.counts).length+' 色'; $('totalBeads').textContent=total().toLocaleString(); $('colorCountBadge').textContent=Object.keys(pattern.counts).length+' 色'; $('colInput').max=pattern.width; $('rowInput').max=pattern.height; $('colInput').value=Math.min(+$('colInput').value||1,pattern.width); $('rowInput').value=Math.min(+$('rowInput').value||1,pattern.height); updateProgress(); renderColorList(); updateSelected(); if(fit) fitCanvas(); else draw(); saveSoon(); }
function updateProgress(){ if($('statProgress'))$('statProgress').textContent=(total()?Math.round(done.size/total()*100):0)+'%'; }
function fitCanvas(){ if(!pattern) return; const area=$('canvasArea');if(!area.clientWidth||!area.clientHeight)return; fitSize=Math.min((area.clientWidth-96)/pattern.width,(area.clientHeight-96)/pattern.height); fitSize=Math.max(1,Math.min(18,fitSize)); cellSize=fitSize; ruler=23; area.scrollLeft=0;area.scrollTop=0;draw(); }
function contrast(hex){ const [r,g,b]=hexToRgb(hex);return r*.299+g*.587+b*.114>150?'#302b33':'#ffffff'; }
function draw(){
 if(!pattern)return;
 const showCodes=$('showCodes').checked&&view==='grid',showGrid=$('showGrid').checked&&view==='grid';
 patternRenderer.render({pattern,palette:activePalette,cellSize,ruler,view,showCodes,showGrid,done,highlighted,hovered,selected});
 canvas.dataset.highlightedCode=highlighted||'';canvas.dataset.selectedIndex=String(selected);
 $('zoomValue').textContent=Math.round(cellSize/fitSize*100)+'%';
 const focus=hovered>=0?hovered:selected;
 $('canvasHelp').textContent=focus>=0?`${pattern.cells[focus]||'空白格'} · X ${focus%pattern.width+1} / Y ${Math.floor(focus/pattern.width)+1}`:showCodes&&cellSize<12?'点“看清色号”查看每格编号':'点击锁定位置 · 方向键移动';
}
function hitTest(event){return patternRenderer.hitTest(event);}
function scheduleHover(){if(hoverFrame!==null)return;hoverFrame=requestAnimationFrame(()=>{hoverFrame=null;draw();updateSelected(hovered>=0?hovered:selected);});}
canvas.addEventListener('mousemove',e=>{const next=hitTest(e);if(next!==hovered){hovered=next;scheduleHover();}});
canvas.addEventListener('mouseleave',()=>{hovered=-1;scheduleHover();});
canvas.addEventListener('click',e=>{const index=hitTest(e);if(index>=0){selectCell(index,false);if(screen==='beading'){$('colorSearch').value='';const code=pattern.cells[index];highlighted=code===null?null:(highlighted===code?null:code);renderColorList();draw();}}});
function scrollToCell(index){const point=patternRenderer.cellCenter(index),area=$('canvasArea');area.scrollTo({left:Math.max(0,point.x-area.clientWidth/2),top:Math.max(0,point.y-area.clientHeight/2),behavior:'smooth'});}
function selectCell(index,scroll=true){
 if(!pattern||!Number.isInteger(index)||index<0||index>=pattern.cells.length)return;
 selected=index;hovered=-1;const col=index%pattern.width,row=Math.floor(index/pattern.width);
 $('colInput').value=col+1;$('rowInput').value=row+1;updateSelected();updateColorNav();draw();if(scroll)scrollToCell(index);
}
function updateSelected(index=selected){if(index<0){$('selectedCode').textContent='选择一颗豆';$('selectedCoords').textContent='点击图纸查看色号与位置';$('selectedSwatch').style.background='#e5ddec';$('markDone').disabled=true;$('markDone').classList.remove('done');return;}const code=pattern.cells[index],color=paletteMap().get(code);$('selectedCode').textContent=code||'空白格';$('selectedCoords').textContent=`第 ${index%pattern.width+1} 列 · 第 ${Math.floor(index/pattern.width)+1} 行${done.has(index)?' · 已拼':''}`;$('selectedSwatch').style.background=color?.hex||'#fff';$('markDone').disabled=index!==selected||code===null||sessionReadOnly();$('markDone').classList.toggle('done',done.has(index));}
$('locateForm').onsubmit=e=>{e.preventDefault();if(!pattern)return;const col=+$('colInput').value,row=+$('rowInput').value;if(!Number.isInteger(col)||!Number.isInteger(row)||col<1||row<1||col>pattern.width||row>pattern.height){toast(`请输入 1–${pattern.width} 列、1–${pattern.height} 行。`);return;}selectCell((row-1)*pattern.width+col-1);canvas.focus({preventScroll:true});};
canvas.addEventListener('keydown',e=>{
 if(!pattern)return;
 const moves={ArrowLeft:-1,ArrowRight:1,ArrowUp:-pattern.width,ArrowDown:pattern.width};
 if(e.key in moves){
  e.preventDefault();if(selected<0){selectCell(0);return;}
  const x=selected%pattern.width,y=Math.floor(selected/pattern.width);
  if(e.key==='ArrowLeft'&&x===0||e.key==='ArrowRight'&&x===pattern.width-1||e.key==='ArrowUp'&&y===0||e.key==='ArrowDown'&&y===pattern.height-1)return;
  selectCell(selected+moves[e.key]);
 }else if(e.key===' '){e.preventDefault();markSelected();}
 else if(e.key.toLowerCase()==='n'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();nextUnfinished();}
 else if(e.key==='Escape'){highlighted=null;renderColorList();draw();}
});
function markSelected(){if(sessionReadOnly())return;if(selected<0||pattern.cells[selected]===null)return;if(done.has(selected))done.delete(selected);else done.add(selected);updateSelected();updateProgress();updateColorNav();draw();saveSoon();}
$('markDone').onclick=markSelected;
function viewAnchor(){const area=$('canvasArea'),r=area.getBoundingClientRect();return selected>=0?selected:hitTest({clientX:r.left+area.clientWidth/2,clientY:r.top+area.clientHeight/2});}
function zoom(factor){const old=cellSize,anchor=viewAnchor();cellSize=Math.max(Math.min(3,fitSize),Math.min(42,cellSize*factor));if(cellSize===old)return;hovered=-1;draw();if(anchor>=0)scrollToCell(anchor);}
$('zoomIn').onclick=()=>zoom(1.4);$('zoomOut').onclick=()=>zoom(1/1.4);$('fitBtn').onclick=fitCanvas;$('showCodes').onchange=draw;$('showGrid').onchange=draw;
if($('readableZoom'))$('readableZoom').onclick=()=>{const anchor=viewAnchor();cellSize=Math.max(24,cellSize);$('showCodes').checked=true;setView('grid');if(anchor>=0)scrollToCell(anchor);toast('已放大显示每格色号，可拖动滚动条查看图纸。');};
function setView(next){view=next;$('gridView').classList.toggle('active',next==='grid');$('beadView').classList.toggle('active',next==='bead');$('showCodes').disabled=next==='bead';$('showGrid').disabled=next==='bead';draw();}
$('gridView').onclick=()=>setView('grid');$('beadView').onclick=()=>setView('bead');
function renderColorList(){const map=paletteMap(), query=$('colorSearch').value.trim().toUpperCase();const items=Object.entries(counts()).sort((a,b)=>b[1]-a[1]);$('colorList').innerHTML=items.filter(([code])=>code.toUpperCase().includes(query)).map(([code,n])=>{const color=map.get(code);return `<div class="color-row ${highlighted===code?'active':''}"><button class="color-main" data-code="${escapeHTML(code)}" aria-pressed="${highlighted===code}" title="高亮 ${escapeHTML(code)}"><span class="color-swatch" style="background:${color.hex}"></span><span class="color-label"><strong>${escapeHTML(code)}</strong></span><span class="color-quantity">${n} 颗</span></button><button class="replace-button" data-replace="${escapeHTML(code)}" aria-label="替换 ${escapeHTML(code)}，查看相近色">⇄</button></div>`;}).join('')||'<div class="empty-list">没有找到这个色号</div>';$('clearHighlight').hidden=!highlighted;updateColorNav();}
$('colorSearch').oninput=renderColorList;$('colorList').onclick=e=>{const main=e.target.closest('[data-code]'),replace=e.target.closest('[data-replace]');if(main){highlighted=highlighted===main.dataset.code?null:main.dataset.code;renderColorList();draw();if(highlighted) navigateColor(1,true);}if(replace)showAlternatives(replace.dataset.replace);};
$('clearHighlight').onclick=()=>{highlighted=null;$('colorSearch').value='';renderColorList();draw();};
function positionsFor(code){
 if(indexedCells!==pattern.cells){indexedCells=pattern.cells;colorIndex=new Map();pattern.cells.forEach((value,index)=>{if(value===null)return;if(!colorIndex.has(value))colorIndex.set(value,[]);colorIndex.get(value).push(index);});}
 return colorIndex.get(code)||[];
}
function colorPositions(){return highlighted?positionsFor(highlighted):[];}
function updateColorNav(){
 const positions=colorPositions();$('colorNavigator').hidden=!highlighted;
 if(highlighted){const at=positions.indexOf(selected),remaining=positions.reduce((sum,i)=>sum+!done.has(i),0);$('navText').textContent=`${highlighted} · ${at>=0?at+1:'—'} / ${positions.length} · 未拼 ${remaining}`;}
 if($('nextUnfinished')){$('nextUnfinished').textContent=highlighted?'下一颗 '+highlighted+' 未拼 →':'下一颗未拼 →';$('nextUnfinished').title=highlighted?'仅查找当前高亮颜色，快捷键 N':'按行列顺序查找未拼豆子，快捷键 N';}
}
function navigateColor(direction,first=false){const positions=colorPositions();if(!positions.length)return;const at=positions.indexOf(selected);const next=first?0:at<0?(direction>0?0:positions.length-1):(at+direction+positions.length)%positions.length;selectCell(positions[next]);}
function nextUnfinished(){
 if(!pattern)return;
 const positions=highlighted?colorPositions():pattern.cells.map((code,i)=>code===null?-1:i).filter(i=>i>=0);
 let next=positions.find(i=>i>selected&&!done.has(i));if(next===undefined)next=positions.find(i=>!done.has(i));
 if(next===undefined){toast(highlighted?`${highlighted} 已全部拼好，选择其他颜色继续。`:'这张图纸已经全部拼好啦！');return;}
 selectCell(next);canvas.focus({preventScroll:true});
}
$('prevColor').onclick=()=>navigateColor(-1);$('nextColor').onclick=()=>navigateColor(1);
if($('nextUnfinished'))$('nextUnfinished').onclick=nextUnfinished;
function showAlternatives(code){const original=paletteMap().get(code);const candidates=nearestColors(original.hex,availablePalette().filter(c=>c.code!==code),6);modal('给这颗豆，换个近似色',`<div class="modal-current"><span class="color-swatch" style="background:${original.hex}"></span><div><strong>${escapeHTML(code)}</strong><br><span>当前共 ${counts()[code]} 颗 · ${escapeHTML(palettes[paletteId].name)}</span></div></div><p>按屏幕色差从小到大排列，仅显示当前配色来源中的可用色。</p><div class="alternative-list">${candidates.map((c,i)=>`<button class="alternative" data-alternative="${escapeHTML(c.code)}"><span class="color-swatch" style="background:${c.hex}"></span><span class="alt-info"><strong>${escapeHTML(c.code)} ${i===0?'<span style="font-size:9px;color:#a99bb5;margin-left:8px">最接近</span>':''}</strong><small>${c.hex} · 色差 ΔE ${c.distance.toFixed(1)}</small></span><span class="alt-choose">替换全部 →</span></button>`).join('')||'<div class="empty-list">没有可用替代色，请在东道主补充可用颜色后重新匹配。</div>'}</div><div class="replace-all-note">替换后同步更新图纸和清单，可以撤销。色差越小越接近，实物请对照商家色卡。</div>`,'COLOR MATCH');$('modalBody').querySelectorAll('[data-alternative]').forEach(button=>button.onclick=()=>{const replacement=button.dataset.alternative;pushUndo();const n=counts()[code];pattern.cells=replaceColor(pattern.cells,code,replacement);for(const i of [...done])if(undoStack.at(-1).pattern.cells[i]===code)done.delete(i);if(highlighted===code)highlighted=replacement;updateAll();closeModal();toast(`已将 ${n} 颗 ${code} 替换为 ${replacement}，可撤销。`);});}
$('undoBtn').onclick=async()=>{
 if(generationPromise)return;
 const old=undoStack.at(-1);if(!old)return;const task=beginSourceTask('正在恢复上一次调整…');
 try{
  if(!await hydrateSource(old.sourceBlob,old.sourceName,{task}))return;
  undoStack.pop();originalBlob=savedOriginalBlob=old.originalBlob;originalName=savedOriginalName=old.originalName;aiEdited=savedAiEdited=!!old.aiEdited;
  pattern=old.pattern;done=new Set(old.done);customPalettes=old.customPalettes;Object.assign(palettes,customPalettes);syncPaletteOptions();setPalette(old.paletteId);projectName=old.projectName;isDemo=old.isDemo;applySettings(old.settings);appliedSettings=readSettings();pendingImport=false;parametersDirty=false;highlighted=null;selected=-1;hovered=-1;updateAll();toast('已撤销上一次更改。');
 }catch(error){if(task===sourceTask){setSaveStatus('恢复未完成 · 当前图纸已保留');toast(error.message);}}finally{finishSourceTask(task);}
};

async function loadImage(file){
 if(!file)return;if(!pattern){toast('正在打开图纸仓库，请稍后再导入。');return;}
 if(generationPromise){toast('正在生成图纸，请完成后再导入。');return;}
 if(!/^image\/(png|jpeg|webp)$/.test(file.type)){toast('请选择 JPG、PNG 或 WEBP 图片。');return;}
 if(file.size>20*1024*1024){toast('图片超过 20 MB，请压缩后上传。');return;}
 const task=beginSourceTask('正在载入新图片…');let prepared=null;
 try{
  prepared=await prepareSource(file,file.name,task);if(!prepared)return;
  if(currentProjectId&&!pendingImport)await persistCurrent();
  if(task!==sourceTask)return;
  applyPreparedSource(prepared,{commit:false});prepared=null;
  originalBlob=file;originalName=file.name;aiEdited=false;pendingImport=true;parametersDirty=true;
  $('imageStyle').value='original';$('optimizationMode').value='balanced';$('removeBackground').checked=false;subjectEditor.setState({subjectMode:'auto'});setDimensionInputs(52,52);
  setSaveStatus('新图片待生成');showScreen('editor');if($('keepRatio').checked)syncRatio('width');toast('选择尺寸和风格后，生成图纸。');return true;
 }catch(error){if(task===sourceTask){setSaveStatus('载入未完成 · 当前图纸已保留');toast(error.message||'无法读取这张图片，请更换图片。');}}
 finally{releasePreparedSource(prepared);finishSourceTask(task);}
}
$('imageFile').onchange=e=>{loadImage(e.target.files[0]);e.target.value='';};
function syncSizePresets(){const width=+$('gridWidth').value,height=+$('gridHeight').value;document.querySelectorAll('[data-size]').forEach(button=>button.classList.toggle('active',width===+button.dataset.size&&height===+button.dataset.size));}
function setDimensionInputs(width,height){$('gridWidth').value=width;$('gridHeight').value=height;syncSizePresets();}
function syncRatio(changed){if(!imageSource||!$('keepRatio').checked){syncSizePresets();return;}const region=subjectEditor.getRegion();const ratio=imageSource.width*region.width/(imageSource.height*region.height);const clamp=n=>Math.max(8,Math.min(160,Math.round(n)));let width=+$('gridWidth').value,height=+$('gridHeight').value;const requested=changed==='width'?width:height;if(!Number.isInteger(requested)||requested<8||requested>160){syncSizePresets();return;}if(changed==='width'){height=clamp(width/ratio);width=clamp(height*ratio);}else{width=clamp(height*ratio);height=clamp(width/ratio);}setDimensionInputs(width,height);}
$('gridWidth').onchange=()=>syncRatio('width');$('gridHeight').onchange=()=>syncRatio('height');$('keepRatio').onchange=()=>syncRatio('width');document.querySelectorAll('[data-size]').forEach(b=>b.onclick=()=>{setDimensionInputs(+b.dataset.size,+b.dataset.size);syncRatio('width');});$('maxColors').oninput=()=>$('maxColorsValue').textContent=$('maxColors').value;$('tolerance').oninput=()=>$('toleranceValue').textContent=$('tolerance').value;
function updateSourceControls(){
 subjectEditor.setImage(imageSource);
 const bg=pattern?.backgroundDiagnostics;$('backgroundStatus').hidden=!bg||bg.mode!=='edge';$('backgroundStatus').textContent=!bg?'':bg.status==='segmented'?'已移除可确认的外部底色。':bg.reason==='existing-alpha'?'已沿用原图透明区域，保留白色主体。':'主体与背景难以可靠区分，已保留不确定区域。';
 const busy=loadingImage||!!generationPromise||sessionBusy;$('subjectEditor').inert=busy;
 $('aiOptimizeBtn').disabled=!sourceBlob||busy;
 $('aiOptimizeBtn').textContent=loadingImage?'正在载入图片…':sourceBlob?'✦ 优化这张图片':'先上传图片，再用 AI 优化';
 $('restoreOriginalBtn').hidden=!aiEdited||!originalBlob;
 $('aiSourceBadge').hidden=!aiEdited;
 $('sourceThumb').alt=aiEdited?'当前使用的 AI 优化图':'已上传的原图';
 $('undoBtn').title='撤销上一次图纸调整';
 $('undoBtn').disabled=busy||!undoStack.length;
 for(const id of ['saveProject','startBeading'])$(id).disabled=busy||!pattern;
 $('exportBtn').disabled=busy||pendingImport||!pattern;
 for(const id of ['navLibrary','navRecords','navHost','libraryNew','openProject','difficultyExamplesBtn'])if($(id))$(id).disabled=!!generationPromise||!pattern;
 const missing=!imageSource&&!isDemo&&!pendingImport;
 for(const id of ['gridWidth','gridHeight','maxColors','keepRatio','removeBackground','tolerance','imageStyle','optimizationMode','generateBtn'])$(id).disabled=missing||busy;
 for(const id of ['paletteSelect','buyerShop','applyShopColors','restoreOriginalBtn'])$(id).disabled=busy||!pattern;
 document.querySelectorAll('[data-size]').forEach(b=>b.disabled=missing||busy);
 document.body.dataset.pendingImport=String(pendingImport);
 $('pendingSource').src=pendingImport&&imageSource?imageSource.src:'';
 if(pendingImport){$('projectName').textContent=sourceName.replace(/\.[^.]+$/,'')||'新图纸';$('projectMeta').textContent='原图预览';}
 updateShopInfo();
}
function generate(){if(generationPromise)return generationPromise;generationPromise=runGeneration().finally(()=>{generationPromise=null;updateSourceControls();});return generationPromise;}
async function runGeneration(){
 if(loadingImage){toast('原图正在载入，请稍后再生成。');return false;}
 const settings=readSettings(),{width,height}=settings;
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<8||height<8||width>160||height>160){toast('图纸宽高请输入 8–160 的整数。');return false;}
 let selectedShopPalette=null;try{if(settings.shopId)selectedShopPalette=hostStudio.getAvailablePalette(settings.shopId);}catch(error){toast(error.message);return false;}
 const available=selectedShopPalette?.colors||availablePalette();if(!available.length){toast('当前色卡没有可用颜色，请先在东道主补充颜色。');return false;}
 if(!imageSource&&!isDemo){toast('这份旧图纸没有原图，可继续拼豆或匹配店家颜色。');return false;}
 const original=imageSource,workingBlob=sourceBlob,workingName=sourceName,newImport=pendingImport;
 const controls=[...document.querySelectorAll('.source-panel button,.source-panel input,.source-panel select,#saveProject,#startBeading,#navLibrary,#openProject,#libraryNew,#aiConfigBtn')].map(el=>[el,el.disabled]);controls.forEach(([el])=>el.disabled=true);
 $('subjectEditor').inert=true;$('canvasLoading').hidden=false;$('canvasLoading').textContent='正在定位主体并匹配颜色…';
 await new Promise(r=>setTimeout(r,40));
 try{
  let next;
  const off=document.createElement('canvas');off.width=width;off.height=height;const c=off.getContext('2d',{willReadFrequently:true});
  if(original){
   // Subject localization precedes image reduction and colour planning.
   const region=subjectEditor.getRegion(),sx=region.x*original.width,sy=region.y*original.height,sw=region.width*original.width,sh=region.height*original.height;
   const factor=Math.min(4,Math.max(1,Math.max(sw/width,sh/height)));
   off.width=Math.round(width*factor);off.height=Math.round(height*factor);
   c.imageSmoothingEnabled=sw>off.width||sh>off.height;c.imageSmoothingQuality='high';
   let bounds={x:0,y:0,width:off.width,height:off.height};
   if(settings.keepRatio){const scale=Math.min(off.width/sw,off.height/sh),dw=sw*scale,dh=sh*scale;bounds={x:(off.width-dw)/2,y:(off.height-dh)/2,width:dw,height:dh};}
   c.drawImage(original,sx,sy,sw,sh,bounds.x,bounds.y,bounds.width,bounds.height);
   next=convertSourceToPattern(c.getImageData(0,0,off.width,off.height),off.width,off.height,width,height,available,{...settings,contentBounds:bounds});
  }else{
   const demo=makeDemo(width,height,available),m=new Map(available.map(a=>[a.code,a]));demo.cells.forEach((code,i)=>{if(code){c.fillStyle=m.get(code).hex;c.fillRect(i%width,Math.floor(i/width),1,1);}});
   next=convertSourceToPattern(c.getImageData(0,0,width,height),width,height,width,height,available,{...settings,removeBackground:false});
  }
  if(newImport){currentProjectId=null;currentCreatedAt=null;undoStack=[];$('undoBtn').disabled=true;}else pushUndo();
  if(selectedShopPalette)registerShopPalette(settings.shopId,selectedShopPalette);
  pattern=next;if(newImport||!currentProjectId)projectName=original?workingName.replace(/\.[^.]+$/,'').slice(0,60)||'我的拼豆图纸':'小狐狸的午后';isDemo=!original;
  savedSourceBlob=workingBlob;savedSourceName=workingName;savedOriginalBlob=originalBlob;savedOriginalName=originalName;savedAiEdited=aiEdited;activeDraft=true;pendingImport=false;parametersDirty=false;appliedSettings=settings;applySettings(settings);
  done=new Set();selected=-1;hovered=-1;highlighted=null;setView('grid');updateAll(true);await persistCurrent();toast(total()?`已保存图纸：${total()} 颗豆，${Object.keys(counts()).length} 种颜色。`:'图纸为空，可关闭“去除外部底色”或重新框选主体后重试。');return true;
 }catch(e){toast('生成或保存失败：'+e.message);return false;}
 finally{controls.forEach(([el,disabled])=>el.disabled=disabled);$('canvasLoading').hidden=true;updateSourceControls();}
}
$('generateBtn').onclick=generate;
$('paletteSelect').onchange=()=>{$('buyerShop').value='';updateShopInfo();const next=$('paletteSelect').value, oldMap=paletteMap();pushUndo();setPalette(next);const avail=availablePalette();const replacements=new Map();for(const code of Object.keys(counts()))replacements.set(code,nearestColors(oldMap.get(code).hex,avail.length?avail:activePalette,1)[0].code);pattern.cells=pattern.cells.map(c=>c===null?null:replacements.get(c));done=new Set();highlighted=null;appliedSettings={...appliedSettings,shopId:''};parametersDirty=settingsDiffer();updateAll();toast('已按新色卡匹配图纸，数量保持不变。');};

function downloadBlob(filename,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}
function downloadText(filename,text,type='text/plain;charset=utf-8',bom=false){downloadBlob(filename,new Blob([bom?'\ufeff':'',text],{type}));}
function safeName(){return projectName.replace(/[\\/:*?"<>|]/g,'_')||'拼豆图纸';}
function csvCell(value){const s=String(value);return '"'+s.replace(/"/g,'""')+'"';}
function exportList(){const map=paletteMap();const rows=[['色卡','色号','HEX','用豆数量'],...Object.entries(counts()).sort((a,b)=>b[1]-a[1]).map(([code,n])=>[palettes[paletteId].name,code,map.get(code).hex,n])];downloadText(safeName()+'-用色清单.csv',rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8',true);toast('用色清单已导出。');}
$('downloadList').onclick=exportList;
function exportPositions(){const rows=[['X列','Y行','色号','已拼']];pattern.cells.forEach((code,i)=>{if(code!==null)rows.push([i%pattern.width+1,Math.floor(i/pattern.width)+1,code,done.has(i)?'是':'否']);});downloadText(safeName()+'-逐颗坐标.csv',rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8',true);toast('逐颗坐标已导出，左上角为 (1,1)。');}
async function exportPNG(){toast('正在绘制高清图纸…');await new Promise(r=>setTimeout(r,30));const unit=32,pad=58,top=112,gridW=pattern.width*unit,gridH=pattern.height*unit;const colors=Object.entries(counts()).sort((a,b)=>b[1]-a[1]);const width=Math.max(800,gridW+pad*2),columns=Math.max(3,Math.floor((width-pad*2)/190));const legendRows=Math.ceil(colors.length/columns);const height=top+gridH+104+legendRows*45+65;const off=document.createElement('canvas');off.width=width;off.height=height;const c=off.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,width,height);c.fillStyle='#43374e';c.font='bold 28px sans-serif';c.fillText(projectName.slice(0,30),pad,44,width-pad*2);c.font='15px sans-serif';c.fillStyle='#8e7b9c';c.fillText(`${pattern.width} × ${pattern.height}  |  ${total()} 颗  |  ${colors.length} 色  |  ${palettes[paletteId].name}`,pad,77,width-pad*2);const map=paletteMap();pattern.cells.forEach((code,i)=>{const x=pad+i%pattern.width*unit,y=top+Math.floor(i/pattern.width)*unit;if(code===null){c.fillStyle='#eef0f3';c.fillRect(x,y,unit,unit);return;}const color=map.get(code);c.fillStyle=color.hex;c.fillRect(x,y,unit,unit);c.fillStyle=contrast(color.hex);c.font='bold 10px sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillText(code,x+unit/2,y+unit/2,unit-3);});drawBeadGrid(c,{columns:pattern.width,rows:pattern.height,cellSize:unit,left:pad,top});c.strokeStyle='#a497ad';c.strokeRect(pad,top,gridW,gridH);c.fillStyle='#897792';c.font='11px sans-serif';c.textAlign='center';c.textBaseline='middle';for(let x=0;x<pattern.width;x++){c.fillText(x+1,pad+(x+.5)*unit,top-17);c.fillText(x+1,pad+(x+.5)*unit,top+gridH+18);}for(let y=0;y<pattern.height;y++){c.fillText(y+1,pad-21,top+(y+.5)*unit);c.fillText(y+1,pad+gridW+21,top+(y+.5)*unit);}const legendTop=top+gridH+64;c.textAlign='left';c.fillStyle='#43374e';c.font='bold 20px sans-serif';c.fillText('用色统计',pad,legendTop);colors.forEach(([code,n],i)=>{const x=pad+(i%columns)*190,y=legendTop+38+Math.floor(i/columns)*45;c.fillStyle=map.get(code).hex;c.fillRect(x,y-12,24,24);c.strokeStyle='#ddd';c.lineWidth=1;c.strokeRect(x,y-12,24,24);c.fillStyle='#66546f';c.font='16px sans-serif';c.fillText(`${code} × ${n}`,x+35,y);});c.font='12px sans-serif';c.fillStyle='#a194a9';c.fillText('豆豆工坊 · 浅灰格为空位 · X 为列，Y 为行，左上角 (1,1) · 屏幕色仅供参考，实物请以商家色卡为准。',pad,height-25,width-pad*2);off.toBlob(blob=>{if(!blob){toast('导出失败，请尝试较小尺寸。');return;}downloadBlob(safeName()+'-拼豆图纸.png',blob);toast('高清图纸已导出，含色号、逐行列坐标和用色统计。');},'image/png');}
$('exportBtn').onclick=()=>{modal('把灵感带到拼豆桌上',`<button class="export-option" id="exportPng"><span>▧</span><div><strong>高清 PNG 图纸</strong><small>每格色号 · 四边坐标 · 10 格辅助线 · 用色统计</small></div><span>↓</span></button><button class="export-option" id="exportCsv"><span>▤</span><div><strong>用色清单 CSV</strong><small>色卡、色号、颜色与用量，方便备豆</small></div><span>↓</span></button><button class="export-option" id="exportCoords"><span>⌖</span><div><strong>逐颗坐标 CSV</strong><small>每颗豆的 X 列、Y 行、色号和完成状态</small></div><span>↓</span></button><button class="export-option" id="exportBackup"><span>▣</span><div><strong>图纸备份 JSON</strong><small>色卡、图纸、参数与进度 · 不含原图</small></div><span>↓</span></button><p style="font-size:10px">导出为完整图纸，不受当前高亮或缩放影响。仓库保留原图与编辑参数。下方 JSON 备份保留色卡和进度，不含原图。</p>`,'TAKE YOUR PATTERN');$('exportPng').onclick=()=>{closeModal();exportPNG();};$('exportCsv').onclick=exportList;$('exportCoords').onclick=exportPositions;$('exportBackup').onclick=()=>downloadText(safeName()+'.beads.json',JSON.stringify(serializable(),null,2),'application/json');};
$('saveProject').onclick=async()=>{if(await ensureGenerated()){activeDraft=true;await persistCurrent(true).catch(()=>{});}};
$('openProject').onclick=()=>$('projectFile').click();
$('projectFile').onchange=async e=>{
 const file=e.target.files[0];e.target.value='';if(!file||!pattern)return;
 if(generationPromise){toast('正在生成图纸，请完成后再导入。');return;}
 const task=beginSourceTask('正在读取图纸备份…');
 try{
  if(file.size>5*1024*1024)throw new Error('图纸文件请控制在 5 MB 以内。');const data=JSON.parse(await file.text());if(task!==sourceTask)return;validateProject(data);
  if(currentProjectId&&!pendingImport)await persistCurrent();if(task!==sourceTask)return;
  suppressSaving=true;currentProjectId=null;currentCreatedAt=null;applyPreparedSource({img:null,url:null,blob:null,name:''});originalBlob=savedOriginalBlob=null;originalName=savedOriginalName='';aiEdited=savedAiEdited=false;activeDraft=true;pendingImport=false;restoreProject(data);undoStack=[];suppressSaving=false;showScreen('editor');
  await persistCurrent();if(task===sourceTask)toast('图纸已导入仓库。此文件不含原图，可继续拼豆或匹配店家颜色。');
 }catch(error){if(task===sourceTask){suppressSaving=false;setSaveStatus('打开未完成 · 当前图纸已保留');toast('打开失败：'+error.message);}}finally{finishSourceTask(task);}
};
$('sourceInfo').onclick=()=>modal('可追溯的色卡，安心选色',`<p>内置 MARD 291 色和 221 色来自开源社区整理的拼豆色卡数据，保留原有色号与 RGB。显示时会补齐数字位数，例如 H7 → H07。</p><p>这是屏幕参考色卡，并非品牌官方实测标准。显示器、拍摄和实物批次都会影响颜色，替代色的选择请结合商家实物色卡。</p><p><a class="footer-link" href="https://github.com/HansBug/pindou-color-data/tree/main/mard-291-github" target="_blank" rel="noopener">查看原始数据 ↗</a> · <a class="footer-link" href="./palette-LICENSE.txt" target="_blank">MIT 数据许可 ↗</a></p><div class="notice-box">通用版支持导入其他品牌或店铺色卡。不同品牌的同一编号可能代表不同颜色，请确认所选色卡再购买。</div>`,'COLOR DATA');
$('helpBtn').onclick=()=>modal('从图片，到一颗颗拼好',`<ol><li><b>上传图片：</b>选择 PNG、JPG 或 WEBP。主体清晰、背景简单的图片更适合，透明 PNG 可以直接保留空白区域。</li><li><b>AI 优化（可选）：</b>先在 AI 配置里填写图片编辑接口、模型和密钥。上传照片后可转拼豆插画、简化背景或按文字微调；对比满意后采用。原图会保留，随时可恢复。</li><li><b>调整参数：</b>尺寸决定横纵各有多少颗豆；颜色越少越容易备豆。纯色背景可尝试勾选去除。</li><li><b>选择色卡：</b>内置 MARD 参考色卡，也能选择东道主中的店家色卡，生成时只使用店家标记为可用的颜色。</li><li><b>查看与替色：</b>点击清单色号高亮对应豆子，左右箭头逐颗查看；⇄ 可选择相近色，一键替换并更新数量。</li><li><b>快速定位：</b>X 是列，Y 是行，从左上角 (1,1) 开始。输入坐标直接定位，或点击图纸锁定。聚焦图纸后用方向键移动，空格标记已拼。</li><li><b>计时与记录：</b>开始拼豆会自动计时；手动暂停、返回仓库或切换到后台时暂停。重新打开可继续，离线时间不计入；意外中断恢复最近一次备份。点击“完成”保存耗时和完成日期，可在“拼豆记录”查看。</li><li><b>导出与保存：</b>PNG 图纸适合打印或平板查看，CSV 用于备料与核对。保存到仓库会保留原图、参数和进度，之后可继续编辑。</li></ol><div class="notice-box">放大后显示每格色号；每 10 格有辅助线。普通制图在本机浏览器处理；仅主动使用 AI 时，图片会发送到你配置的服务。图纸仓库保存于此浏览器，含本次导入的原图。开始拼豆进入简洁模式，点击图上豆子或颜色清单可高亮同色。下载的 JSON 备份不含原图。</div>`,'A LITTLE GUIDE');


function showScreen(next){
 screen=next;updateSourceControls();document.body.dataset.screen=next;
 $('navLibrary').classList.toggle('nav-active',next==='library');$('navLibrary').setAttribute('aria-current',next==='library'?'page':'false');
 $('navRecords').classList.toggle('nav-active',next==='records');$('navRecords').setAttribute('aria-current',next==='records'?'page':'false');
 $('navHost').classList.toggle('nav-active',next==='host');$('navHost').setAttribute('aria-current',next==='host'?'page':'false');
 if(next==='library')renderLibrary();
 else if(next==='records')renderRecords();
 else if(next==='host')hostStudio.render();
 else{
  if(next==='beading'){$('showCodes').checked=true;$('showGrid').checked=true;setView('grid');}
  renderColorList();
  requestAnimationFrame(()=>{
   if(screen!==next)return;
   fitCanvas();
   if(next==='beading'&&pattern){
    cellSize=Math.max(24,cellSize);draw();
    let anchor=selected;
    if(anchor<0)anchor=pattern.cells.findIndex((code,index)=>code!==null&&!done.has(index));
    if(anchor<0)anchor=pattern.cells.findIndex(code=>code!==null);
    if(anchor>=0)selectCell(anchor);
   }
  });
 }
 window.scrollTo({top:0,behavior:'instant'});
}
function renderLibrary(){
 const query=$('librarySearch').value.trim().toLowerCase(),sort=$('librarySort').value;
 const entries=libraryEntries.filter(p=>p.name.toLowerCase().includes(query)&&matchesLibraryFilters(p,libraryFilters)).sort(sort==='name'?(a,b)=>a.name.localeCompare(b.name,'zh-CN'):(a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 $('libraryCount').textContent=libraryEntries.length;$('libraryTotalBeads').textContent=libraryEntries.reduce((n,p)=>n+p.totalBeads,0).toLocaleString();$('libraryInProgress').textContent=recordEntries.filter(p=>p.status==='in_progress').length;
 const newTile=`<button id="libraryNew" class="library-card library-new-card" type="button" data-new-project ${generationPromise||!pattern?'disabled':''}><span class="library-new-icon" aria-hidden="true">＋</span><strong>新建图纸</strong></button>`;
 $('libraryGrid').innerHTML=newTile+entries.map(p=>{const effort=p.effort;const id=escapeHTML(p.id),name=escapeHTML(p.name);return `<article class="library-card library-project-card"><div class="library-preview"><img src="${escapeHTML(p.thumbnail)}" alt="${name}的拼豆图纸" loading="lazy"><button class="delete-project library-trash" data-delete="${id}" type="button" aria-label="删除 ${name}" title="删除图纸"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg></button><span class="library-card-badge">${p.width} × ${p.height}</span><div class="library-card-actions"><button class="button quiet library-edit" data-edit="${id}" type="button" aria-label="编辑 ${name}">编辑</button><button class="button primary library-start" data-start="${id}" type="button" aria-label="拼豆 ${name}">拼豆</button></div></div><div class="library-card-body"><h3><button class="library-name" data-rename="${id}" type="button" aria-label="修改名称 ${name}" title="点击修改名称">${name}</button></h3><div class="library-card-meta"><span>${p.totalBeads.toLocaleString()} 颗豆 · ${p.colorCount} 色</span></div><div class="library-estimate" title="按豆数、颜色与零碎色块估算；实际时间因熟练度而异"><span class="difficulty difficulty-${[1,2,3].includes(effort?.level)?effort.level:'unknown'}">${escapeHTML(effort?.difficulty||'待评估')}</span><span>预计 ${escapeHTML(effort?.label?.replace(/^约/,'')||'—')}</span></div></div></article>`;}).join('');
 const filtered=libraryFilters.levels.length>0||libraryFilters.time!=='all';$('libraryFilterBtn').setAttribute('aria-pressed',String(filtered));$('libraryFilterBtn').textContent=filtered?'筛选 · 已选':'筛选';
 if(!entries.length&&(query||filtered))$('libraryGrid').insertAdjacentHTML('beforeend','<div class="library-empty library-search-empty"><h3>没有符合条件的图纸</h3><p>调整名称或筛选条件后重试。</p><button class="button quiet" data-clear-library-filter>清除条件</button></div>');
}
function releasePreparedSource(prepared){if(prepared?.url)URL.revokeObjectURL(prepared.url);}
async function prepareSource(blob,name,task=sourceTask){
 let img=null,url=null;
 if(blob){url=URL.createObjectURL(blob);img=new Image();try{img.src=url;await img.decode();if(img.width*img.height>50_000_000)throw new Error();}catch{URL.revokeObjectURL(url);throw new Error('图片无法读取或尺寸过大，请重新选择。');}}
 const prepared={img,url,blob,name:name||''};if(task!==sourceTask){releasePreparedSource(prepared);return null;}return prepared;
}
function applyPreparedSource({img,url,blob,name},{commit=true,releasePrevious=true}={}){
 if(releasePrevious&&imageSource?.src?.startsWith('blob:'))URL.revokeObjectURL(imageSource.src);
 imageSource=img;sourceBlob=blob;sourceName=name||'';sourceRevision++;subjectEditor.setImage(img);
 if(commit){savedSourceBlob=blob;savedSourceName=sourceName;}
 $('sourcePreview').hidden=!img;
 if(img){$('sourceThumb').src=url;$('sourceName').textContent=sourceName||'保存的图片';$('sourceSize').textContent=`${img.width} × ${img.height} px`;}
 else $('sourceThumb').removeAttribute('src');
}
async function hydrateSource(blob,name,{commit=true,releasePrevious=true,task=sourceTask}={}){
 const prepared=await prepareSource(blob,name,task);if(!prepared)return false;
 applyPreparedSource(prepared,{commit,releasePrevious});return true;
}
async function useWorkingSource(blob,name,edited){
 if(loadingImage||generationPromise)return false;
 const before={drawing:snapshot(),imageSource,sourceBlob,sourceName,originalBlob,originalName,aiEdited,pendingImport,parametersDirty,activeDraft,currentProjectId,currentCreatedAt,sourceRevision,settings:readSettings(),undo:[...undoStack]};
 const task=beginSourceTask(edited?'正在载入 AI 优化图…':'正在恢复原始图片…');
 try{if(!await hydrateSource(blob,name,{commit:false,releasePrevious:false,task}))return false;aiEdited=edited;parametersDirty=true;if($('keepRatio').checked)syncRatio('width');}
 catch(error){if(task===sourceTask)toast(error.message);return false;}finally{finishSourceTask(task);}
 if(task!==sourceTask)return false;
 const accepted=await generate();if(accepted){if(before.imageSource?.src?.startsWith('blob:'))URL.revokeObjectURL(before.imageSource.src);return true;}
 if(task!==sourceTask){if(before.imageSource?.src?.startsWith('blob:'))URL.revokeObjectURL(before.imageSource.src);return false;}
 // Adoption is all-or-nothing: a failed generation/save must leave the preview optional.
 // Keep the already decoded prior source until commit, so rollback has no asynchronous gap.
 suppressSaving=true;clearTimeout(saveTimer);
 try{
  applyPreparedSource({img:before.imageSource,url:before.imageSource?.src||null,blob:before.sourceBlob,name:before.sourceName},{commit:false});
  originalBlob=before.originalBlob;originalName=before.originalName;aiEdited=before.aiEdited;
  savedSourceBlob=before.drawing.sourceBlob;savedSourceName=before.drawing.sourceName;savedOriginalBlob=before.drawing.originalBlob;savedOriginalName=before.drawing.originalName;savedAiEdited=before.drawing.aiEdited;
  pattern=before.drawing.pattern;done=new Set(before.drawing.done);projectName=before.drawing.projectName;isDemo=before.drawing.isDemo;appliedSettings=before.drawing.settings;
  currentProjectId=before.currentProjectId;currentCreatedAt=before.currentCreatedAt;activeDraft=before.activeDraft;pendingImport=before.pendingImport;parametersDirty=before.parametersDirty;sourceRevision=before.sourceRevision;undoStack=before.undo;
  applySettings(before.settings);$('gridWidth').value=before.settings.width;$('gridHeight').value=before.settings.height;syncSizePresets();$('undoBtn').disabled=!undoStack.length;highlighted=null;selected=-1;hovered=-1;updateAll(true);setSaveStatus('生成未完成 · 原图与图纸已保留');
 }finally{suppressSaving=false;updateSourceControls();}
 return false;
}
installAI({getSource:()=>sourceBlob?{blob:sourceBlob,name:sourceName,token:sourceRevision}:null,
 adoptSource:async(blob,name,token)=>{if(token!==sourceRevision){if(sourceBlob===blob&&aiEdited)return generate();toast('当前图片已改变，请重新进行 AI 优化。');return false;}return useWorkingSource(blob,name,true);},
 modal,closeModal,toast,escapeHTML});
$('restoreOriginalBtn').onclick=async()=>{if(originalBlob){if(await useWorkingSource(originalBlob,originalName,false))toast('已恢复原图并重新生成图纸，可撤销。');}};

async function openSavedProject(id,next='editor'){
 if(generationPromise)return false;const task=beginSourceTask('正在打开图纸与原图…');openingProject=true;clearTimeout(saveTimer);let prepared=null;
 try{
  await writeQueue.catch(()=>{});if(task!==sourceTask)return false;
  const record=await getProject(id);if(task!==sourceTask)return false;if(!record)throw new Error('这份图纸暂时无法找到。');validateProject(record.project);
  prepared=await prepareSource(record.sourceBlob,record.sourceName,task);if(!prepared)return false;
  // Do not replace any current drawing state until the complete new source can be read.
  suppressSaving=true;pendingImport=false;parametersDirty=false;restoreProject(record.project);currentProjectId=record.id;currentCreatedAt=record.createdAt;applyPreparedSource(prepared);subjectEditor.setState({subjectMode:record.project.settings?.subjectMode||'whole',subjectRegion:record.project.settings?.subjectRegion});appliedSettings=readSettings();prepared=null;
  originalBlob=savedOriginalBlob=record.originalBlob;originalName=savedOriginalName=record.originalName;aiEdited=savedAiEdited=!!record.project.aiEdited;activeDraft=true;undoStack=[];$('colorSearch').value='';suppressSaving=false;setSaveStatus('已保存到本机仓库');showScreen(next==='beading'?'editor':next);if(next==='beading'){finishSourceTask(task);return await startBeading();}return true;
 }catch(e){if(task===sourceTask){suppressSaving=false;setSaveStatus('打开未完成 · 当前图纸已保留');toast(e.message);}return false;}
 finally{releasePreparedSource(prepared);finishSourceTask(task);}
}
async function ensureGenerated(){if(loadingImage){toast('原图正在载入，请稍后。');return false;}if(parametersDirty&&!pendingImport&&!imageSource&&!isDemo){applySettings(appliedSettings);parametersDirty=false;toast('此旧图纸未附原图，已保留原有参数，可继续拼豆。');}if(pendingImport||parametersDirty)return await generate();return !!pattern;}
function sessionError(error){const message=error?.message||'拼豆记录保存失败，请重试。';if($('timerState'))$('timerState').textContent=message;if($('recordStatus'))$('recordStatus').textContent=message;toast(message);}
function sessionReadOnly(){const record=sessionTimer?.current();return sessionView&&(!record||record.status==='completed'||record.lockedElsewhere);}
function elapsedLabel(ms){const seconds=Math.floor(Math.max(0,Number(ms)||0)/1000);return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');}
function recordDate(value){const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
function renderTimer(record=sessionTimer?.current()){
 if(!$('beadingTimer'))return;
 $('beadingTimer').textContent=elapsedLabel(record?.elapsedMs);
 const completed=record?.status==='completed';
 $('timerState').textContent=!record?'尚未开始':completed?'已完成 · '+recordDate(record.completedAt):record.lockedElsewhere?'其他页面正在拼这份图纸':record.running?'计时中':'已暂停';
 $('pauseTimer').textContent=record?.running?'暂停':'继续';$('pauseTimer').hidden=completed;
 $('pauseTimer').disabled=sessionBusy||!record;$('completeBeading').disabled=sessionBusy||!record||completed||record.lockedElsewhere;
 $('completeBeading').textContent=completed?'已完成':'完成';
 if(sessionView)updateSelected();
}
function timer(){return sessionTimer||(sessionTimer=createSessionTimer({onChange:renderTimer,onError:sessionError}));}
async function refreshRecords(){
 const request=++recordRequest;
 try{const entries=await listBeadingSessions();if(request!==recordRequest)return;recordEntries=entries;$('libraryInProgress').textContent=entries.filter(r=>r.status==='in_progress').length;$('recordStatus').textContent='';renderRecords();}
 catch(error){if(request===recordRequest)sessionError(error);}
}
function renderRecords(){
 const entries=[...recordEntries].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));

 $('recordGrid').innerHTML=entries.map(record=>{
  const complete=record.status==='completed',id=escapeHTML(record.id),name=escapeHTML(record.name);
  return `<article class="library-card library-project-card record-card ${complete?'is-completed':'is-progress'}"><div class="library-preview record-preview"><img src="${escapeHTML(record.thumbnail)}" alt="${name}的拼豆记录"><span class="record-status ${complete?'completed':'in-progress'}">${complete?'已完成':'进行中'}</span><span class="library-card-badge">${record.width} × ${record.height}</span><div class="library-card-actions record-actions"><button class="button ${complete?'quiet':'primary'}" data-record="${id}">${complete?'查看图纸':'继续拼豆'}</button></div></div><div class="library-card-body"><h3 class="record-name" title="${name}">${name}</h3><div class="record-meta"><span>${record.totalBeads.toLocaleString()} 颗 · ${record.colorCount} 色</span><strong>${elapsedLabel(record.elapsedMs)}</strong></div><div class="record-meta"><span>${complete?'完成':'开始'} ${recordDate(complete?record.completedAt:record.startedAt)}</span></div></div></article>`;
 }).join('')||'<div class="records-empty"><p>暂无记录，从图纸仓库开始</p></div>';
}
async function showBeadingRecord(record,autoStart=true){
 validateProject(record.project);clearTimeout(saveTimer);
 await timer().open(record.id,{autoStart:record.status!=='completed'&&autoStart});
 const restored=timer().current();if(!restored)throw new Error('无法打开拼豆记录，请重试。');
 suppressSaving=true;sessionView=true;activeDraft=false;pendingImport=false;parametersDirty=false;
 restoreProject(restored.project);currentProjectId=restored.projectId;currentCreatedAt=null;
 applyPreparedSource({img:null,url:null,blob:null,name:''});originalBlob=savedOriginalBlob=null;originalName=savedOriginalName='';aiEdited=savedAiEdited=false;
 undoStack=[];$('colorSearch').value='';suppressSaving=false;
 $('focusLibrary').textContent='回到记录';$('exitBeading').textContent='← 返回图纸';
 setSaveStatus('记录自动保存');showScreen('beading');renderTimer();
 if(restored.lockedElsewhere)toast('这份记录正在另一个页面打开；请在另一页返回记录仓库或关闭后再继续。');
}
async function leaveBeadingRecord(){
 if(!sessionView)return;
 if(!sessionReadOnly())await timer().setDone([...done]);
 await timer().detach();sessionView=false;activeDraft=false;currentProjectId=null;currentCreatedAt=null;clearTimeout(saveTimer);
}
async function goLibrary(){
 if(sessionBusy)return;
 try{if(sessionView)await leaveBeadingRecord();else{if(!(await ensureGenerated()))return;await persistCurrent();}await refreshRecords();showScreen('library');}catch(error){sessionError(error);}
}
async function goRecords(){
 if(sessionBusy)return;
 try{if(sessionView)await leaveBeadingRecord();else{if(!(await ensureGenerated()))return;await persistCurrent();}await refreshRecords();showScreen('records');}catch(error){sessionError(error);}
}
async function startBeading(){
 if(sessionBusy)return false;
 sessionBusy=true;updateSourceControls();
 try{
  if(!(await ensureGenerated()))return false;
  if(!total()){toast('图纸还没有豆子，请调整参数后重新生成。');return false;}
  activeDraft=true;await persistCurrent();
  const project=structuredClone(serializable());
  let record=await findPendingSession(currentProjectId,project);
  if(!record)record=await createBeadingSession({projectId:currentProjectId,name:projectName,thumbnail:createThumbnail(),width:pattern.width,height:pattern.height,totalBeads:total(),colorCount:Object.keys(counts()).length,project:{...project,done:[]}});
  await showBeadingRecord(record);return true;
 }catch(error){sessionError(error);return false;}finally{sessionBusy=false;updateSourceControls();renderTimer();}
}
async function openRecord(id){
 if(sessionBusy)return false;sessionBusy=true;
 try{const record=await getBeadingSession(id);if(!record)throw new Error('找不到这份拼豆记录。');await showBeadingRecord(record);return true;}
 catch(error){sessionError(error);return false;}finally{sessionBusy=false;renderTimer();}
}
$('navLibrary').onclick=goLibrary;$('navRecords').onclick=goRecords;$('focusLibrary').onclick=goRecords;
$('recordGrid').onclick=e=>{const button=e.target.closest('[data-record]');if(button)openRecord(button.dataset.record);};
$('exitBeading').onclick=async()=>{if(sessionBusy)return;const id=timer().current()?.projectId;try{await leaveBeadingRecord();if(!id||!await openSavedProject(id,'editor')){await refreshRecords();showScreen('library');}}catch(error){sessionError(error);}};
$('pauseTimer').onclick=async()=>{if(sessionBusy)return;sessionBusy=true;renderTimer();try{if(timer().current()?.running)await timer().pause();else await timer().resume();}catch(error){sessionError(error);}finally{sessionBusy=false;renderTimer();}};
$('completeBeading').onclick=async()=>{
 if(sessionBusy||sessionReadOnly())return;sessionBusy=true;renderTimer();
 try{await timer().setDone([...done]);await timer().complete();await leaveBeadingRecord();await refreshRecords();showScreen('records');toast('已完成，累计耗时和完成时间已保存。');}
 catch(error){sessionError(error);}finally{sessionBusy=false;renderTimer();}
};
$('startBeading').onclick=startBeading;
document.querySelector('.brand').onclick=e=>{e.preventDefault();goLibrary();};
$('librarySearch').oninput=renderLibrary;$('librarySort').onchange=renderLibrary;
$('libraryGrid').onclick=e=>{
 if(libraryMutation||openingProject||sessionBusy)return;
 const clear=e.target.closest('[data-clear-library-filter]');if(clear){libraryFilters={levels:[],time:'all'};$('librarySearch').value='';renderLibrary();return;}
 const create=e.target.closest('[data-new-project]'),rename=e.target.closest('[data-rename]'),remove=e.target.closest('[data-delete]'),edit=e.target.closest('[data-edit]'),start=e.target.closest('[data-start]');
 if(create){if(!create.disabled)$('imageFile').click();}else if(rename)showRename(rename.dataset.rename);else if(remove)showDelete(remove.dataset.delete);else if(edit)openSavedProject(edit.dataset.edit,'editor');else if(start)openSavedProject(start.dataset.start,'beading');
};
function clearBackup(id){try{const data=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');if(!id||data?.libraryId===id)localStorage.removeItem(STORAGE_KEY);localStorage.setItem(INITIALIZED_KEY,'1');}catch{}}
function showRename(id){
 const entry=libraryEntries.find(p=>p.id===id);if(!entry)return;
 modal('给图纸换个名字',`<form id="renameForm" class="rename-form"><label for="renameInput">图纸名称</label><input id="renameInput" name="name" value="${escapeHTML(entry.name)}" maxlength="80" required autocomplete="off"><p class="ai-field-help">最多 80 个字符，原图、参数和拼豆进度都会保留。</p><p id="renameError" class="ai-error-line" role="alert" hidden></p><div class="modal-buttons"><button type="button" class="button quiet" id="renameCancel">取消</button><button class="button primary" type="submit" id="renameSave">保存名称</button></div></form>`,'YOUR DRAWING');
 $('renameCancel').onclick=closeModal;$('renameInput').focus();$('renameInput').select();
 $('renameForm').onsubmit=async e=>{
  e.preventDefault();if(libraryMutation)return;
  let name;try{name=normalizeProjectName($('renameInput').value);}catch(error){$('renameError').textContent=error.message;$('renameError').hidden=false;return;}
  libraryMutation=true;clearTimeout(saveTimer);$('renameSave').disabled=true;
  try{
   await writeQueue.catch(()=>{});const summary=await renameProject(id,name);
   libraryEntries=libraryEntries.map(p=>p.id===id?summary:p);
   if(currentProjectId===id){projectName=name;$('projectName').textContent=name;$('focusProjectName').textContent=name;for(const item of undoStack)item.projectName=name;}
   try{const backup=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');if(backup?.libraryId===id){backup.projectName=name;localStorage.setItem(STORAGE_KEY,JSON.stringify(backup));}}catch{}
   renderLibrary();closeModal();toast('图纸已重命名。');
  }catch(error){if($('renameError')){$('renameError').textContent=error.message;$('renameError').hidden=false;}}finally{libraryMutation=false;if($('renameSave'))$('renameSave').disabled=false;}
 };
}
function showDelete(id){
 const entry=libraryEntries.find(p=>p.id===id);if(!entry)return;
 modal('确认删除这份图纸？',`<div class="confirm-project-thumb"><img src="${escapeHTML(entry.thumbnail)}" alt="待删除图纸预览"><div><strong>${escapeHTML(entry.name)}</strong><p>${entry.width} × ${entry.height} · ${entry.totalBeads.toLocaleString()} 颗豆</p></div></div><p>将从本机仓库删除这份图纸、保存的图片、参数和拼豆进度。此操作无法撤销，请确认名称后再删除。已有的拼豆记录会保留。</p><p id="deleteError" class="ai-error-line" role="alert" hidden></p><div class="modal-buttons"><button class="button quiet" id="deleteCancel" autofocus>取消，保留图纸</button><button class="button danger-button" id="deleteConfirm">确认删除</button></div>`,'DELETE DRAWING');
 $('deleteCancel').onclick=closeModal;$('deleteCancel').focus();
 $('deleteConfirm').onclick=async()=>{
  if(libraryMutation)return;libraryMutation=true;clearTimeout(saveTimer);$('deleteConfirm').disabled=true;
  try{
   await writeQueue.catch(()=>{});await deleteProject(id);clearBackup(id);libraryEntries=libraryEntries.filter(p=>p.id!==id);
   if(currentProjectId===id){
    suppressSaving=true;activeDraft=false;currentProjectId=null;currentCreatedAt=null;pendingImport=false;parametersDirty=false;
    await hydrateSource(null,'');originalBlob=savedOriginalBlob=null;originalName=savedOriginalName='';aiEdited=savedAiEdited=false;undoStack=[];$('undoBtn').disabled=true;
    pattern=makeDemo(52,52,activePalette);isDemo=true;projectName='小狐狸的午后';done=new Set();highlighted=null;selected=-1;hovered=-1;setDimensionInputs(52,52);appliedSettings=readSettings();updateAll(true);suppressSaving=false;
   }
   closeModal();if(libraryEntries.length&&!activeDraft)await openSavedProject(libraryEntries[0].id,'library');showScreen('library');toast('图纸已从本机仓库删除。');
  }catch(error){if($('deleteError')){$('deleteError').textContent=error.message;$('deleteError').hidden=false;}}finally{suppressSaving=false;libraryMutation=false;if($('deleteConfirm'))$('deleteConfirm').disabled=false;}
 };
};
$('focusClear').onclick=()=>{highlighted=null;$('colorSearch').value='';renderColorList();draw();};
for(const id of ['gridWidth','gridHeight','maxColors','keepRatio','removeBackground','tolerance','imageStyle','optimizationMode'])$(id).addEventListener('change',markParametersDirty);
$('gridWidth').addEventListener('input',()=>{syncRatio('width');markParametersDirty();});$('gridHeight').addEventListener('input',()=>{syncRatio('height');markParametersDirty();});
document.querySelectorAll('[data-size]').forEach(b=>b.addEventListener('click',markParametersDirty));
window.addEventListener('pagehide',()=>{if(!pendingImport&&!suppressSaving)persistCurrent().catch(()=>{});});
let hostStorage;try{hostStorage=localStorage;}catch{}
const hostStudio=createHostStudio({container:$('hostContent'),modal,closeModal,toast,escapeHTML,downloadText,storage:hostStorage,onChange:()=>syncBuyerShops()});
function syncBuyerShops(wanted=$('buyerShop').value){
 const shops=hostStudio.listShops();
 $('buyerShop').innerHTML='<option value="">参考色卡 · 不限店家</option>'+shops.map(shop=>`<option value="${escapeHTML(shop.id)}">${escapeHTML(shop.name)}${shop.isDemo?' · 演示':''}</option>`).join('');
 $('buyerShop').value=shops.some(shop=>shop.id===wanted)?wanted:'';updateShopInfo();
}
function updateShopInfo(){
 const id=$('buyerShop').value,shop=id?hostStudio.getShop(id):null;
 $('referencePaletteFields').hidden=!!shop;
 $('shopPaletteInfo').textContent=shop?`${shop.colors.filter(c=>c.available!==false).length} / ${shop.colors.length} 色可用${shop.isDemo?' · 示例编号':''}`:'';
 $('availableInfo').hidden=!!shop;
 $('applyShopColors').hidden=!shop||pendingImport;
}
function registerShopPalette(id,shopPalette){
 const key='custom-host-'+id;customPalettes[key]=structuredClone(shopPalette);palettes[key]=customPalettes[key];exclusions[key]=[];syncPaletteOptions();setPalette(key);
}
$('buyerShop').onchange=()=>{if(!$('buyerShop').value&&paletteId.startsWith('custom-host-')){if(pendingImport){setPalette('mard');updateShopInfo();markParametersDirty();}else{$('paletteSelect').value='mard';$('paletteSelect').onchange();}}else{updateShopInfo();markParametersDirty();}};
$('applyShopColors').onclick=()=>{
 if(loadingImage||generationPromise||pendingImport||sessionView)return;
 try{
  const id=$('buyerShop').value;if(!id)return;const next=hostStudio.getAvailablePalette(id),old=paletteMap();
  const replacements=new Map(Object.keys(counts()).map(code=>[code,nearestColors(old.get(code).hex,next.colors,1)[0].code]));
  pushUndo();registerShopPalette(id,next);pattern.cells=pattern.cells.map(code=>code===null?null:replacements.get(code));done=new Set();highlighted=null;
  appliedSettings={...appliedSettings,shopId:id};parametersDirty=settingsDiffer();updateAll();toast('已匹配店家的可用颜色，可撤销。');
 }catch(error){toast(error.message);}
};
$('navHost').onclick=async()=>{
 if(loadingImage||generationPromise||sessionBusy)return;
 hostReturnScreen=screen==='editor'?'editor':'library';
 try{if(!pendingImport&&!parametersDirty)await persistCurrent();syncBuyerShops();$('returnFromHost').hidden=hostReturnScreen!=='editor';showScreen('host');}catch(error){toast(error.message);}
};
$('returnFromHost').onclick=()=>{syncBuyerShops();showScreen(hostReturnScreen);};
function showLibraryFilters(){
 modal('筛选图纸',`<form id="libraryFilterForm" class="library-filter-form"><fieldset><legend>难度 · 可多选</legend><div class="filter-options">${['入门','适中','挑战'].map((name,i)=>`<label><input type="checkbox" name="difficulty" value="${i+1}" ${libraryFilters.levels.includes(i+1)?'checked':''}><span class="difficulty difficulty-${i+1}">${name}</span></label>`).join('')}</div></fieldset><fieldset><legend>预计耗时</legend><select id="filterTime" aria-label="筛选预计耗时"><option value="all">不限时间</option><option value="under60">1 小时以内</option><option value="60to180">1–3 小时</option><option value="over180">3 小时以上</option></select><p class="filter-note">按预计耗时范围的中值筛选，实际用时因熟练度而异。</p></fieldset><div class="modal-buttons"><button id="filterReset" type="button" class="button quiet">清除筛选</button><button id="filterApply" class="button primary" type="submit">应用筛选</button></div></form>`,'');
 $('filterTime').value=libraryFilters.time;
 $('filterReset').onclick=()=>{libraryFilters={levels:[],time:'all'};renderLibrary();closeModal();};
 $('libraryFilterForm').onsubmit=e=>{e.preventDefault();libraryFilters={levels:[...$('libraryFilterForm').querySelectorAll('input[name="difficulty"]:checked')].map(input=>+input.value),time:$('filterTime').value};renderLibrary();closeModal();};
}
$('libraryFilterBtn').onclick=showLibraryFilters;
function showDifficultyExamples(){
 modal('选一张，试试不同难度',`<div class="difficulty-example-grid">${difficultyExamples.map(example=>{const effort=estimatePatternEffort(example.project);return `<article class="difficulty-example-card"><img src="${createThumbnail(example.project)}" alt="${escapeHTML(example.name)}图纸示例"><span class="difficulty difficulty-${effort.level}">${effort.difficulty}</span><h3>${escapeHTML(example.name)}</h3><p>${escapeHTML(example.description)}</p><div class="example-meta">${example.project.width} × ${example.project.height} · ${effort.label}</div><button class="button primary" data-use-example="${example.id}">使用这张图纸</button></article>`;}).join('')}</div>`,'');
 $('modalBody').querySelectorAll('[data-use-example]').forEach(button=>button.onclick=()=>useDifficultyExample(button.dataset.useExample));
}
$('difficultyExamplesBtn').onclick=showDifficultyExamples;
async function useDifficultyExample(id){
 if(loadingImage||generationPromise)return;
 const example=difficultyExamples.find(entry=>entry.id===id);if(!example)return;
 const project=example.project,c=document.createElement('canvas');c.width=project.width;c.height=project.height;const context=c.getContext('2d'),map=new Map(project.palette.colors.map(color=>[color.code,color.hex]));
 project.cells.forEach((code,index)=>{if(code!==null){context.fillStyle=map.get(code);context.fillRect(index%project.width,Math.floor(index/project.width),1,1);}});
 const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));if(!blob){toast('示例图片生成失败，请重试。');return;}
 closeModal();if(!await loadImage(new File([blob],example.name+'.png',{type:'image/png'})))return;
 $('buyerShop').value='';setPalette('mard');applySettings({...project.settings,width:project.width,height:project.height,imageStyle:'original',shopId:'',removeBackground:false});
 pendingImport=true;parametersDirty=true;await generate();
}
async function init(){updateSourceControls();try{
 const response=await fetch('./palette.json');if(!response.ok)throw new Error('色卡文件读取失败');basePalette=await response.json();palettes={mard:{name:'MARD · 291 色参考色卡',colors:basePalette.colors},mard221:{name:'MARD · 221 色参考色卡',colors:basePalette.colors.filter(c=>c.basic221)}};syncPaletteOptions();setPalette('mard');syncBuyerShops();difficultyExamples=createDifficultyExamples(basePalette.colors);
 try{await openLibrary();libraryReady=true;libraryEntries=await listProjects();}catch(error){$('libraryStatus').textContent=error.message+'。可以继续编辑并导出备份，但本机仓库暂不可用。';toast(error.message);}
 let restored=false;if(libraryEntries.length){await openSavedProject([...libraryEntries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0].id,'library');restored=!!pattern;}
 if(!restored){try{const raw=localStorage.getItem(STORAGE_KEY);if(raw&&!localStorage.getItem(INITIALIZED_KEY)){restoreProject(JSON.parse(raw));restored=true;}}catch{}}
 if(!restored){try{activeDraft=!localStorage.getItem(INITIALIZED_KEY);}catch{}pattern=makeDemo(52,52,activePalette);appliedSettings=readSettings();updateAll(true);}
 suppressSaving=false;if(!currentProjectId&&libraryReady&&activeDraft)await persistCurrent();await refreshRecords();$('canvasLoading').hidden=true;showScreen('library');
 let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if((screen==='editor'||screen==='beading')&&Math.abs(cellSize-fitSize)<.1)fitCanvas();},100);}).observe($('canvasArea'));
}catch(e){$('canvasLoading').textContent='载入失败，请刷新页面重试。';$('libraryStatus').textContent='载入失败：'+e.message;toast(e.message);}}
init();
