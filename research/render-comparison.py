"""Render the actual embedded benchmark outputs, not illustrative replacements."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
from html.parser import HTMLParser
from io import BytesIO
import base64, xml.etree.ElementTree as ET, json
ROOT=Path(__file__).parent/'results'
class Parser(HTMLParser):
    def __init__(self):super().__init__();self.images=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='img':self.images.append(a['src'])
def raster(uri):
    data=base64.b64decode(uri.split(',',1)[1])
    if 'svg+xml' not in uri:return Image.open(BytesIO(data)).convert('RGBA')
    root=ET.fromstring(data);_,_,w,h=map(int,root.attrib['viewBox'].split())
    im=Image.new('RGBA',(w,h),'#f2f2f2');d=ImageDraw.Draw(im)
    for r in root:
        a=r.attrib
        if '%' in a.get('width',''):continue
        x,y,ww,hh=[int(a.get(k,0)) for k in ['x','y','width','height']]
        d.rectangle((x,y,x+ww-1,y+hh-1),fill=a['fill'])
    return im
fontfile='C:/Windows/Fonts/msyh.ttc'
def font(n):return ImageFont.truetype(fontfile,n)
for split in ['development','heldout']:
    parser=Parser();parser.feed((ROOT/f'{split}-comparison.html').read_text(encoding='utf-8'))
    rows=json.loads((ROOT/f'{split}.json').read_text(encoding='utf-8'))['rows']
    fixtures=list(dict.fromkeys(r['fixture'] for r in rows))
    height=150+len(fixtures)*272+65
    out=Image.new('RGB',(1470,height),'#faf9fc');d=ImageDraw.Draw(out)
    title='保留评估组' if split=='heldout' else '开发组'
    d.text((30,22),f'非 AI 拼豆算法 · {title}',fill='#30273a',font=font(30))
    d.text((30,68),'同尺寸 / MARD 最多 8 色；全部样例。颜色误差与碎片指标只是代理指标，不是实际拼装耗时。',fill='#786881',font=font(19))
    labels=['原图','旧量化基线','细节优先','均衡','好拼优先'];methods=[None,'baseline','full-detail','full-balanced','full-easy']
    for k,label in enumerate(labels):d.text((30+k*288,110),label,fill='#514062',font=font(21))
    for fi,f in enumerate(fixtures):
        y0=150+fi*272;title=next(r['title'] for r in rows if r['fixture']==f)
        imgs=parser.images[fi*15:fi*15+5]
        for k,uri in enumerate(imgs):
            im=raster(uri);scale=min(260/im.width,205/im.height)
            im=im.resize((round(im.width*scale),round(im.height*scale)),Image.Resampling.LANCZOS if k==0 else Image.Resampling.NEAREST)
            x=30+k*288;out.paste(im,(x+(260-im.width)//2,y0+(205-im.height)//2),im)
            if k==0:d.text((x,y0+214),title,fill='#514062',font=font(16))
            else:
                r=next(r for r in rows if r['fixture']==f and r['plan']=='full-8' and r['method']==methods[k])
                d.text((x,y0+211),f'ΔE {r["meanDeltaE76"]:.2f} · 边缘 F1 {r["edgeF1"]:.3f}',fill='#514062',font=font(16))
                d.text((x,y0+235),f'小碎片 {r["smallCells"]} 格 · 行换色 {r["rowTransitions"]}',fill='#786881',font=font(16))
    d.text((30,height-48),'照片：scikit-image 官方样例（NASA / SpaceX 公共领域；Chelsea: Stefan van der Walt, CC0）。',fill='#786881',font=font(17))
    out.save(ROOT/f'{split}-contact-sheet.png')
    print(ROOT/f'{split}-contact-sheet.png')
