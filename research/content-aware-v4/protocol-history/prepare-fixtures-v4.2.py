"""Pre-register deterministic v4 fixtures. Run before looking at v4 outputs."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import hashlib, json, urllib.request
import numpy as np

ROOT=Path(__file__).parent
DATA=ROOT/'data'; ORIGINAL=DATA/'originals'
ORIGINAL.mkdir(parents=True,exist_ok=True)
fixtures=[]
def sha(b): return hashlib.sha256(b).hexdigest()
def save(id,title,split,kind,im,target,region=None,region_type='unavailable',markers=None,**extra):
    im=im.convert('RGBA'); raw=im.tobytes(); (DATA/f'{id}.rgba').write_bytes(raw); im.save(DATA/f'{id}.png')
    f=dict(id=id,title=title,split=split,kind=kind,width=target[0],height=target[1],sourceWidth=im.width,sourceHeight=im.height,
           source=f'data/{id}.rgba',png=f'data/{id}.png',sourceSha256=sha(raw),regionType=region_type,markers=markers or [],**extra)
    if region is not None:
        region=region.convert('L'); b=region.tobytes(); (DATA/f'{id}.mask').write_bytes(b); region.save(DATA/f'{id}-region.png')
        f.update(region=f'data/{id}.mask',regionSha256=sha(b),regionPng=f'data/{id}-region.png')
    fixtures.append(f)

photo_meta=[
 ('astronaut','png','development','宇航员', 'NASA; public domain', [.18,.08,.64,.60]),
 ('chelsea','png','development','猫咪', 'Stefan van der Walt; CC0', [.22,.13,.80,.90]),
 ('rocket','jpg','development','火箭', 'SpaceX; public domain', [.43,.05,.70,.90]),
 ('coffee','png','heldout','咖啡杯', 'Rachel Michetti; CC0; courtesy Pikolo Espresso Bar', [.18,.16,.77,.94]),
 ('hubble_deep_field','jpg','heldout','哈勃深空', 'NASA; public domain; HubbleSite', None),
 ('retina','jpg','heldout','视网膜', 'Mikael Häggström; CC0 1.0; Wikimedia', [.17,.17,.83,.83]),
 ('grass','png','heldout','草地纹理', 'DeviantArt source identified by scikit-image; CC0', None),
]
for name,ext,split,title,credit,roi in photo_meta:
    url=f'https://raw.githubusercontent.com/scikit-image/scikit-image/v0.25.2/skimage/data/{name}.{ext}'
    p=ORIGINAL/f'{name}.{ext}'
    if not p.exists():
        with urllib.request.urlopen(url,timeout=60) as response:p.write_bytes(response.read())
    im=Image.open(p).convert('RGBA'); original_size=im.size
    target=(64,max(1,round(64*im.height/im.width))) if im.width>=im.height else (max(1,round(64*im.width/im.height)),64)
    im=im.resize((target[0]*4,target[1]*4),Image.Resampling.LANCZOS)
    region=None
    if roi:
        region=Image.new('L',im.size); d=ImageDraw.Draw(region); d.rectangle(tuple(round(v*s) for v,s in zip(roi,[im.width,im.height,im.width,im.height])),fill=255)
    save('photo-'+name,title,split,'photo',im,target,region,'manual-rectangle-ROI-proxy' if roi else 'unavailable',
         license=credit,sourceUrl=url,documentation='https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.'+name,
         originalSha256=sha(p.read_bytes()),originalSize=list(original_size),roiNormalized=roi,
         note='全图保持长宽比；源图重采样至目标4倍。矩形ROI仅为评测区域代理，不是分割或语义真值。' if roi else '无主体掩码或ROI：只报全图色差，区域色差不可用。')

def synth_face(id,split,shift):
    w=h=64; s=4; im=Image.new('RGB',(w*s,h*s),'#c4d7df'); d=ImageDraw.Draw(im)
    mask=Image.new('L',im.size); md=ImageDraw.Draw(mask)
    face=(48+shift,28,211+shift,231); d.ellipse(face,fill='#e9bc8f'); md.ellipse(face,fill=255)
    # Actual one-/two-bead eyes coexist with a sub-bead width diagonal wire.
    markers=[]
    for x,y,ww in [(25+shift//4,28,1),(39+shift//4,28,2)]:
        d.rectangle((x*s,y*s,(x+ww)*s-1,(y+1)*s-1),fill='#26202b')
        markers.append(dict(x=x,y=y,rgb=[38,32,43],backgroundRgb=[233,188,143],backgroundPoint=[x,y+3],name='eye-'+str(ww)+'-beads'))
    d.line((17,182,238,92),fill='#423b4b',width=2)
    d.arc((104,137,155,177),0,180,fill='#8b4b49',width=4)
    save(id,'细线与微小眼睛'+('（保留）' if split=='heldout' else ''),split,'synthetic',im,(w,h),mask,'ground-truth-object-mask',markers,note='程序绘制的真实细线/眼睛；主体mask由绘图几何独立产生。细线宽0.5豆，眼睛1/2豆。')

def synth_blur(id,split,seed):
    rng=np.random.default_rng(seed); w=h=256; yy,xx=np.mgrid[:h,:w]
    base=np.stack([105+65*xx/w,145+40*yy/h,175-35*xx/w],axis=-1)
    noise=rng.normal(0,15,(h,w,1)); bg=Image.fromarray(np.uint8(np.clip(base+noise,0,255))).filter(ImageFilter.GaussianBlur(5 if split=='development' else 7))
    d=ImageDraw.Draw(bg); mask=Image.new('L',(w,h)); md=ImageDraw.Draw(mask)
    points=[(83,50),(178,66),(194,193),(64,206)]; d.polygon(points,fill='#80514c');md.polygon(points,fill=255)
    d.line((85,57,174,72),fill='#efc6a2',width=4);d.ellipse((113,107,143,137),fill='#e9c891')
    save(id,'散焦背景与清晰主体'+('（保留）' if split=='heldout' else ''),split,'synthetic',bg,(64,64),mask,'ground-truth-object-mask',note='背景先加固定种子噪声再GaussianBlur；清晰主体后绘制。散焦标签只在此合成过程已知。')

def synth_small(id,split,high):
    s=4; size=64; bg=[83,116,139] if high else [174,186,172]; fg=[250,248,229] if high else [157,169,155]
    im=Image.new('RGB',(256,256),tuple(bg)); d=ImageDraw.Draw(im); mask=Image.new('L',im.size); md=ImageDraw.Draw(mask);markers=[]
    pos=[(17,18,1),(34,21,2),(24,43,1),(48,42,2)] if split=='development' else [(13,36,2),(28,17,1),(43,47,1),(46,25,2)]
    # Desired tiny details, not injected nuisance noise. Keeping them necessarily leaves some tiny components.
    for k,(x,y,n) in enumerate(pos):
        rect=(x*s,y*s,(x+n)*s-1,(y+1)*s-1);d.rectangle(rect,fill=tuple(fg));md.rectangle(rect,fill=255)
        markers.append(dict(x=x,y=y,rgb=fg,backgroundRgb=bg,backgroundPoint=[x,y+3],name=f'desired-{n}-bead-detail-{k}'))
    save(id,('强反差真实高光' if high else '低反差1–2豆细节')+('（保留）' if split=='heldout' else ''),split,'synthetic',im,(size,size),mask,'ground-truth-feature-mask',markers,
         note='所有标注小色块都是希望保留的细节；原始碎片率不能当作单独质量指标。')

for split,shift,seed in [('development',0,104),('heldout',8,619)]:
    prefix='dev' if split=='development' else 'held'
    synth_face(prefix+'-eyes-lines',split,shift)
    synth_blur(prefix+'-defocus',split,seed)
    synth_small(prefix+'-low-contrast',split,False)
    synth_small(prefix+'-highlights',split,True)

(ROOT/'fixtures.json').write_text(json.dumps(fixtures,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(f'Fixed {len(fixtures)} fixtures: {sum(f["split"]=="development" for f in fixtures)} development, {sum(f["split"]=="heldout" for f in fixtures)} heldout.')
