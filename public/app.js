import { generatePattern, makeDemo, nearestColors, countCells, replaceColor, hexToRgb } from './engine.js';
import { parsePalette } from './palette-import.js';
import { openLibrary, listProjects, getProject, saveProject as storeProject, renameProject, deleteProject, normalizeProjectName, newProjectId } from './library-store.js';
import { installAI } from './ai-workflow.js';

const $ = id => document.getElementById(id);
const canvas = $('patternCanvas'), ctx = canvas.getContext('2d');
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
function readSettings(){return {width:+$('gridWidth').value,height:+$('gridHeight').value,maxColors:+$('maxColors').value,keepRatio:$('keepRatio').checked,removeBackground:$('removeBackground').checked,backgroundTolerance:+$('tolerance').value};}
function applySettings(settings){
 const value=settings||{};
 const clamp=(n,min,max,fallback)=>Number.isFinite(+n)?Math.max(min,Math.min(max,Math.round(+n))):fallback;
 setDimensionInputs(clamp(value.width,8,160,pattern.width),clamp(value.height,8,160,pattern.height));
 $('maxColors').value=clamp(value.maxColors,2,64,16);$('maxColorsValue').textContent=$('maxColors').value;
 $('keepRatio').checked=value.keepRatio!==false;$('removeBackground').checked=value.removeBackground!==false;
 $('tolerance').value=clamp(value.backgroundTolerance,5,60,20);$('toleranceValue').textContent=$('tolerance').value;
}
function markParametersDirty(){if(suppressSaving)return;parametersDirty=true;setSaveStatus(pendingImport?'新图片待生成':'参数已调整 · 保存时应用');}
function setSaveStatus(text){$('saveState').textContent=text;if($('focusSaveStatus'))$('focusSaveStatus').textContent=text;}
function saveSoon(){if(suppressSaving||!libraryReady||pendingImport||libraryMutation||!activeDraft)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>persistCurrent().catch(()=>{}),350);}
function serializable() { return { format:'bead-studio', version:1, width:pattern.width, height:pattern.height, cells:pattern.cells, palette: {name:palettes[paletteId].name, colors:activePalette}, paletteId, customPalettes, projectName, isDemo, aiEdited:savedAiEdited, done:[...done], exclusions, settings:appliedSettings||readSettings(), savedAt:new Date().toISOString() }; }
function createThumbnail(){const size=320,c=document.createElement('canvas');c.width=size;c.height=size;const g=c.getContext('2d');g.fillStyle='#faf8fc';g.fillRect(0,0,size,size);const unit=Math.min((size-40)/pattern.width,(size-40)/pattern.height),left=(size-pattern.width*unit)/2,top=(size-pattern.height*unit)/2,m=paletteMap();pattern.cells.forEach((code,i)=>{if(code!==null){g.fillStyle=m.get(code).hex;g.fillRect(left+i%pattern.width*unit,top+Math.floor(i/pattern.width)*unit,unit+.1,unit+.1);}});return c.toDataURL('image/png');}
function persistCurrent(notify=false){
 clearTimeout(saveTimer);
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
 syncPaletteOptions(); setPalette(id); pattern={width:data.width,height:data.height,cells:[...data.cells]}; projectName=String(data.projectName||'我的拼豆图纸').slice(0,80); isDemo=!!data.isDemo; done=new Set(data.done||[]); exclusions={};
 if(data.exclusions && typeof data.exclusions==='object') for(const [key,value] of Object.entries(data.exclusions)) {
  const restoredKey=key===data.paletteId?id:key;
  if(Object.hasOwn(palettes,restoredKey) && Array.isArray(value)) exclusions[restoredKey]=value.filter(c=>palettes[restoredKey].colors.some(p=>p.code===c));
 }
 updateAvailable(); if(imageSource?.src?.startsWith('blob:'))URL.revokeObjectURL(imageSource.src);imageSource=null; sourceName=''; $('sourcePreview').hidden=true; selected=-1; highlighted=null; hovered=-1; applySettings(data.settings);appliedSettings=readSettings();parametersDirty=false; updateAll(true);
}

