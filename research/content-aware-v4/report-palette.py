"""Independent analysis of the predeclared supplemental palette selection study."""
import json,csv,statistics,base64,io,html
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).parent;OUT=ROOT/'results'
fixtures={f['id']:f for f in json.loads((ROOT/'fixtures.json').read_text('utf8'))}
rows=[];raw=[];positive=0
for split in ['development','heldout']:
    scored=json.loads((OUT/f'palette-study-{split}.json').read_text('utf8'));source=json.loads((OUT/f'palette-study-{split}-raw.json').read_text('utf8'))
    main=json.loads((OUT/f'{split}-raw.json').read_text('utf8'))
    for r in source['rows']:
        if r['method']=='full':
            control=next(x for x in main['rows'] if x['fixture']==r['fixture'] and x['maxColors']==18 and x['method']=='full')
            assert r['cells']==control['cells'];positive+=1
    rows+=scored['rows'];raw+=source['rows']
palette=source['palette'];colors={p['code']:tuple(int(p['hex'][i:i+2],16) for i in [1,3,5]) for p in palette}
fields=[k for k in rows[0] if not isinstance(rows[0][k],(dict,list))]
with (OUT/'palette-study-metrics.csv').open('w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore');w.writeheader();w.writerows(rows)
names={'full':'设施选色+离散中心优化','frequencyPalette':'显著性加权频数Top-K'}
mean=lambda rs,k:statistics.mean(r[k] for r in rs)
fmt=lambda v:'—' if v is None else f'{v:.3f}'
pct=lambda v:f'{100*v:.2f}%'
txt=['# 补充：受限色卡选择对照（30条实测）','','这是首次主保留运行前声明的补充实验，不替换主195条矩阵。15张输入和划分不变，K18/DE00/balanced相同；共同预处理后的Labs、S、F严格相同。Top-K按同一数据权重累计全色卡最近颜色的硬投票；子集进入同一优化器。更换色卡会改变初始标签、后续图割和微保护门控结果，因此它是选色策略的受控端到端对照，不是只关闭medoid的单操作消融。','',f'正对照：补充full的{positive}张逐格输出与主full/K18完全一致，独立评分程序相同。计时每臂都包含共同预处理成本；不能把仅优化阶段时长当端到端速度。阶段和3轮时长在raw JSON。','',
 '|组别|类型|方法|ΔE00|显著性加权ΔE00|F1精确|F1容差|原始碎片率|端到端ms|','|---|---|---|---:|---:|---:|---:|---:|---:|']
summaries=[]
for split in ['development','heldout']:
    for kind in ['all','photo','synthetic']:
        for method in names:
            rr=[r for r in rows if r['split']==split and r['method']==method and (kind=='all' or r['kind']==kind)]
            s=dict(split=split,kind=kind,method=method,n=len(rr),**{k:mean(rr,k) for k in ['meanDeltaE2000','saliencyWeightedDeltaE2000','edgeExactF1','edgeTol1F1','speckleRatio','medianMs']});summaries.append(s)
            txt.append(f'|{split}|{kind}|{names[method]}|{fmt(s["meanDeltaE2000"])}|{fmt(s["saliencyWeightedDeltaE2000"])}|{fmt(s["edgeExactF1"])}|{fmt(s["edgeTol1F1"])}|{pct(s["speckleRatio"])}|{s["medianMs"]:.1f}|')
txt+=['','## 逐图数据（不删除退步项）','','|图像|方法|ΔE00|F1容差|原始碎片|区域加权ΔE00|补集加权ΔE00|端到端ms|','|---|---|---:|---:|---:|---:|---:|---:|']
for f in fixtures.values():
    for method in names:
        r=next(r for r in rows if r['fixture']==f['id'] and r['method']==method)
        txt.append(f'|{f["title"]} ({f["split"]})|{names[method]}|{fmt(r["meanDeltaE2000"])}|{fmt(r["edgeTol1F1"])}|{pct(r["speckleRatio"])}|{fmt(r["regionSaliencyWeightedDeltaE2000"])}|{fmt(r["complementSaliencyWeightedDeltaE2000"])}|{r["medianMs"]:.1f}|')
txt+=['','## 可支持的结论与代价','','4张新保留照片上，设施选色的平均ΔE00为4.375，频数Top-K为4.391；显著性加权色差4.380与4.406，F1容差0.820与0.818，原始碎片11.03%与11.09%。差异较小，不能称作统计显著或普适贡献。开发照片中，频数Top-K的F1反而更高（0.820对0.814）。平均端到端时间方面，此补充中的设施选色更慢；完整逐图数据保留所有负例。','','这不是随机代表性照片集；没有人工评价，不能仅用本补充为设施选色建立强研究贡献。不能把其颜色误差收益等价为眼睛/人物识别收益。','']
(OUT/'PALETTE-RESULTS.md').write_text('\n'.join(txt),encoding='utf8')
(OUT/'palette-study-summary.json').write_text(json.dumps(dict(positiveControls=positive,groups=summaries),ensure_ascii=False,indent=2)+'\n',encoding='utf8')
def uri(im):
    b=io.BytesIO();im.save(b,format='PNG');return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()
sections=[]
for f in fixtures.values():
    items=[f'<article><h3>原图 · {html.escape(f["title"])}</h3><img src="{uri(Image.open(ROOT/f["png"]))}"></article>']
    for method in names:
        rr=next(r for r in raw if r['fixture']==f['id'] and r['method']==method);r=next(r for r in rows if r['fixture']==f['id'] and r['method']==method)
        im=Image.new('RGB',(f['width'],f['height']));im.putdata([colors[c] if c else (219,211,228) for c in rr['cells']])
        items.append(f'<article><h3>{names[method]}</h3><img src="{uri(im)}"><p>ΔE00 {fmt(r["meanDeltaE2000"])} · F1容差 {fmt(r["edgeTol1F1"])}<br>原始碎片 {pct(r["speckleRatio"])} · {r["medianMs"]:.1f}ms</p></article>')
    sections.append('<section>'+''.join(items)+'</section>')
(OUT/'palette-study-comparison.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>补充选色策略实测对照</title><style>body{font:15px system-ui;background:#faf8fc;color:#30273a;margin:25px}section{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;background:white;padding:20px;margin:25px 0;border:1px solid #ddd;border-radius:12px}img{width:100%;height:240px;object-fit:contain;image-rendering:pixelated}p{line-height:1.7}@media(max-width:700px){section{grid-template-columns:1fr}}</style><h1>受限色卡选择：补充实测</h1><p>共同预处理、K18、同一空间优化器；色卡组成变化会影响下游初始标签和微保护，是选色策略对照，不是单独medoid消融。全部15张图均展示，固定4张新保留照片和既有拆分不变。完整数据/方法见PALETTE-RESULTS.md及CSV。</p>'+''.join(sections),encoding='utf8')
print(f'Supplement scored/reported {len(rows)} rows; all {positive} full positive controls match main exactly.')
