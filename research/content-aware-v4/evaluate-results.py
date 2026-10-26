"""Measure saved algorithm outputs without importing any product numerics."""
import sys,json,csv,platform,hashlib
from pathlib import Path
import numpy as np
import skimage,scipy,PIL
from metrics import measure
ROOT=Path(__file__).parent
split=sys.argv[1] if len(sys.argv)>1 else 'development'
run=json.loads((ROOT/'results'/f'{split}-raw.json').read_text('utf8'));white=split=='white-regression'
source_root=ROOT/'../white-preservation' if white else ROOT
fixtures={f['id']:f for f in json.loads((source_root/'fixtures.json').read_text('utf8'))}
rows=[]
for r in run['rows']:
    f=fixtures[r['fixture']];raw=np.frombuffer((source_root/f['source']).read_bytes(),np.uint8).reshape(f['sourceHeight'],f['sourceWidth'],4)
    meta={k:v for k,v in r.items() if k not in ['cells','diagnostics','backgroundDiagnostics','abstractionDiagnostics']}
    if white:
        w,h=f['width'],f['height'];sx,sy=f['sourceWidth']//w,f['sourceHeight']//h
        mask=np.frombuffer((source_root/f['mask']).read_bytes(),np.uint8).reshape(f['sourceHeight'],f['sourceWidth'])/255
        white_pixels=(np.min(raw[...,:3],axis=-1)>=230)&(np.ptp(raw[...,:3],axis=-1)<=20)
        fg=mask.reshape(h,sy,w,sx).mean(axis=(1,3))>=100/255
        wm=(mask*white_pixels).reshape(h,sy,w,sx).mean(axis=(1,3))>=100/255;wm&=fg
        keep=np.array([c is not None for c in r['cells']]).reshape(h,w)
        values=dict(foreground=int(fg.sum()),whiteForeground=int(wm.sum()),background=int((~fg).sum()),deletedForeground=int((fg&~keep).sum()),deletedWhite=int((wm&~keep).sum()),retainedBackground=int((~fg&keep).sum()))
        for a,b,key in [('deletedForeground','foreground','foregroundDeletionRate'),('deletedWhite','whiteForeground','whiteDeletionRate'),('retainedBackground','background','backgroundRetentionRate')]:values[key]=values[a]/values[b] if values[b] else None
        values['backgroundReason']=(r.get('backgroundDiagnostics') or {}).get('reason')
    else:
        region=np.frombuffer((ROOT/f['region']).read_bytes(),np.uint8).reshape(f['sourceHeight'],f['sourceWidth']) if f.get('region') else None
        values=measure(raw,r['cells'],f['width'],f['height'],run['palette'],f,region)
    rows.append(dict(**meta,**values))
out={k:v for k,v in run.items() if k not in ['palette','rows']};out.update(evaluationProtocol=json.loads((ROOT/'protocol-lock.json').read_text('utf8'))['protocol'],
 fixtureManifestSha256=hashlib.sha256((source_root/'fixtures.json').read_bytes()).hexdigest(),
 evaluationEnvironment=dict(python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__,skimage=skimage.__version__,pillow=PIL.__version__),evaluationHash=hashlib.sha256((ROOT/'metrics.py').read_text('utf8').replace('\r\n','\n').encode()).hexdigest(),rows=rows)
(ROOT/'results'/f'{split}.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
fields=[k for k in rows[0] if k not in ['markerDetails','timesMs']]
with (ROOT/'results'/f'{split}.csv').open('w',encoding='utf-8-sig',newline='') as file:
    writer=csv.DictWriter(file,fieldnames=fields,extrasaction='ignore');writer.writeheader();writer.writerows(rows)
print(f'Evaluated {len(rows)} {split} rows; independent metric version {out["evaluationHash"][:12]}.')