function updateAll(fit=false) { if(!pattern) return; pattern.counts=counts(); $('projectName').textContent=projectName;if($('focusProjectName'))$('focusProjectName').textContent=projectName;if($('focusSummary'))$('focusSummary').textContent=`${pattern.width} × ${pattern.height} · ${total()} 颗 · ${Object.keys(counts()).length} 色`; $('projectMeta').textContent=`${pattern.width} × ${pattern.height} · ${isDemo?'原创示例':palettes[paletteId].name}`; $('statSize').textContent=`${pattern.width} × ${pattern.height}`; $('statTotal').textContent=total().toLocaleString(); $('statColors').textContent=Object.keys(pattern.counts).length+' 色'; $('totalBeads').textContent=total().toLocaleString(); $('colorCountBadge').textContent=Object.keys(pattern.counts).length+' 色'; $('colInput').max=pattern.width; $('rowInput').max=pattern.height; $('colInput').value=Math.min(+$('colInput').value||1,pattern.width); $('rowInput').value=Math.min(+$('rowInput').value||1,pattern.height); updateProgress(); renderColorList(); updateSelected(); if(fit) fitCanvas(); else draw(); saveSoon(); }
function updateProgress(){ const n=total(); $('statProgress').textContent=(n?Math.round(done.size/n*100):0)+'%'; }
function fitCanvas(){ if(!pattern) return; const area=$('canvasArea');if(!area.clientWidth||!area.clientHeight)return; fitSize=Math.min((area.clientWidth-82)/pattern.width,(area.clientHeight-82)/pattern.height); fitSize=Math.max(2,Math.min(18,fitSize)); cellSize=fitSize; ruler=23; draw(); area.scrollLeft=0; area.scrollTop=0; }
function contrast(hex){ const [r,g,b]=hexToRgb(hex);return r*.299+g*.587+b*.114>150?'#302b33':'#ffffff'; }
function draw(){ if(!pattern) return; const dpr=Math.min(window.devicePixelRatio||1,2); const w=pattern.width*cellSize+2*ruler, h=pattern.height*cellSize+2*ruler; canvas.width=Math.ceil(w*dpr); canvas.height=Math.ceil(h*dpr); canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0); ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h); const map=paletteMap(); const showCodes=$('showCodes').checked && view==='grid'; const showGrid=$('showGrid').checked && view==='grid'; for(let i=0;i<pattern.cells.length;i++){const code=pattern.cells[i];if(code===null) continue; const color=map.get(code);const x=ruler+(i%pattern.width)*cellSize,y=ruler+Math.floor(i/pattern.width)*cellSize; const faded=highlighted && code!==highlighted;ctx.globalAlpha=faded?.12:1;ctx.fillStyle=color?.hex||'#ccc';if(view==='bead'){ctx.beginPath();ctx.arc(x+cellSize/2,y+cellSize/2,cellSize*.46,0,Math.PI*2);ctx.fill();ctx.fillStyle='#ffffffaa';ctx.beginPath();ctx.arc(x+cellSize/2,y+cellSize/2,cellSize*.14,0,Math.PI*2);ctx.fill();}else{ctx.fillRect(x,y,cellSize+.2,cellSize+.2);if(showCodes && cellSize>=12){ctx.fillStyle=contrast(color?.hex||'#ccc');ctx.font=`500 ${Math.min(11,cellSize*.31)}px 'Noto Sans SC',sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(code,x+cellSize/2,y+cellSize/2,cellSize-2);}}if(done.has(i)){ctx.fillStyle='#ffffffb0';ctx.fillRect(x,y,cellSize,cellSize);if(cellSize>=8){ctx.fillStyle='#586c50';ctx.font=`bold ${cellSize*.65}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('✓',x+cellSize/2,y+cellSize/2);}}ctx.globalAlpha=1;}
 if(showGrid){ctx.lineWidth=.45;ctx.strokeStyle='#86808e2b';ctx.beginPath();for(let x=0;x<=pattern.width;x++){ctx.moveTo(ruler+x*cellSize,ruler);ctx.lineTo(ruler+x*cellSize,h-ruler);}for(let y=0;y<=pattern.height;y++){ctx.moveTo(ruler,ruler+y*cellSize);ctx.lineTo(w-ruler,ruler+y*cellSize);}ctx.stroke();ctx.strokeStyle='#b690a7a0';ctx.lineWidth=1;ctx.beginPath();for(let x=10;x<pattern.width;x+=10){ctx.moveTo(ruler+x*cellSize,ruler);ctx.lineTo(ruler+x*cellSize,h-ruler);}for(let y=10;y<pattern.height;y+=10){ctx.moveTo(ruler,ruler+y*cellSize);ctx.lineTo(w-ruler,ruler+y*cellSize);}ctx.stroke();}
 ctx.lineWidth=.7;ctx.strokeStyle='#c4b8ce';ctx.strokeRect(ruler,ruler,pattern.width*cellSize,pattern.height*cellSize);ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='9px sans-serif';ctx.fillStyle='#a89bae';for(let x=0;x<pattern.width;x++){if(x===0||(x+1)%10===0||cellSize>=24){ctx.fillText(x+1,ruler+(x+.5)*cellSize,ruler/2);ctx.fillText(x+1,ruler+(x+.5)*cellSize,h-ruler/2);}}for(let y=0;y<pattern.height;y++){if(y===0||(y+1)%10===0||cellSize>=24){ctx.fillText(y+1,ruler/2,ruler+(y+.5)*cellSize);ctx.fillText(y+1,w-ruler/2,ruler+(y+.5)*cellSize);}}
 const focus=hovered>=0?hovered:selected;if(focus>=0 && focus<pattern.cells.length){const col=focus%pattern.width,row=Math.floor(focus/pattern.width);const x=ruler+col*cellSize,y=ruler+row*cellSize;ctx.fillStyle='#8e68b31c';ctx.fillRect(ruler,y,pattern.width*cellSize,cellSize);ctx.fillRect(x,ruler,cellSize,pattern.height*cellSize);ctx.strokeStyle='#8662ad';ctx.lineWidth=1.5;ctx.strokeRect(x+.5,y+.5,cellSize-1,cellSize-1);ctx.fillStyle='#80609f';ctx.fillRect(x,0,cellSize,ruler-2);ctx.fillRect(0,y,ruler-2,cellSize);ctx.fillStyle='white';ctx.font=`${Math.min(10,cellSize*.85)}px sans-serif`;ctx.fillText(col+1,x+cellSize/2,ruler/2);ctx.fillText(row+1,ruler/2,y+cellSize/2);}
 canvas.dataset.highlightedCode=highlighted||'';canvas.dataset.selectedIndex=String(selected);$('zoomValue').textContent=Math.round(cellSize/fitSize*100)+'%';$('canvasHelp').textContent=showCodes&&cellSize<12?'放大后显示色号':'点击锁定位置';
}
function hitTest(event){const r=canvas.getBoundingClientRect();const x=Math.floor((event.clientX-r.left-ruler)/cellSize),y=Math.floor((event.clientY-r.top-ruler)/cellSize);return x>=0&&x<pattern.width&&y>=0&&y<pattern.height?y*pattern.width+x:-1;}
canvas.addEventListener('mousemove',e=>{const next=hitTest(e);if(next!==hovered){hovered=next;draw();updateSelected(next);}});canvas.addEventListener('mouseleave',()=>{hovered=-1;draw();updateSelected();});canvas.addEventListener('click',e=>{const index=hitTest(e);if(index>=0){selectCell(index,false);if(screen==='beading'){$('colorSearch').value='';const code=pattern.cells[index];highlighted=code===null?null:(highlighted===code?null:code);renderColorList();draw();}}});
function selectCell(index,scroll=true){selected=index;hovered=-1;const col=index%pattern.width,row=Math.floor(index/pattern.width);$('colInput').value=col+1;$('rowInput').value=row+1;updateSelected();updateColorNav();draw();if(scroll){const area=$('canvasArea');const x=canvas.offsetLeft+ruler+(col+.5)*cellSize,y=canvas.offsetTop+ruler+(row+.5)*cellSize;area.scrollTo({left:Math.max(0,x-area.clientWidth/2),top:Math.max(0,y-area.clientHeight/2),behavior:'smooth'});} }
function updateSelected(index=selected){if(index<0){$('selectedCode').textContent='选择一颗豆';$('selectedCoords').textContent='点击图纸查看色号与位置';$('selectedSwatch').style.background='#e5ddec';$('markDone').disabled=true;$('markDone').classList.remove('done');return;}const code=pattern.cells[index],color=paletteMap().get(code);$('selectedCode').textContent=code||'空白格';$('selectedCoords').textContent=`第 ${index%pattern.width+1} 列 · 第 ${Math.floor(index/pattern.width)+1} 行${done.has(index)?' · 已拼':''}`;$('selectedSwatch').style.background=color?.hex||'#fff';$('markDone').disabled=index!==selected||code===null;$('markDone').classList.toggle('done',done.has(index));}
$('locateForm').onsubmit=e=>{e.preventDefault();if(!pattern)return;const col=+$('colInput').value,row=+$('rowInput').value;if(!Number.isInteger(col)||!Number.isInteger(row)||col<1||row<1||col>pattern.width||row>pattern.height){toast(`请输入 1–${pattern.width} 列、1–${pattern.height} 行。`);return;}selectCell((row-1)*pattern.width+col-1);canvas.focus({preventScroll:true});};
canvas.addEventListener('keydown',e=>{if(!pattern)return;const moves={ArrowLeft:-1,ArrowRight:1,ArrowUp:-pattern.width,ArrowDown:pattern.width};if(e.key in moves){e.preventDefault();let at=selected<0?0:selected;if(e.key==='ArrowLeft'&&at%pattern.width===0||e.key==='ArrowRight'&&at%pattern.width===pattern.width-1)return;selectCell(Math.max(0,Math.min(pattern.cells.length-1,at+moves[e.key])));}else if(e.key===' '){e.preventDefault();markSelected();}else if(e.key==='Escape'){highlighted=null;renderColorList();draw();}});
function markSelected(){if(selected<0||pattern.cells[selected]===null)return;if(done.has(selected))done.delete(selected);else done.add(selected);updateSelected();updateProgress();draw();saveSoon();}
$('markDone').onclick=markSelected;
function zoom(factor){const old=cellSize;cellSize=Math.max(3,Math.min(42,cellSize*factor));if(cellSize===old)return;draw();if(selected>=0)selectCell(selected);}
$('zoomIn').onclick=()=>zoom(1.4);$('zoomOut').onclick=()=>zoom(1/1.4);$('fitBtn').onclick=fitCanvas;$('showCodes').onchange=draw;$('showGrid').onchange=draw;
function setView(next){view=next;$('gridView').classList.toggle('active',next==='grid');$('beadView').classList.toggle('active',next==='bead');$('showCodes').disabled=next==='bead';$('showGrid').disabled=next==='bead';draw();}
$('gridView').onclick=()=>setView('grid');$('beadView').onclick=()=>setView('bead');
function renderColorList(){const map=paletteMap(), query=$('colorSearch').value.trim().toUpperCase();const items=Object.entries(counts()).sort((a,b)=>b[1]-a[1]);$('colorList').innerHTML=items.filter(([code])=>code.toUpperCase().includes(query)).map(([code,n])=>{const color=map.get(code);return `<div class="color-row ${highlighted===code?'active':''}"><button class="color-main" data-code="${escapeHTML(code)}" aria-pressed="${highlighted===code}" title="高亮 ${escapeHTML(code)}"><span class="color-swatch" style="background:${color.hex}"></span><span><strong>${escapeHTML(code)}</strong><small>${color.hex}</small></span></button><span class="color-quantity">${n}</span><button class="replace-button" data-replace="${escapeHTML(code)}" aria-label="替换 ${escapeHTML(code)}，查看相近色">⇄</button></div>`;}).join('')||'<div class="empty-list">没有找到这个色号</div>';$('clearHighlight').hidden=!highlighted;updateColorNav();}
$('colorSearch').oninput=renderColorList;$('colorList').onclick=e=>{const main=e.target.closest('[data-code]'),replace=e.target.closest('[data-replace]');if(main){highlighted=highlighted===main.dataset.code?null:main.dataset.code;renderColorList();draw();if(highlighted) navigateColor(1,true);}if(replace)showAlternatives(replace.dataset.replace);};
$('clearHighlight').onclick=()=>{highlighted=null;$('colorSearch').value='';renderColorList();draw();};
function colorPositions(){return highlighted?pattern.cells.map((code,i)=>code===highlighted?i:-1).filter(i=>i>=0):[];}
function updateColorNav(){const positions=colorPositions();$('colorNavigator').hidden=!highlighted;if(highlighted){const at=positions.indexOf(selected);$('navText').textContent=`${highlighted} · ${at>=0?at+1:'—'} / ${positions.length} 颗`;} }
function navigateColor(direction,first=false){const positions=colorPositions();if(!positions.length)return;const at=positions.indexOf(selected);const next=first?0:(at+direction+positions.length)%positions.length;selectCell(positions[next]);updateColorNav();}
$('prevColor').onclick=()=>navigateColor(-1);$('nextColor').onclick=()=>navigateColor(1);
function showAlternatives(code){const original=paletteMap().get(code);const candidates=nearestColors(original.hex,availablePalette().filter(c=>c.code!==code),6);modal('给这颗豆，换个近似色',`<div class="modal-current"><span class="color-swatch" style="background:${original.hex}"></span><div><strong>${escapeHTML(code)}</strong><br><span>当前共 ${counts()[code]} 颗 · ${escapeHTML(palettes[paletteId].name)}</span></div></div><p>按屏幕色差从小到大排列，仅显示已勾选的店铺有货色。</p><div class="alternative-list">${candidates.map((c,i)=>`<button class="alternative" data-alternative="${escapeHTML(c.code)}"><span class="color-swatch" style="background:${c.hex}"></span><span class="alt-info"><strong>${escapeHTML(c.code)} ${i===0?'<span style="font-size:9px;color:#a99bb5;margin-left:8px">最接近</span>':''}</strong><small>${c.hex} · 色差 ΔE ${c.distance.toFixed(1)}</small></span><span class="alt-choose">替换全部 →</span></button>`).join('')||'<div class="empty-list">没有可用替代色，请在店铺库存中启用更多颜色。</div>'}</div><div class="replace-all-note">替换后同步更新图纸和清单，可以撤销。色差越小越接近，实物请对照商家色卡。</div>`,'COLOR MATCH');$('modalBody').querySelectorAll('[data-alternative]').forEach(button=>button.onclick=()=>{const replacement=button.dataset.alternative;pushUndo();const n=counts()[code];pattern.cells=replaceColor(pattern.cells,code,replacement);for(const i of [...done])if(undoStack.at(-1).pattern.cells[i]===code)done.delete(i);if(highlighted===code)highlighted=replacement;updateAll();closeModal();toast(`已将 ${n} 颗 ${code} 替换为 ${replacement}，可撤销。`);});}
$('undoBtn').onclick=async()=>{
 if(loadingImage||generationPromise)return;
 const old=undoStack.at(-1);if(!old)return;loadingImage=true;$('undoBtn').disabled=true;
 try{
  await hydrateSource(old.sourceBlob,old.sourceName);
  undoStack.pop();originalBlob=savedOriginalBlob=old.originalBlob;originalName=savedOriginalName=old.originalName;aiEdited=savedAiEdited=!!old.aiEdited;
  pattern=old.pattern;done=new Set(old.done);customPalettes=old.customPalettes;Object.assign(palettes,customPalettes);syncPaletteOptions();setPalette(old.paletteId);projectName=old.projectName;isDemo=old.isDemo;applySettings(old.settings);appliedSettings=readSettings();parametersDirty=false;highlighted=null;selected=-1;hovered=-1;updateSourceControls();updateAll();toast('已撤销上一次更改。');
 }catch(error){toast(error.message);}finally{loadingImage=false;$('undoBtn').disabled=!undoStack.length;updateSourceControls();}
};

