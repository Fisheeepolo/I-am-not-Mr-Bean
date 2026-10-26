"""Create honest tables, actual pattern gallery and Pareto plot from all results."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,base64,io,html,statistics,math,csv
ROOT=Path(__file__).parent;RESULTS=ROOT/'results'
fixtures=json.loads((ROOT/'fixtures.json').read_text('utf8'));by_id={f['id']:f for f in fixtures}
sets=[s for s in ['development','heldout'] if (RESULTS/f'{s}.json').exists()]
runs={s:json.loads((RESULTS/f'{s}.json').read_text('utf8')) for s in sets}
rows=[r for run in runs.values() for r in run['rows']]
fields=[k for k in rows[0] if k not in ['markerDetails','timesMs']]
with (RESULTS/'main-metrics.csv').open('w',encoding='utf-8-sig',newline='') as file:
    writer=csv.DictWriter(file,fieldnames=fields,extrasaction='ignore');writer.writeheader();writer.writerows(rows)
raws={s:json.loads((RESULTS/f'{s}-raw.json').read_text('utf8')) for s in sets}
raw_rows={(r['fixture'],r['maxColors'],r['method']):r for run in raws.values() for r in run['rows']}
palette=next(iter(raws.values()))['palette'];col={p['code']:tuple(int(p['hex'][i:i+2],16) for i in (1,3,5)) for p in palette}
names=dict(v3='v3基线',full='v4完整',noSaliency='无显著性取样',noAbstraction='无预抽象',noDefocus='无散焦调制',noSpatial='无空间项',noIslands='无孤岛项',noMicroProtection='无微特征保护',lab76='Lab76选色')
def mean(rs,k):
    v=[r[k] for r in rs if r.get(k) is not None];return statistics.mean(v) if v else None
def fmt(v,d=3):return '—' if v is None else f'{v:.{d}f}'
def pct(v):return '—' if v is None else f'{100*v:.2f}%'
def summary(rs):
    return dict(n=len(rs),**{k:mean(rs,k) for k in ['meanDeltaE2000','saliencyWeightedDeltaE2000','edgeExactF1','edgeTol1F1','speckleRatio','nonExemptSpeckleRatio','compactnessAreaWeighted','rowTransitions','medianMs','usedColors']},
      specklePassed=sum(r['speckleBelow005'] for r in rs),markersPreserved=sum(r['markersPreserved'] for r in rs),markersTotal=sum(r['markersTotal'] for r in rs))
summaries=[]
for split in sets:
    for kind in ['all','photo','synthetic']:
        for k in [12,18,24]:
            for method in names:
                rr=[r for r in rows if r['split']==split and (kind=='all' or r['kind']==kind) and r['maxColors']==k and r['method']==method]
                if rr:summaries.append(dict(split=split,kind=kind,K=k,method=method,**summary(rr)))
(RESULTS/'summary.json').write_text(json.dumps(dict(aggregation='Unweighted arithmetic mean of per-image metrics; count-based tiny ratios remain per-image. ROI types never mixed into a semantic claim.',groups=summaries),ensure_ascii=False,indent=2)+'\n',encoding='utf8')
fronts=[]
ablation_rows=[]
delta_fields=['meanDeltaE2000','saliencyWeightedDeltaE2000','edgeExactF1','edgeTol1F1','speckleRatio','nonExemptSpeckleRatio','compactnessAreaWeighted','rowTransitions','medianMs','markersPreserved']
for split in sets:
    for kind in ['all','photo','synthetic']:
        rr=[r for r in rows if r['split']==split and r['maxColors']==18 and (kind=='all' or r['kind']==kind)]
        full={r['fixture']:r for r in rr if r['method']=='full'}
        for method in names:
            if method in ['v3','full']:continue
            variants=[r for r in rr if r['method']==method]
            if not variants:continue
            item=dict(split=split,kind=kind,K=18,variant=method,n=len(variants),deltaDefinition='variant minus full; positive error/speckle worse, positive F1 better')
            for field in delta_fields:item['delta_'+field]=statistics.mean(r[field]-full[r['fixture']][field] for r in variants)
            ablation_rows.append(item)
with (RESULTS/'ablation-summary.csv').open('w',encoding='utf-8-sig',newline='') as file:
    writer=csv.DictWriter(file,fieldnames=list(ablation_rows[0]));writer.writeheader();writer.writerows(ablation_rows)
for f in fixtures:
    candidates=[r for r in rows if r['fixture']==f['id'] and r['method'] in ['v3','full']]
    if not candidates:continue
    frontier=[]
    for a in candidates:
        def dominates(b):
            va=[a['meanDeltaE2000'],a['speckleRatio'],-a['edgeTol1F1']];vb=[b['meanDeltaE2000'],b['speckleRatio'],-b['edgeTol1F1']]
            return all(y<=x+1e-12 for x,y in zip(va,vb)) and any(y<x-1e-12 for x,y in zip(va,vb))
        if not any(dominates(b) for b in candidates):frontier.append(dict(method=a['method'],K=a['maxColors'],meanDeltaE2000=a['meanDeltaE2000'],speckleRatio=a['speckleRatio'],edgeTol1F1=a['edgeTol1F1']))
    fronts.append(dict(fixture=f['id'],frontier=frontier))
(RESULTS/'pareto-fronts.json').write_text(json.dumps(dict(criteria=['min meanDeltaE2000','min raw speckleRatio','max edgeTol1F1'],note='Per input only, among v3/full K12/18/24; no cross-image dominance or global-optimum claim.',fixtures=fronts),ensure_ascii=False,indent=2)+'\n',encoding='utf8')

text=['# 内容自适应v4：实际运行结果','',f'当前数据：{len(rows)}条主评测，组别：'+', '.join(sets)+'。所有数据来自实际pure pipeline输出。','',
 '指标方向：色差/碎片/耗时通常较低更好，边缘F1较高更好；有用眼睛和高光也会计入原始碎片。边缘为固定Canny自动参考，区域为真实合成mask或明确照片ROI代理。均值按图像等权，不能外推用户总体。','',
 '## K18主结果','', '|组别|类别|方法|ΔE00|显著性加权ΔE00|F1精确|F1容差1豆|原始碎片率|<0.5%|特征保留|中位耗时均值ms|','|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
for s in summaries:
    if s['K']!=18:continue
    text.append(f'|{s["split"]}|{s["kind"]}|{names[s["method"]]}|{fmt(s["meanDeltaE2000"])}|{fmt(s["saliencyWeightedDeltaE2000"])}|{fmt(s["edgeExactF1"])}|{fmt(s["edgeTol1F1"])}|{pct(s["speckleRatio"])}|{s["specklePassed"]}/{s["n"]}|{s["markersPreserved"]}/{s["markersTotal"]}|{fmt(s["medianMs"],1)}|')
text+=['','## 每张图的主要得失（K18）','','|图像|ΔE00 v3→v4|F1容差 v3→v4|原始碎片率 v3→v4|v4<0.5%|指定特征 v3→v4|','|---|---:|---:|---:|---|---:|']
for f in fixtures:
    rr={r['method']:r for r in rows if r['fixture']==f['id'] and r['maxColors']==18}
    if 'full' not in rr:continue
    a,b=rr['v3'],rr['full'];text.append(f'|{f["title"]} ({f["split"]})|{fmt(a["meanDeltaE2000"])}→{fmt(b["meanDeltaE2000"])}|{fmt(a["edgeTol1F1"])}→{fmt(b["edgeTol1F1"])}|{pct(a["speckleRatio"])}→{pct(b["speckleRatio"])}|{"达到" if b["speckleBelow005"] else "未达到"}|{a["markersPreserved"]}/{a["markersTotal"]}→{b["markersPreserved"]}/{b["markersTotal"]}|')
text+=['','## 区域显著性加权色差（K18）','','每个值均按同一原图固定W_ref求加权平均；照片的区域只叫ROI，不能改称精确主体。哈勃与草地无mask/ROI，明确不可用。','', '|图像|区域依据|区域 v3→v4|补集 v3→v4|','|---|---|---:|---:|']
for f in fixtures:
    rr={r['method']:r for r in rows if r['fixture']==f['id'] and r['maxColors']==18}
    if 'full' not in rr:continue
    a,b=rr['v3'],rr['full'];text.append(f'|{f["title"]}|{f["regionType"]}|{fmt(a["regionSaliencyWeightedDeltaE2000"])}→{fmt(b["regionSaliencyWeightedDeltaE2000"])}|{fmt(a["complementSaliencyWeightedDeltaE2000"])}→{fmt(b["complementSaliencyWeightedDeltaE2000"])}|')
text+=['','## 颜色预算取舍','','|组别|类别|K|方法|ΔE00|F1容差1豆|原始碎片率|实际用色均值|耗时ms|','|---|---|---:|---|---:|---:|---:|---:|---:|']
for s in summaries:
    if s['method'] not in ['v3','full']:continue
    text.append(f'|{s["split"]}|{s["kind"]}|{s["K"]}|{names[s["method"]]}|{fmt(s["meanDeltaE2000"])}|{fmt(s["edgeTol1F1"])}|{pct(s["speckleRatio"])}|{fmt(s["usedColors"],1)}|{fmt(s["medianMs"],1)}|')
text+=['','## Pareto取舍（每张图单独比较）','','以下非支配集合只在同一输入的v3/full与K12/18/24六种实际输出之间比较，三个方向为色差低、原始碎片低、F1容差高；不代表所有可能算法的最优解，也不跨图建立支配关系。','']
for f in fronts:text.append('- '+by_id[f['fixture']]['title']+'：'+', '.join(names[r['method']]+' K'+str(r['K']) for r in f['frontier']))
text+=['','## 自动边缘指标的失败边界','','Canny参考可能完全看不到低反差1–2豆细节。当参考和输出均无边时F1按预定约定为1；这可使擦掉真实小特征的输出获得更高F1。因此全图F1平均必须结合指定特征保留率、源图和区域色差，不能单独称为结构保真提升。此约定和固定阈值没有根据结果修改。','', '## 报告边界','','本实验没有人工辨认度评分、照片语义真值、真实散焦图、实体拼豆用户研究或随机代表性采样。15张图和合成回归只支撑当前实现的工程比较。原始碎片目标与保留小细节可能冲突，不能用过滤后的碎片率宣称达到原目标。显著性参考固定来自原图，不随待测方法改变；其中DoG仍是启发式proxy。所有负结果都保留在表格和逐格对照中。','']
white_file=RESULTS/'white-regression.json'
if white_file.exists():
    wr=json.loads(white_file.read_text('utf8'))['rows'];text+=['','## 16例白色安全回归（全部已见）','','|算法|去除外部底色|白色前景误删|全部前景误删|背景残留|相对v3占位变化格|','|---|---|---:|---:|---:|---:|']
    for mode in [False,True]:
        for method in ['v3','full']:
            rr=[r for r in wr if r['removeBackground']==mode and r['method']==method]
            values={k:sum(r[k] for r in rr) for k in ['whiteForeground','deletedWhite','foreground','deletedForeground','background','retainedBackground','occupancyMismatchVsV3']}
            text.append(f'|{names[method]}|{mode}|{values["deletedWhite"]}/{values["whiteForeground"]}|{values["deletedForeground"]}/{values["foreground"]}|{values["retainedBackground"]}/{values["background"]}|{values["occupancyMismatchVsV3"]}|')
    text+=['','这64条只检查既有白色安全约束，不是新保留数据。背景残留包含保守拒绝和不可辨识全白图，保留白色不意味着正确去除所有背景。逐图原始数和诊断见white-regression.json/CSV。','']
(RESULTS/'RESULTS.md').write_text('\n'.join(text),encoding='utf8')

def pattern_image(r):
    im=Image.new('RGB',(r['width'],r['height']));im.putdata([col[c] if c is not None else (219,211,228) for c in r['cells']]);return im
def uri(im):
    b=io.BytesIO();im.save(b,format='PNG');return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()
def small_metrics(r):return f'ΔE00 {fmt(r["meanDeltaE2000"],2)} · F1精确 {fmt(r["edgeExactF1"])} / 容差 {fmt(r["edgeTol1F1"])}<br>原始碎片 {r["tinyCells"]}/{r["nonempty"]} = {pct(r["speckleRatio"])}<br>用色 {r["usedColors"]} · {fmt(r["medianMs"],1)} ms · 特征 {r["markersPreserved"]}/{r["markersTotal"]}'
def table(rr):
    heads=['方法','ΔE00','加权ΔE00','F1精确','F1容差','原始碎片','豁免后碎片','紧凑度(面积加权)','区域类型','区域加权ΔE00','补集加权ΔE00','用色','耗时ms']
    body=[]
    for r in rr:
        values=[names[r['method']],fmt(r['meanDeltaE2000']),fmt(r['saliencyWeightedDeltaE2000']),fmt(r['edgeExactF1']),fmt(r['edgeTol1F1']),pct(r['speckleRatio']),pct(r['nonExemptSpeckleRatio']),fmt(r['compactnessAreaWeighted']),r['regionType'],fmt(r['regionSaliencyWeightedDeltaE2000']),fmt(r['complementSaliencyWeightedDeltaE2000']),str(r['usedColors']),fmt(r['medianMs'],1)]
        body.append('<tr>'+''.join('<td>'+html.escape(v)+'</td>' for v in values)+'</tr>')
    return '<div class="scroll"><table><thead><tr>'+''.join('<th>'+h+'</th>' for h in heads)+'</tr></thead><tbody>'+''.join(body)+'</tbody></table></div>'

css='body{font:15px system-ui;background:#f6f5fa;color:#30273a;margin:28px}p{line-height:1.7;max-width:1300px}h1{font-size:28px}section{padding:22px;background:white;border:1px solid #ddd3e8;border-radius:14px;margin:24px 0}.grid{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:14px}.grid img{width:100%;height:220px;object-fit:contain;image-rendering:pixelated;background:#eee9f3}.source img{image-rendering:auto}.tile b{display:block;margin:8px 0}.tile small{display:block;line-height:1.6;color:#72667c}.scroll{overflow:auto}table{border-collapse:collapse;white-space:nowrap;width:100%;margin-top:18px}td,th{padding:8px;text-align:right;border-bottom:1px solid #eee}td:first-child,th:first-child{text-align:left}details{margin-top:20px}summary{background:#f3edf9;padding:12px;cursor:pointer}footer{color:#73647c;font-size:13px;margin-top:30px}@media(max-width:800px){body{margin:12px}.grid{grid-template-columns:repeat(2,minmax(120px,1fr))}}'
for split in sets:
    sections=[]
    for f in fixtures:
        if f['split']!=split:continue
        rr=[r for r in rows if r['fixture']==f['id'] and r['maxColors']==18];by_method={r['method']:r for r in rr}
        tiles=[f'<div class="tile source"><b>源图 · {f["title"]}</b><img src="{uri(Image.open(ROOT/f["png"]))}"><small>{html.escape(f.get("note",""))}</small></div>']
        for m in ['v3','full','noAbstraction']:
            r=by_method[m];tiles.append(f'<div class="tile"><b>{names[m]} · K18</b><img src="{uri(pattern_image(raw_rows[(f["id"],18,m)]))}"><small>{small_metrics(r)}</small></div>')
        extra=[]
        for m in names:
            if m in ['v3','full','noAbstraction'] or m not in by_method:continue
            r=by_method[m];extra.append(f'<div class="tile"><b>{names[m]} · K18</b><img src="{uri(pattern_image(raw_rows[(f["id"],18,m)]))}"><small>{small_metrics(r)}</small></div>')
        budgets=[]
        for k in [12,24]:
            for m in ['v3','full']:
                r=next(r for r in rows if r['fixture']==f['id'] and r['maxColors']==k and r['method']==m)
                budgets.append(f'<div class="tile"><b>{names[m]} · K{k}</b><img src="{uri(pattern_image(raw_rows[(f["id"],k,m)]))}"><small>{small_metrics(r)}</small></div>')
        roi='<p>无区域标注；区域色差不可用。</p>'
        if f.get('regionPng'):roi=f'<p>区域类型：{f["regionType"]}。白色区域为mask/ROI；矩形ROI不代表精确主体。</p><img style="height:180px" src="{uri(Image.open(ROOT/f["regionPng"]))}">'
        sections.append(f'<section><h2>{html.escape(f["title"])} · {f["width"]}×{f["height"]}</h2><div class="grid">'+''.join(tiles)+'</div>'+table(rr)+'<details><summary>其余消融输出</summary><div class="grid">'+''.join(extra)+'</div></details><details><summary>K12 / K24预算对照</summary><div class="grid">'+''.join(budgets)+'</div></details><details><summary>标注区域与来源</summary>'+roi+f'<p>{html.escape(f.get("license","本项目独立程序绘制"))}</p>'+('</details></section>'))
    intro='<p>图纸来自实际算法输出；所有原始碎片（含有用眼睛/高光）都计入主指标。Canny边缘是自动proxy，精确F1和容差1豆F1同时展示。小色差、小碎片、高F1和快运行可能互相冲突；打开消融/预算栏目可核对代价。</p><p>源图和图纸投影同在4倍网格上计算Canny；色差参考是原图面积平均；加权色差用原图固定DoG显著性W=1+2S。图像级指标平均不构成用户研究。K18为预定主预算，K12/K24仅作取舍比较。</p><p><strong>注意低反差细节：</strong>Canny可能看不到它们；参考和输出都无边时F1=1，擦除细节也可能得高分。请同时看指定特征数与实际图纸，不能只看平均F1。</p>'
    doc=f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>内容自适应v4 · {split}</title><style>{css}</style><h1>内容自适应v4 · {"新保留组" if split=="heldout" else "开发组"}</h1>{intro}'+''.join(sections)+'<footer>协议 v4.4。照片来自scikit-image官方样例：NASA/SpaceX公共领域；Chelsea、Coffee、Retina、Grass为官方文档所述CC0。完整授权归属见fixtures.json。<br><a href="https://scikit-image.org/docs/stable/api/skimage.data.html">官方数据说明</a> · <a href="https://scikit-image.org/docs/0.25.x/api/skimage.feature.html#skimage.feature.canny">Canny API</a> · <a href="https://scikit-image.org/docs/0.25.x/api/skimage.color.html#skimage.color.deltaE_ciede2000">CIEDE2000 API</a></footer></html>'
    (RESULTS/f'{split}-comparison.html').write_text(doc,encoding='utf8')

# Actual output contact sheet: useful at desktop scale; all heldout, never cherry-picked.
fontpath=Path('C:/Windows/Fonts/msyh.ttc');font=ImageFont.truetype(str(fontpath),20) if fontpath.exists() else ImageFont.load_default();small=ImageFont.truetype(str(fontpath),15) if fontpath.exists() else font
selected=[f for f in fixtures if f['split']==('heldout' if 'heldout' in sets else 'development')]
sheet=Image.new('RGB',(1100,100+len(selected)*310),'#faf8fc');draw=ImageDraw.Draw(sheet)
draw.text((20,20),'实际输出对照：源图 / v3 / v4 / 无预抽象（K18）',font=font,fill='#30273a')
for row,f in enumerate(selected):
    for j,m in enumerate(['source','v3','full','noAbstraction']):
        im=Image.open(ROOT/f['png']).convert('RGB') if m=='source' else pattern_image(raw_rows[(f['id'],18,m)])
        factor=min(248/im.width,220/im.height);im=im.resize((round(im.width*factor),round(im.height*factor)),Image.Resampling.LANCZOS if m=='source' else Image.Resampling.NEAREST)
        x=20+j*272;y=80+row*310;sheet.paste(im,(x+(248-im.width)//2,y));draw.text((x,y+224),f['title'] if m=='source' else names[m],font=small,fill='#30273a')
        if m!='source':
            r=next(r for r in rows if r['fixture']==f['id'] and r['maxColors']==18 and r['method']==m)
            draw.text((x,y+248),f'碎片 {pct(r["speckleRatio"])}  F1 {fmt(r["edgeTol1F1"])}',font=small,fill='#72667c');draw.text((x,y+271),f'ΔE00 {fmt(r["meanDeltaE2000"],2)}',font=small,fill='#72667c')
sheet.save(RESULTS/'contact-sheet.png')

# Source-only metric Pareto scatter: small islands vs color error, edge F1 labels.
points=[r for r in rows if r['split']==('heldout' if 'heldout' in sets else 'development') and r['method'] in ['v3','full']]
W,H=1100,650;xmax=max(r['meanDeltaE2000'] for r in points)*1.15;ymax=max(r['speckleRatio']*100 for r in points)*1.15
svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><rect width="100%" height="100%" fill="white"/><style>text{{font-family:system-ui;font-size:12px}}</style><text x="40" y="28" font-size="20">色差与原始碎片的取舍（全部保留图，K12/18/24）</text>']
for i in range(6):
    x=90+i*180;y=560-i*96;svg.append(f'<path d="M{x} 80V560M90 {y}H990" stroke="#eee"/><text x="{x}" y="585">{xmax*i/5:.1f}</text><text x="25" y="{y}">{ymax*i/5:.1f}%</text>')
for r in points:
    x=90+r['meanDeltaE2000']/xmax*900;y=560-r['speckleRatio']*100/ymax*480;c='#7a58ac' if r['method']=='full' else '#d77d31';rad=3+(r['maxColors']-12)/6
    tooltip=f'{r["fixture"]} {r["method"]} K{r["maxColors"]}: ΔE00={r["meanDeltaE2000"]:.3f}, raw speckle={r["speckleRatio"]*100:.3f}%, F1tol={r["edgeTol1F1"]:.3f}'
    svg.append(f'<circle cx="{x}" cy="{y}" r="{rad}" fill="{c}" opacity=".75"><title>{html.escape(tooltip)}</title></circle>')
svg.append('<text x="450" y="625">平均 ΔE00（左更接近参考）</text><text x="90" y="55">橙色v3 / 紫色v4；圆越大预算越多；悬停查看图名与边缘F1</text></svg>')
(RESULTS/'pareto.svg').write_text(''.join(svg),encoding='utf8')
if white_file.exists():
    wf=json.loads((ROOT/'../white-preservation/fixtures.json').read_text('utf8'));wraw=json.loads((RESULTS/'white-regression-raw.json').read_text('utf8'))['rows'];wr=json.loads(white_file.read_text('utf8'))['rows'];sections=[]
    for f in wf:
        tiles=[f'<div class="tile source"><b>{html.escape(f["title"])} · 原图</b><img src="{uri(Image.open(ROOT/"../white-preservation"/f["png"]))}"></div>']
        for method,mode in [('v3',True),('full',True),('full',False)]:
            r=next(r for r in wraw if r['fixture']==f['id'] and r['method']==method and r['removeBackground']==mode)
            m=next(r for r in wr if r['fixture']==f['id'] and r['method']==method and r['removeBackground']==mode)
            tiles.append(f'<div class="tile"><b>{names[method]} · {"去外底" if mode else "保留全部"}</b><img src="{uri(pattern_image(r))}"><small>白色误删 {m["deletedWhite"]}/{m["whiteForeground"]}<br>背景残留 {pct(m["backgroundRetentionRate"])}<br>相对v3占位变化 {m["occupancyMismatchVsV3"]} 格</small></div>')
        sections.append('<section><div class="grid">'+''.join(tiles)+'</div><p>'+html.escape(f.get('note',''))+'</p></section>')
    (RESULTS/'white-regression-comparison.html').write_text(f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>{css}</style><h1>v4白色安全：16例已见回归</h1><p>紫灰实块为显示空格的位置，不是一颗白色豆；白色实块仍有豆。此处只验证v3→v4占位安全，不作为新保留证据。默认保留全部不会凭颜色删白；去底遇到证据不足可保守保留，因此背景残留需同时报告。</p>'+''.join(sections),encoding='utf8')
print(f'Reported {len(rows)} main rows with all comparisons and negative outcomes retained.')
