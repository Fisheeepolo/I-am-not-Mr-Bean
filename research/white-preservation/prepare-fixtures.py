"""Original deterministic masks for white-foreground preservation; Pillow only."""
from PIL import Image, ImageDraw
from pathlib import Path
import json, hashlib
ROOT=Path(__file__).parent;DATA=ROOT/'data';DATA.mkdir(exist_ok=True)
items=[]
def canvas(w=192,h=192,bg='#FFFFFF'):
    return Image.new('RGBA',(w,h),bg),Image.new('L',(w,h),0)
def save(key,title,split,im,mask,*,ambiguous=False,note='',target=None):
    w,h=im.size;target=target or (w//4,h//4)
    raw=im.tobytes();m=mask.tobytes();im.save(DATA/f'{key}.png');mask.save(DATA/f'{key}-mask.png')
    (DATA/f'{key}.rgba').write_bytes(raw);(DATA/f'{key}.mask').write_bytes(m)
    items.append(dict(id=key,title=title,split=split,width=target[0],height=target[1],sourceWidth=w,sourceHeight=h,
        png=f'data/{key}.png',source=f'data/{key}.rgba',mask=f'data/{key}.mask',maskPng=f'data/{key}-mask.png',
        sourceSha256=hashlib.sha256(raw).hexdigest(),maskSha256=hashlib.sha256(m).hexdigest(),ambiguous=ambiguous,note=note))
def polygon(im,mask,points,fill='#FFFFFF',outline='#BEBEBE',width=2):
    ImageDraw.Draw(im).polygon(points,fill=fill,outline=outline,width=width);ImageDraw.Draw(mask).polygon(points,fill=255)
def ellipse(im,mask,box,fill='#FFFFFF',outline='#BEBEBE',width=2):
    ImageDraw.Draw(im).ellipse(box,fill=fill,outline=outline,width=width);ImageDraw.Draw(mask).ellipse(box,fill=255)

im,m=canvas();polygon(im,m,[(59,25),(78,17),(114,17),(133,25),(170,64),(146,86),(136,73),(136,174),(55,174),(55,73),(45,86),(22,64)],outline='#C8C8C8',width=2)
d=ImageDraw.Draw(im);d.line((96,26,96,172),fill='#DFDFDF',width=2);d.rectangle((67,82,84,100),outline='#D8D8D8',width=2)
save('white-coat','白衣：浅灰细线与白底','development',im,m,note='Source outline is only 2 pixels; target grid is 4x smaller.')
im,m=canvas();ellipse(im,m,(27,31,165,160),outline='#D0D0D0',width=2);ImageDraw.Draw(im).ellipse((67,66,75,74),fill='#29252B')
save('closed-white','白物：浅灰闭合轮廓','development',im,m)
im,m=canvas();polygon(im,m,[(0,45),(98,45),(126,89),(126,191),(0,191)],outline='#B5B5B5',width=3)
save('touching-white','白物触及左边与底边','development',im,m)
im,m=canvas(bg=(255,255,255,0));ellipse(im,m,(0,11,184,180),outline='#E3E3E3',width=2)
save('transparent-white','透明底上的白色主体','development',im,m,note='Native alpha explicitly distinguishes empty from white.')
im,m=canvas();m.paste(255,(0,0,192,192));save('pure-white','纯白不透明画面：全部需要豆','development',im,m,ambiguous=True,note='Same observed RGB/alpha as invisible-white; intended mask is all foreground.')
im,m=canvas();ImageDraw.Draw(m).ellipse((29,29,163,163),fill=255);save('invisible-white','同色白物与白底：意图不可辨识','development',im,m,ambiguous=True,note='Identical observed RGBA to pure-white, but a different intended foreground; neither automatic model can infer the intention.')
im,m=canvas();polygon(im,m,[(96,24),(166,157),(24,157)],fill='#319089',outline='#1F524E',width=3)
save('clear-colored','对照：白底高对比彩色主体','development',im,m)

# Heldout geometries, colors, dimensions and edge contacts are fixed before use.
im,m=canvas(256,192,bg='#F3EEE2');ellipse(im,m,(44,45,216,179),fill='#FFFDF8',outline='#B4AFA5',width=3)
save('held-bowl','保留组：米白背景上的白碗','heldout',im,m)
im,m=canvas(256,256);polygon(im,m,[(128,15),(151,89),(229,89),(166,135),(190,214),(128,165),(65,214),(89,135),(26,89),(104,89)],outline='#C5C5C5',width=2)
save('held-star','保留组：细灰轮廓白色星形','heldout',im,m)
im,m=canvas(256,192,bg=(0,0,0,0));polygon(im,m,[(0,0),(255,0),(255,69),(209,71),(209,171),(49,171),(49,71),(0,69)],outline='#EFEFEF',width=2)
save('held-transparent-edge','保留组：透明底白物占据两角','heldout',im,m)
im,m=canvas(256,256,bg='#6B8D9A');polygon(im,m,[(0,0),(85,0),(71,113),(0,155)],outline='#E4E4E4',width=2);polygon(im,m,[(255,255),(176,255),(187,143),(255,101)],outline='#E4E4E4',width=2)
save('held-corner-conflict','保留组：白物占两角、背景占两角','heldout',im,m,note='The corner votes tie; neither color should be assumed to be background.')
im,m=canvas(256,192);polygon(im,m,[(58,192),(48,104),(85,34),(171,34),(209,104),(198,192)],outline='#4C4C4C',width=2)
save('held-hat','保留组：深细轮廓白帽触底','heldout',im,m)
for item in items:
    item['originalSplit']=item['split'];item['split']='regression';item['title']=item['title'].replace('保留组：','首轮回归例：')

# Round 2: created after the independent native-grid integration test exposed a
# halo regression. These four images are not inspected until parameters freeze.
im,m=canvas(13,13)
polygon(im,m,[(4,1),(8,1),(8,4),(11,4),(11,8),(8,8),(8,11),(4,11),(4,8),(1,8),(1,4),(4,4)],outline='#4A4A4A',width=1)
save('fresh-native-cross','新保留组：原尺寸白色十字','heldout',im,m,target=(13,13),note='Native 13×13 source: no downsampling; tests boundary halos at bead scale.')
im,m=canvas(68,52)
polygon(im,m,[(18,5),(49,10),(61,39),(7,45)],outline='#BEBEBE',width=1)
save('fresh-small-frame','新保留组：微小斜灰框白物','heldout',im,m,target=(17,13),note='One-source-pixel gray outline, 4× reduction, 17×13 target.')
im,m=canvas(76,60)
ellipse(im,m,(5,1,68,58),outline='#6A6A6A',width=2)
ImageDraw.Draw(im).ellipse((27,20,48,41),fill='#FFFFFF',outline='#6A6A6A',width=2)
ImageDraw.Draw(m).ellipse((29,22,46,39),fill=0)
save('fresh-white-ring','新保留组：白环与封闭内孔','heldout',im,m,target=(19,15),note='Inner white region is intended empty; exterior-only reconstruction may retain this enclosed hole. This tests a known model limitation, not semantic recognition.')
im,m=canvas(60,44,bg=(255,255,255,0))
polygon(im,m,[(0,0),(59,0),(59,11),(15,11),(15,43),(0,43)],outline='#EAEAEA',width=1)
save('fresh-alpha-l','新保留组：透明底小白L形','heldout',im,m,target=(15,11),note='Known alpha and several occupied corners; 15×11 target.')
(ROOT/'fixtures.json').write_text(json.dumps(items,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'{len(items)} cases: {sum(i["split"]=="regression" for i in items)} round-1 regression, {sum(i["split"]=="heldout" for i in items)} fresh heldout')