async function loadImage(file){if(!file)return;if(generationPromise){toast('正在生成图纸，请完成后再导入。');return;}if(!/^image\/(png|jpeg|webp)$/.test(file.type)){toast('请选择 JPG、PNG 或 WEBP 图片。');return;}if(file.size>20*1024*1024){toast('图片超过 20 MB，请压缩后上传。');return;}let url;loadingImage=true;try{url=URL.createObjectURL(file);const img=new Image();img.src=url;await img.decode();if(img.width*img.height>50_000_000)throw new Error('图片尺寸过大，请先缩小到 5000 万像素以内。');if(currentProjectId&&!pendingImport)await persistCurrent();if(imageSource?.src?.startsWith('blob:'))URL.revokeObjectURL(imageSource.src);imageSource=img;sourceName=file.name;sourceBlob=file;originalBlob=file;originalName=file.name;aiEdited=false;sourceRevision++;pendingImport=true;parametersDirty=true;setSaveStatus('新图片待生成');showScreen('editor');updateSourceControls();$('sourceThumb').src=url;$('sourceName').textContent=file.name;$('sourceSize').textContent=`${img.width} × ${img.height} px`;$('sourcePreview').hidden=false;if($('keepRatio').checked)syncRatio('width');toast('图片已载入，调整参数后点击“生成拼豆图纸”。');}catch(error){if(url)URL.revokeObjectURL(url);toast(error.message||'无法读取这张图片，请更换图片。');}finally{loadingImage=false;updateSourceControls();}}
$('uploadZone').onclick=()=>$('imageFile').click();$('changeImage').onclick=()=>$('imageFile').click();$('imageFile').onchange=e=>{loadImage(e.target.files[0]);e.target.value='';};
for(const event of ['dragenter','dragover'])$('uploadZone').addEventListener(event,e=>{e.preventDefault();$('uploadZone').classList.add('dragging');});for(const event of ['dragleave','drop'])$('uploadZone').addEventListener(event,e=>{e.preventDefault();$('uploadZone').classList.remove('dragging');});$('uploadZone').addEventListener('drop',e=>loadImage(e.dataTransfer.files[0]));
function syncSizePresets(){const width=+$('gridWidth').value,height=+$('gridHeight').value;document.querySelectorAll('[data-size]').forEach(button=>button.classList.toggle('active',width===+button.dataset.size&&height===+button.dataset.size));}
function setDimensionInputs(width,height){$('gridWidth').value=width;$('gridHeight').value=height;syncSizePresets();}
function syncRatio(changed){if(!imageSource||!$('keepRatio').checked){syncSizePresets();return;}const ratio=imageSource.width/imageSource.height;const clamp=n=>Math.max(8,Math.min(160,Math.round(n)));let width=+$('gridWidth').value,height=+$('gridHeight').value;const requested=changed==='width'?width:height;if(!Number.isInteger(requested)||requested<8||requested>160){syncSizePresets();return;}if(changed==='width'){height=clamp(width/ratio);width=clamp(height*ratio);}else{width=clamp(height*ratio);height=clamp(width/ratio);}setDimensionInputs(width,height);}
$('gridWidth').onchange=()=>syncRatio('width');$('gridHeight').onchange=()=>syncRatio('height');$('keepRatio').onchange=()=>syncRatio('width');document.querySelectorAll('[data-size]').forEach(b=>b.onclick=()=>{setDimensionInputs(+b.dataset.size,+b.dataset.size);syncRatio('width');});$('maxColors').oninput=()=>$('maxColorsValue').textContent=$('maxColors').value;$('tolerance').oninput=()=>$('toleranceValue').textContent=$('tolerance').value;
function updateSourceControls(){
 $('aiOptimizeBtn').disabled=!sourceBlob||loadingImage||!!generationPromise;
 $('restoreOriginalBtn').hidden=!aiEdited||!originalBlob;
 $('aiSourceBadge').hidden=!aiEdited;
 $('sourceThumb').alt=aiEdited?'当前使用的 AI 优化图':'已上传的原图';
 $('undoBtn').title='撤销上一次图纸调整';
 const missing=!imageSource&&!isDemo&&!pendingImport;
 for(const id of ['gridWidth','gridHeight','maxColors','keepRatio','removeBackground','tolerance','generateBtn'])$(id).disabled=missing;
 document.querySelectorAll('[data-size]').forEach(b=>b.disabled=missing);
 document.querySelector('.local-note').textContent=missing?'旧图纸未附原图，可直接拼豆；上传原图后可重新调整参数。':'原图随图纸保存到本机仓库，之后可继续调整。';
}
function generate(){if(generationPromise)return generationPromise;generationPromise=runGeneration().finally(()=>{generationPromise=null;updateSourceControls();});return generationPromise;}
async function runGeneration(){
 if(loadingImage){toast('原图正在载入，请稍后再生成。');return false;}
 const settings=readSettings(),{width,height}=settings;
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<8||height<8||width>160||height>160){toast('图纸宽高请输入 8–160 的整数。');return false;}
 const available=availablePalette();if(!available.length){toast('至少选择一个店铺有货颜色。');return false;}
 if(!imageSource&&!isDemo){toast('这份旧图纸没有原图，请上传原图后调整参数。');return false;}
 const original=imageSource,workingBlob=sourceBlob,workingName=sourceName,newImport=pendingImport;
 const controls=[...document.querySelectorAll('.source-panel button,.source-panel input,.source-panel select,#saveProject,#startBeading,#navLibrary,#navEditor,#openProject,#libraryNew,#aiConfigBtn')].map(el=>[el,el.disabled]);controls.forEach(([el])=>el.disabled=true);
 $('canvasLoading').hidden=false;$('canvasLoading').textContent='正在一颗颗匹配颜色…';
 await new Promise(r=>setTimeout(r,40));
 try{
  let next;
  const off=document.createElement('canvas');off.width=width;off.height=height;const c=off.getContext('2d',{willReadFrequently:true});
  if(original){c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';if(settings.keepRatio){const scale=Math.min(width/original.width,height/original.height),dw=original.width*scale,dh=original.height*scale;c.drawImage(original,(width-dw)/2,(height-dh)/2,dw,dh);}else c.drawImage(original,0,0,width,height);next=generatePattern(c.getImageData(0,0,width,height),width,height,available,{maxColors:settings.maxColors,removeBackground:settings.removeBackground,backgroundTolerance:settings.backgroundTolerance});}
  else{const demo=makeDemo(width,height,available),m=new Map(available.map(a=>[a.code,a]));demo.cells.forEach((code,i)=>{if(code){c.fillStyle=m.get(code).hex;c.fillRect(i%width,Math.floor(i/width),1,1);}});next=generatePattern(c.getImageData(0,0,width,height),width,height,available,{maxColors:settings.maxColors});}
  if(newImport){currentProjectId=null;currentCreatedAt=null;undoStack=[];$('undoBtn').disabled=true;}else pushUndo();
  pattern=next;if(newImport||!currentProjectId)projectName=original?workingName.replace(/\.[^.]+$/,'').slice(0,60)||'我的拼豆图纸':'小狐狸的午后';isDemo=!original;
  savedSourceBlob=workingBlob;savedSourceName=workingName;savedOriginalBlob=originalBlob;savedOriginalName=originalName;savedAiEdited=aiEdited;activeDraft=true;pendingImport=false;parametersDirty=false;appliedSettings=settings;applySettings(settings);
  done=new Set();selected=-1;hovered=-1;highlighted=null;setView('grid');updateAll(true);await persistCurrent();toast(total()?`已保存图纸：${total()} 颗豆，${Object.keys(counts()).length} 种颜色。`:'图纸为空，可关闭“去除纯色背景”后重试。');return true;
 }catch(e){toast('生成或保存失败：'+e.message);return false;}
 finally{controls.forEach(([el,disabled])=>el.disabled=disabled);$('canvasLoading').hidden=true;updateSourceControls();}
}
$('generateBtn').onclick=generate;
$('loadDemo').onclick=async()=>{try{if(currentProjectId&&!pendingImport)await persistCurrent();}catch{return;}currentProjectId=null;currentCreatedAt=null;undoStack=[];$('undoBtn').disabled=true;if(imageSource?.src?.startsWith('blob:'))URL.revokeObjectURL(imageSource.src);imageSource=null;sourceName='';sourceBlob=null;savedSourceBlob=null;savedSourceName='';originalBlob=savedOriginalBlob=null;originalName=savedOriginalName='';aiEdited=savedAiEdited=false;sourceRevision++;activeDraft=true;pendingImport=false;parametersDirty=false;isDemo=true;projectName='小狐狸的午后';$('sourcePreview').hidden=true;pattern=makeDemo(52,52,availablePalette().length?availablePalette():activePalette);setDimensionInputs(52,52);appliedSettings=readSettings();done=new Set();highlighted=null;selected=-1;hovered=-1;updateAll(true);showScreen('editor');await persistCurrent().catch(()=>{});toast('已新建小狐狸示例图纸。');};
$('paletteSelect').onchange=()=>{const next=$('paletteSelect').value, oldMap=paletteMap();pushUndo();setPalette(next);const avail=availablePalette();const replacements=new Map();for(const code of Object.keys(counts()))replacements.set(code,nearestColors(oldMap.get(code).hex,avail.length?avail:activePalette,1)[0].code);pattern.cells=pattern.cells.map(c=>c===null?null:replacements.get(c));done=new Set();highlighted=null;updateAll();toast('已按新色卡匹配图纸，数量保持不变。');};

