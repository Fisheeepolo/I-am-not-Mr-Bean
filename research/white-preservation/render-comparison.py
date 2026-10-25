"""Actual experiment outputs rendered from their embedded SVG, with empty cells visible."""
from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
from html.parser import HTMLParser
from io import BytesIO
import base64,json,xml.etree.ElementTree as ET
ROOT=Path(__file__).parent/'results'
class Parser(HTMLParser):
    def __init__(self):super().__init__();self.images=[]
    def handle_starttag(self,t,a):
        if t=='img':self.images.append(dict(a)['src'])
def checker(w,h,step=2):
    im=Image.new('RGBA',(w,h),'#EAE5EF');d=ImageDraw.Draw(im)
    for y in range(0,h,step):
        for x in range(0,w,step):
            if ((x//step)+(y//step))%2==0:d.rectangle((x,y,x+step-1,y+step-1),fill='#BEB4CA')
    return im
def raster(uri):
    data=base64.b64decode(uri.split(',',1)[1])
    if 'svg+xml' not in uri:
        im=Image.open(BytesIO(data)).convert('RGBA');bg=checker(im.width,im.height,8);bg.alpha_composite(im);return bg
    root=ET.fromstring(data);_,_,w,h=map(int,root.attrib['viewBox'].split());im=checker(w,h);d=ImageDraw.Draw(im)
    for r in root:
        a=r.attrib
        if not r.tag.endswith('rect') or '%' in a.get('width',''):continue
        x,y,ww,hh=[int(a.get(k,0)) for k in ['x','y','width','height']]
        d.rectangle((x,y,x+ww-1,y+hh-1),fill=a['fill'])
    return im
font=lambda n:ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',n)
for split in ['regression','heldout']:
    p=Parser();p.feed((ROOT/f'{split}-comparison.html').read_text(encoding='utf-8'))
    rows=json.loads((ROOT/f'{split}.json').read_text(encoding='utf-8'))['rows'];fixtures=list(dict.fromkeys(r['fixture'] for r in rows))
    out=Image.new('RGB',(1570,170+len(fixtures)*285+70),'#faf9fc');d=ImageDraw.Draw(out)
    d.text((28,22),'白色主体保护 · '+('第二轮新保留组' if split=='heldout' else '已看样例回归组'),font=font(30),fill='#30273A')
    d.text((28,71),'棋盘格 = 空格；白色实块 = 豆。绿色标注是独立绘制的目标占位。主动去底不确定时保留。',font=font(19),fill='#786881')
    for k,t in enumerate(['原图','独立目标掩码','旧版 · 默认容差20','新版 · 默认保留','新版 · 主动去底20']):d.text((28+308*k,120),t,font=font(20),fill='#514062')
    for fi,f in enumerate(fixtures):
        y=170+fi*285;title=next(r['title'] for r in rows if r['fixture']==f)
        for k,uri in enumerate(p.images[fi*5:fi*5+5]):
            im=raster(uri);s=min(274/im.width,205/im.height);im=im.resize((round(im.width*s),round(im.height*s)),Image.Resampling.NEAREST)
            x=28+308*k;out.paste(im,(x+(274-im.width)//2,y+(205-im.height)//2),im)
            if k==0:d.text((x,y+215),title,font=font(16),fill='#514062')
            if k>1:
                method=['v2-20','v3-preserve','v3-edge-20'][k-2];r=next(r for r in rows if r['fixture']==f and r['method']==method)
                d.text((x,y+212),f'白格误删 {r["deletedWhite"]}/{r["whiteForeground"]}',font=font(17),fill='#514062')
                bg='—' if r['backgroundRetentionRate'] is None else f'{100*r["backgroundRetentionRate"]:.1f}%'
                d.text((x,y+239),f'背景残留 {bg}',font=font(17),fill='#786881')
    d.text((28,out.height-45),'全部为原创程序绘制、带独立真值的专项样例；无生成式 AI。结果不代表真实照片的总体识别率。',font=font(18),fill='#786881')
    out.save(ROOT/f'{split}-contact-sheet.png');print(ROOT/f'{split}-contact-sheet.png')