$('inventoryBtn').onclick=()=>{const staged=new Set(exclusions[paletteId]||[]);modal('哪些颜色，店里有货？',`<p>点击色块切换库存。灰色表示缺货；生成图纸与替代色推荐将只使用有货色。</p><div class="inventory-controls"><input id="inventorySearch" placeholder="搜索色号" aria-label="搜索库存色号"><button id="inventoryAll" class="text-button">全部有货</button><button id="inventoryNone" class="text-button">全部缺货</button></div><div id="inventoryGrid" class="inventory-grid"></div><div class="modal-buttons"><button class="button quiet" id="inventoryCancel">取消</button><button class="button primary" id="inventoryApply">保存库存</button></div>`,'YOUR COLOR COLLECTION');function render(){const q=$('inventorySearch').value.trim().toUpperCase();$('inventoryGrid').innerHTML=activePalette.filter(c=>c.code.toUpperCase().includes(q)).map(c=>`<button class="inventory-item ${staged.has(c.code)?'unavailable':''}" data-inventory="${escapeHTML(c.code)}" aria-pressed="${!staged.has(c.code)}" title="${escapeHTML(c.code)} ${staged.has(c.code)?'缺货':'有货'}"><span class="swatch" style="background:${c.hex}"></span><span>${escapeHTML(c.code)}</span></button>`).join('');}$('inventorySearch').oninput=render;$('inventoryGrid').onclick=e=>{const b=e.target.closest('[data-inventory]');if(!b)return;const code=b.dataset.inventory;if(staged.has(code))staged.delete(code);else staged.add(code);render();};$('inventoryAll').onclick=()=>{staged.clear();render();};$('inventoryNone').onclick=()=>{activePalette.forEach(c=>staged.add(c.code));render();};$('inventoryCancel').onclick=closeModal;$('inventoryApply').onclick=()=>{if(staged.size===activePalette.length){toast('请至少保留一种有货颜色。');return;}exclusions[paletteId]=[...staged];updateAvailable();saveSoon();closeModal();toast('库存已保存。重新生成或手动替色后，现有图纸才会改变。');};render();};
$('importPalette').onclick=()=>{modal('让图纸适配你常买的店',`<p>导入店铺色卡后，网站会用该店的真实色号匹配图片。支持 CSV 或 JSON，最多 1000 色。</p><h3>CSV 格式示例</h3><div class="import-format">code,hex,name\nS01,#FFFFFF,白色\nS02,#242424,黑色\nS03,#E49B60,橘色</div><p>上方 S01 等仅示范文件格式，不是品牌色号。颜色须为六位 HEX，例如 #FFFFFF；色名可省略。</p><div class="modal-buttons"><button id="paletteTemplate" class="button quiet">下载示例模板</button><button id="choosePalette" class="button primary">选择 CSV / JSON</button></div>`,'YOUR PALETTE');$('paletteTemplate').onclick=()=>downloadText('店铺色卡-格式模板.csv','code,hex,name\nS01,#FFFFFF,白色\nS02,#242424,黑色\nS03,#E49B60,橘色','text/csv;charset=utf-8',true);$('choosePalette').onclick=()=>$('paletteFile').click();};
$('paletteFile').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{if(file.size>1024*1024)throw new Error('色卡文件请控制在 1 MB 以内。');const imported=parsePalette(await file.text(),file.name);const id='custom-'+Date.now().toString(36);pushUndo();const oldMap=paletteMap();customPalettes[id]=imported;palettes[id]=imported;syncPaletteOptions();setPalette(id);const replacements=new Map(Object.keys(counts()).map(code=>[code,nearestColors(oldMap.get(code).hex,activePalette,1)[0].code]));pattern.cells=pattern.cells.map(c=>c===null?null:replacements.get(c));done=new Set();highlighted=null;updateAll();closeModal();toast(`已导入 ${imported.colors.length} 色，当前图纸已匹配到新色卡。`);}catch(error){toast(error.message);}};

function downloadBlob(filename,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}
function downloadText(filename,text,type='text/plain;charset=utf-8',bom=false){downloadBlob(filename,new Blob([bom?'\ufeff':'',text],{type}));}
function safeName(){return projectName.replace(/[\\/:*?"<>|]/g,'_')||'拼豆图纸';}
function csvCell(value){const s=String(value);return '"'+s.replace(/"/g,'""')+'"';}
function exportList(){const map=paletteMap();const rows=[['色卡','色号','HEX','用豆数量'],...Object.entries(counts()).sort((a,b)=>b[1]-a[1]).map(([code,n])=>[palettes[paletteId].name,code,map.get(code).hex,n])];downloadText(safeName()+'-用色清单.csv',rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8',true);toast('用色清单已导出。');}
$('downloadList').onclick=exportList;
function exportPositions(){const rows=[['X列','Y行','色号','已拼']];pattern.cells.forEach((code,i)=>{if(code!==null)rows.push([i%pattern.width+1,Math.floor(i/pattern.width)+1,code,done.has(i)?'是':'否']);});downloadText(safeName()+'-逐颗坐标.csv',rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8',true);toast('逐颗坐标已导出，左上角为 (1,1)。');}
async function exportPNG(){toast('正在绘制高清图纸…');await new Promise(r=>setTimeout(r,30));const unit=32,pad=58,top=112,gridW=pattern.width*unit,gridH=pattern.height*unit;const colors=Object.entries(counts()).sort((a,b)=>b[1]-a[1]);const width=Math.max(800,gridW+pad*2),columns=Math.max(3,Math.floor((width-pad*2)/190));const legendRows=Math.ceil(colors.length/columns);const height=top+gridH+104+legendRows*45+65;const off=document.createElement('canvas');off.width=width;off.height=height;const c=off.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,width,height);c.fillStyle='#43374e';c.font='bold 28px sans-serif';c.fillText(projectName.slice(0,30),pad,44,width-pad*2);c.font='15px sans-serif';c.fillStyle='#8e7b9c';c.fillText(`${pattern.width} × ${pattern.height}  |  ${total()} 颗  |  ${colors.length} 色  |  ${palettes[paletteId].name}`,pad,77,width-pad*2);const map=paletteMap();pattern.cells.forEach((code,i)=>{if(code===null)return;const x=pad+i%pattern.width*unit,y=top+Math.floor(i/pattern.width)*unit;const color=map.get(code);c.fillStyle=color.hex;c.fillRect(x,y,unit,unit);c.fillStyle=contrast(color.hex);c.font='bold 10px sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillText(code,x+unit/2,y+unit/2,unit-3);});c.strokeStyle='#dad5df';c.lineWidth=.5;c.beginPath();for(let x=0;x<=pattern.width;x++){c.moveTo(pad+x*unit,top);c.lineTo(pad+x*unit,top+gridH);}for(let y=0;y<=pattern.height;y++){c.moveTo(pad,top+y*unit);c.lineTo(pad+gridW,top+y*unit);}c.stroke();c.strokeStyle='#af819b';c.lineWidth=1.4;c.beginPath();for(let x=10;x<pattern.width;x+=10){c.moveTo(pad+x*unit,top);c.lineTo(pad+x*unit,top+gridH);}for(let y=10;y<pattern.height;y+=10){c.moveTo(pad,top+y*unit);c.lineTo(pad+gridW,top+y*unit);}c.stroke();c.strokeStyle='#a497ad';c.strokeRect(pad,top,gridW,gridH);c.fillStyle='#897792';c.font='11px sans-serif';c.textAlign='center';c.textBaseline='middle';for(let x=0;x<pattern.width;x++){c.fillText(x+1,pad+(x+.5)*unit,top-17);c.fillText(x+1,pad+(x+.5)*unit,top+gridH+18);}for(let y=0;y<pattern.height;y++){c.fillText(y+1,pad-21,top+(y+.5)*unit);c.fillText(y+1,pad+gridW+21,top+(y+.5)*unit);}const legendTop=top+gridH+64;c.textAlign='left';c.fillStyle='#43374e';c.font='bold 20px sans-serif';c.fillText('用色统计',pad,legendTop);colors.forEach(([code,n],i)=>{const x=pad+(i%columns)*190,y=legendTop+38+Math.floor(i/columns)*45;c.fillStyle=map.get(code).hex;c.fillRect(x,y-12,24,24);c.strokeStyle='#ddd';c.lineWidth=1;c.strokeRect(x,y-12,24,24);c.fillStyle='#66546f';c.font='16px sans-serif';c.fillText(`${code} × ${n}`,x+35,y);});c.font='12px sans-serif';c.fillStyle='#a194a9';c.fillText('豆豆工坊 · X 为列，Y 为行，左上角 (1,1) · 屏幕色仅供参考，实物请以商家色卡为准。',pad,height-25,width-pad*2);off.toBlob(blob=>{if(!blob){toast('导出失败，请尝试较小尺寸。');return;}downloadBlob(safeName()+'-拼豆图纸.png',blob);toast('高清图纸已导出，含色号、逐行列坐标和用色统计。');},'image/png');}
$('exportBtn').onclick=()=>{modal('把灵感带到拼豆桌上',`<button class="export-option" id="exportPng"><span>▧</span><div><strong>高清 PNG 图纸</strong><small>每格色号 · 四边坐标 · 10 格辅助线 · 用色统计</small></div><span>↓</span></button><button class="export-option" id="exportCsv"><span>▤</span><div><strong>用色清单 CSV</strong><small>色卡、色号、颜色与用量，方便备豆</small></div><span>↓</span></button><button class="export-option" id="exportCoords"><span>⌖</span><div><strong>逐颗坐标 CSV</strong><small>每颗豆的 X 列、Y 行、色号和完成状态</small></div><span>↓</span></button><button class="export-option" id="exportBackup"><span>▣</span><div><strong>图纸备份 JSON</strong><small>色卡、图纸、参数与进度 · 不含原图</small></div><span>↓</span></button><p style="font-size:10px">导出为完整图纸，不受当前高亮或缩放影响。仓库保留原图与编辑参数。下方 JSON 备份保留色卡和进度，不含原图。</p>`,'TAKE YOUR PATTERN');$('exportPng').onclick=()=>{closeModal();exportPNG();};$('exportCsv').onclick=exportList;$('exportCoords').onclick=exportPositions;$('exportBackup').onclick=()=>downloadText(safeName()+'.beads.json',JSON.stringify(serializable(),null,2),'application/json');};
$('saveProject').onclick=async()=>{if(await ensureGenerated()){activeDraft=true;await persistCurrent(true).catch(()=>{});}};
$('openProject').onclick=()=>$('projectFile').click();
$('projectFile').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{if(file.size>5*1024*1024)throw new Error('图纸文件请控制在 5 MB 以内。');const data=JSON.parse(await file.text());validateProject(data);if(currentProjectId&&!pendingImport)await persistCurrent();suppressSaving=true;currentProjectId=null;currentCreatedAt=null;sourceBlob=null;savedSourceBlob=null;savedSourceName='';originalBlob=savedOriginalBlob=null;originalName=savedOriginalName='';aiEdited=savedAiEdited=false;sourceRevision++;activeDraft=true;pendingImport=false;restoreProject(data);undoStack=[];$('undoBtn').disabled=true;suppressSaving=false;showScreen('editor');await persistCurrent();toast('图纸已导入仓库。此文件不含原图，参数重生成需上传原图。');}catch(error){suppressSaving=false;toast('打开失败：'+error.message);}};
$('sourceInfo').onclick=()=>modal('可追溯的色卡，安心选色',`<p>内置 MARD 291 色和 221 色来自开源社区整理的拼豆色卡数据，保留原有色号与 RGB。显示时会补齐数字位数，例如 H7 → H07。</p><p>这是屏幕参考色卡，并非品牌官方实测标准。显示器、拍摄和实物批次都会影响颜色，替代色的选择请结合商家实物色卡。</p><p><a class="footer-link" href="https://github.com/HansBug/pindou-color-data/tree/main/mard-291-github" target="_blank" rel="noopener">查看原始数据 ↗</a> · <a class="footer-link" href="./palette-LICENSE.txt" target="_blank">MIT 数据许可 ↗</a></p><div class="notice-box">通用版支持导入其他品牌或店铺色卡。不同品牌的同一编号可能代表不同颜色，请确认所选色卡再购买。</div>`,'COLOR DATA');
$('helpBtn').onclick=()=>modal('从图片，到一颗颗拼好',`<ol><li><b>上传图片：</b>选择 PNG、JPG 或 WEBP。主体清晰、背景简单的图片更适合，透明 PNG 可以直接保留空白区域。</li><li><b>AI 优化（可选）：</b>先在 AI 配置里填写图片编辑接口、模型和密钥。上传照片后可转拼豆插画、简化背景或按文字微调；对比满意后采用。原图会保留，随时可恢复。</li><li><b>调整参数：</b>尺寸决定横纵各有多少颗豆；颜色越少越容易备豆。纯色背景可尝试勾选去除。</li><li><b>选择色卡：</b>内置 MARD 参考色卡，也能导入店铺色卡。库存中关闭缺货颜色，生成时会避开它们。</li><li><b>查看与替色：</b>点击清单色号高亮对应豆子，左右箭头逐颗查看；⇄ 可选择相近色，一键替换并更新数量。</li><li><b>快速定位：</b>X 是列，Y 是行，从左上角 (1,1) 开始。输入坐标直接定位，或点击图纸锁定。聚焦图纸后用方向键移动，空格标记已拼。</li><li><b>导出与保存：</b>PNG 图纸适合打印或平板查看，CSV 用于备料与核对。保存到仓库会保留原图、参数和进度，之后可继续编辑。</li></ol><div class="notice-box">放大后显示每格色号；每 10 格有辅助线。普通制图在本机浏览器处理；仅主动使用 AI 时，图片会发送到你配置的服务。图纸仓库保存于此浏览器，含本次导入的原图。开始拼豆进入简洁模式，点击图上豆子或颜色清单可高亮同色。下载的 JSON 备份不含原图。</div>`,'A LITTLE GUIDE');


function showScreen(next){screen=next;updateSourceControls();document.body.dataset.screen=next;$('navLibrary').classList.toggle('nav-active',next==='library');$('navEditor').classList.toggle('nav-active',next==='editor');$('navLibrary').setAttribute('aria-current',next==='library'?'page':'false');$('navEditor').setAttribute('aria-current',next==='editor'?'page':'false');if(next==='library')renderLibrary();else{if(next==='beading'){view='grid';$('showCodes').checked=true;$('showGrid').checked=true;setView('grid');}renderColorList();requestAnimationFrame(fitCanvas);}window.scrollTo({top:0,behavior:'instant'});}
function renderLibrary(){
 const query=$('librarySearch').value.trim().toLowerCase(),sort=$('librarySort').value;
 const entries=libraryEntries.filter(p=>p.name.toLowerCase().includes(query)).sort(sort==='name'?(a,b)=>a.name.localeCompare(b.name,'zh-CN'):(a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 $('libraryCount').textContent=libraryEntries.length;$('libraryTotalBeads').textContent=libraryEntries.reduce((n,p)=>n+p.totalBeads,0).toLocaleString();$('libraryInProgress').textContent=libraryEntries.filter(p=>p.doneCount>0&&p.doneCount<p.totalBeads).length;
 $('libraryGrid').innerHTML=entries.map(p=>{const percent=p.totalBeads?Math.round(p.doneCount/p.totalBeads*100):0;return `<article class="library-card"><button class="library-preview" data-edit="${escapeHTML(p.id)}" aria-label="编辑图纸 ${escapeHTML(p.name)}"><img src="${escapeHTML(p.thumbnail)}" alt="${escapeHTML(p.name)}的拼豆图纸" loading="lazy"><span class="library-card-badge">${p.width} × ${p.height}</span></button><div class="library-card-body"><h3>${escapeHTML(p.name)}</h3><div class="library-card-meta"><span>${p.totalBeads.toLocaleString()} 颗豆</span><span>${p.colorCount} 色</span><span>${p.hasSource?'原图已保存':p.isDemo?'可调整示例':'仅图纸'}</span></div><div class="library-card-progress"><span style="width:${percent}%"></span></div><div class="library-card-meta"><span>${p.doneCount?`已拼 ${p.doneCount} / ${p.totalBeads}`:'等待开拼'}</span><span>${new Date(p.updatedAt).toLocaleDateString('zh-CN')}</span></div><div class="library-card-footer"><button class="button quiet library-edit" data-edit="${escapeHTML(p.id)}">编辑参数</button><button class="button primary library-start" data-start="${escapeHTML(p.id)}">开始拼豆 →</button></div><div class="library-manage-row"><button class="rename-project" data-rename="${escapeHTML(p.id)}" aria-label="重命名 ${escapeHTML(p.name)}">重命名</button><button class="delete-project" data-delete="${escapeHTML(p.id)}" aria-label="删除 ${escapeHTML(p.name)}">删除</button></div></div></article>`;}).join('')||`<div class="library-empty"><span>▦</span><h3>${query?'没有找到这份图纸':'把第一张灵感放进仓库'}</h3><p>${query?'试试其他名称。':'上传图片并生成图纸后，会自动保存到这里。'}</p></div>`;
}
async function hydrateSource(blob,name,{commit=true}={}){
 let img=null,url=null;
 if(blob){url=URL.createObjectURL(blob);img=new Image();try{img.src=url;await img.decode();if(img.width*img.height>50_000_000)throw new Error();}catch{URL.revokeObjectURL(url);throw new Error('图片无法读取或尺寸过大，请重新选择。');}}
 if(imageSource?.src?.startsWith('blob:'))URL.revokeObjectURL(imageSource.src);
 imageSource=img;sourceBlob=blob;sourceName=name||'';sourceRevision++;
 if(commit){savedSourceBlob=blob;savedSourceName=sourceName;}
 $('sourcePreview').hidden=!img;
 if(img){$('sourceThumb').src=url;$('sourceName').textContent=sourceName||'保存的图片';$('sourceSize').textContent=`${img.width} × ${img.height} px`;}
 else $('sourceThumb').removeAttribute('src');
}
async function useWorkingSource(blob,name,edited){
 if(loadingImage||generationPromise)return false;
 const before={drawing:snapshot(),sourceBlob,sourceName,originalBlob,originalName,aiEdited,pendingImport,parametersDirty,activeDraft,currentProjectId,currentCreatedAt,sourceRevision,settings:readSettings(),undo:[...undoStack]};
 try{loadingImage=true;await hydrateSource(blob,name,{commit:false});aiEdited=edited;parametersDirty=true;updateSourceControls();if($('keepRatio').checked)syncRatio('width');}
 catch(error){toast(error.message);return false;}finally{loadingImage=false;updateSourceControls();}
 const accepted=await generate();if(accepted)return true;
 // Adoption is all-or-nothing: a failed generation/save must leave the preview optional.
 suppressSaving=true;clearTimeout(saveTimer);
 try{
  await hydrateSource(before.sourceBlob,before.sourceName,{commit:false});
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
 if(openingProject)return;openingProject=true;clearTimeout(saveTimer);
 try{await writeQueue.catch(()=>{});const record=await getProject(id);if(!record)throw new Error('这份图纸暂时无法找到。');validateProject(record.project);suppressSaving=true;pendingImport=false;parametersDirty=false;restoreProject(record.project);currentProjectId=record.id;currentCreatedAt=record.createdAt;await hydrateSource(record.sourceBlob,record.sourceName);originalBlob=savedOriginalBlob=record.originalBlob;originalName=savedOriginalName=record.originalName;aiEdited=savedAiEdited=!!record.project.aiEdited;activeDraft=true;undoStack=[];$('undoBtn').disabled=true;$('colorSearch').value='';suppressSaving=false;setSaveStatus('已保存到本机仓库');showScreen(next);}
 catch(e){suppressSaving=false;toast(e.message);}finally{openingProject=false;}
}
async function ensureGenerated(){if(loadingImage){toast('原图正在载入，请稍后。');return false;}if(parametersDirty&&!pendingImport&&!imageSource&&!isDemo){applySettings(appliedSettings);parametersDirty=false;toast('此旧图纸未附原图，已保留原有参数，可继续拼豆。');}if(pendingImport||parametersDirty)return await generate();return !!pattern;}
async function goLibrary(){if(!(await ensureGenerated()))return;try{await persistCurrent();showScreen('library');}catch{}}
async function startBeading(){if(!(await ensureGenerated()))return;activeDraft=true;if(!total()){toast('图纸还没有豆子，请调整参数后重新生成。');return;}try{await persistCurrent();highlighted=null;$('colorSearch').value='';showScreen('beading');}catch{}}
$('navLibrary').onclick=goLibrary;$('focusLibrary').onclick=goLibrary;
$('navEditor').onclick=()=>showScreen('editor');$('exitBeading').onclick=()=>showScreen('editor');$('startBeading').onclick=startBeading;
document.querySelector('.brand').onclick=e=>{e.preventDefault();goLibrary();};
$('libraryNew').onclick=()=>{$('imageFile').click();};
$('librarySearch').oninput=renderLibrary;$('librarySort').onchange=renderLibrary;
$('libraryGrid').onclick=e=>{
 if(libraryMutation||openingProject)return;
 const rename=e.target.closest('[data-rename]'),remove=e.target.closest('[data-delete]'),edit=e.target.closest('[data-edit]'),start=e.target.closest('[data-start]');
 if(rename)showRename(rename.dataset.rename);else if(remove)showDelete(remove.dataset.delete);else if(edit)openSavedProject(edit.dataset.edit,'editor');else if(start)openSavedProject(start.dataset.start,'beading');
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
 modal('确认删除这份图纸？',`<div class="confirm-project-thumb"><img src="${escapeHTML(entry.thumbnail)}" alt="待删除图纸预览"><div><strong>${escapeHTML(entry.name)}</strong><p>${entry.width} × ${entry.height} · ${entry.totalBeads.toLocaleString()} 颗豆</p></div></div><p>将从本机仓库删除这份图纸、保存的图片、参数和拼豆进度。此操作无法撤销，请确认名称后再删除。</p><p id="deleteError" class="ai-error-line" role="alert" hidden></p><div class="modal-buttons"><button class="button quiet" id="deleteCancel" autofocus>取消，保留图纸</button><button class="button danger-button" id="deleteConfirm">确认删除</button></div>`,'DELETE DRAWING');
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
for(const id of ['gridWidth','gridHeight','maxColors','keepRatio','removeBackground','tolerance'])$(id).addEventListener('change',markParametersDirty);
$('gridWidth').addEventListener('input',()=>{syncRatio('width');markParametersDirty();});$('gridHeight').addEventListener('input',()=>{syncRatio('height');markParametersDirty();});
document.querySelectorAll('[data-size]').forEach(b=>b.addEventListener('click',markParametersDirty));
window.addEventListener('pagehide',()=>{if(!pendingImport&&!suppressSaving)persistCurrent().catch(()=>{});});
async function init(){try{
 const response=await fetch('./palette.json');if(!response.ok)throw new Error('色卡文件读取失败');basePalette=await response.json();palettes={mard:{name:'MARD · 291 色参考色卡',colors:basePalette.colors},mard221:{name:'MARD · 221 色参考色卡',colors:basePalette.colors.filter(c=>c.basic221)}};syncPaletteOptions();setPalette('mard');
 try{await openLibrary();libraryReady=true;libraryEntries=await listProjects();}catch(error){$('libraryStatus').textContent=error.message+'。可以继续编辑并导出备份，但本机仓库暂不可用。';toast(error.message);}
 let restored=false;if(libraryEntries.length){await openSavedProject([...libraryEntries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0].id,'library');restored=!!pattern;}
 if(!restored){try{const raw=localStorage.getItem(STORAGE_KEY);if(raw&&!localStorage.getItem(INITIALIZED_KEY)){restoreProject(JSON.parse(raw));restored=true;}}catch{}}
 if(!restored){try{activeDraft=!localStorage.getItem(INITIALIZED_KEY);}catch{}pattern=makeDemo(52,52,activePalette);appliedSettings=readSettings();updateAll(true);}
 suppressSaving=false;if(!currentProjectId&&libraryReady&&activeDraft)await persistCurrent();$('canvasLoading').hidden=true;showScreen('library');
 let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(screen!=='library'&&Math.abs(cellSize-fitSize)<.1)fitCanvas();},100);}).observe($('canvasArea'));
}catch(e){$('canvasLoading').textContent='载入失败，请刷新页面重试。';$('libraryStatus').textContent='载入失败：'+e.message;toast(e.message);}}
init();
