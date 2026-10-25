"""Deterministic non-AI research fixtures; requires Pillow. Run from repo root."""
from PIL import Image, ImageDraw
from pathlib import Path
import json, random, hashlib

ROOT = Path(__file__).parent
DATA = ROOT / 'data'
DATA.mkdir(exist_ok=True)
fixtures = []

def save(name, title, split, image, target, markers=None, note='Original procedural fixture; no AI'):
    image = image.convert('RGBA')
    image.save(DATA / f'{name}.png')
    raw = image.tobytes()
    (DATA / f'{name}.rgba').write_bytes(raw)
    fixtures.append(dict(id=name, title=title, split=split, sourceWidth=image.width,
        sourceHeight=image.height, width=target[0], height=target[1], source=f'data/{name}.rgba',
        png=f'data/{name}.png', sha256=hashlib.sha256(raw).hexdigest(), markers=markers or [], note=note))

def face(name, title, split, seed, size=48):
    rng=random.Random(seed); scale=4
    im=Image.new('RGBA',(size*scale,size*scale),(0,0,0,0)); d=ImageDraw.Draw(im)
    # Many nearby warm shades compete against the rare, semantically crucial eyes.
    for y in range(5,size-5):
        for x in range(5,size-5):
            if ((x-size/2)/(size*.38))**2+((y-size/2)/(size*.39))**2<1:
                tone=(x//5+y//7)%7
                col=(236-tone*4,177-tone*4,113-tone*3,255)
                d.rectangle((x*scale,y*scale,x*scale+scale-1,y*scale+scale-1),fill=col)
    eyes=[(int(size*.35),int(size*.43)),(int(size*.65),int(size*.43))]
    for x,y in eyes:d.rectangle((x*scale,y*scale,(x+1)*scale-1,(y+1)*scale-1),fill='#201C24')
    d.line((int(size*.4)*scale,int(size*.65)*scale,int(size*.6)*scale,int(size*.65)*scale),fill='#982D4D',width=scale)
    markers=[dict(x=x,y=y,hex='#201C24',name='eye') for x,y in eyes]
    save(name,title,split,im,(size,size),markers)

face('rare-eyes','小面积眼睛与近似肤色','development',10)
face('heldout-face','保留组：另一尺寸的人脸','heldout',81,64)

for name,title,split,seed,size in [('noisy-flat','低对比杂点与连续轮廓','development',151,48),('heldout-noise','保留组：平涂与纹理','heldout',419,64)]:
    rng=random.Random(seed); im=Image.new('RGBA',(size*4,size*4),'#F2EEE4');d=ImageDraw.Draw(im)
    d.rounded_rectangle((20,20,size*4-21,size*4-21),radius=20,fill='#4A99A4',outline='#243C4B',width=5)
    for _ in range(size*size//2):
        x,y=rng.randrange(7,size-7),rng.randrange(7,size-7)
        v=rng.choice([-12,-8,8,12]); d.rectangle((x*4,y*4,x*4+3,y*4+3),fill=(74+v,153+v,164+v,255))
    d.ellipse((size*1.2,size*1.2,size*2.8,size*2.8),fill='#E8B15E')
    d.rectangle((size*1.8,size*1.6,size*2.0,size*2.1),fill='#202F37')
    save(name,title,split,im,(size,size))

im=Image.new('RGBA',(192,192),'#F5F1E9');d=ImageDraw.Draw(im)
for x in (25,61,97,133): d.line((x,14,x,178),fill='#242633',width=3)
for y in (31,79,127):d.line((13,y,178,y),fill='#27324F',width=3)
d.arc((40,40,153,153),12,325,fill='#BE3755',width=4)
save('thin-lines','细线、网格与圆弧','development',im,(48,48))

im=Image.new('RGBA',(192,192));p=im.load()
for y in range(192):
    for x in range(192):
        p[x,y]=(round(25+210*x/191),round(30+180*y/191),round(120+80*(x+y)/382),255)
save('gradient','平滑渐变','development',im,(48,48))

im=Image.new('RGBA',(192,192),(255,0,255,0));d=ImageDraw.Draw(im)
d.ellipse((21,17,173,169),fill=(57,123,178,255));d.ellipse((42,38,153,149),fill=(244,204,94,255))
d.polygon([(44,142),(98,26),(148,142)],fill=(61,145,117,255))
save('transparent','透明底与斜向轮廓','development',im,(48,48))

im=Image.new('RGBA',(96,96),(0,0,0,0));d=ImageDraw.Draw(im)
d.rectangle((18,10,77,85),fill='#3C2E49');d.rectangle((22,14,73,81),fill='#B884BE')
d.rectangle((30,24,37,31),fill='#1C2736');d.rectangle((58,24,65,31),fill='#1C2736')
d.rectangle((42,54,53,61),fill='#EF765F');d.rectangle((26,70,69,77),fill='#EEE2B6')
save('pixel-icon','现成像素画无损输入','development',im,(96,96))

im=Image.new('RGBA',(256,192),'#DCEBF1');d=ImageDraw.Draw(im)
d.polygon([(0,152),(61,31),(131,152)],fill='#527657');d.polygon([(90,161),(176,27),(256,161)],fill='#304D55')
d.ellipse((194,18,229,53),fill='#F8C650');d.rectangle((0,161,255,191),fill='#8CA379')
d.line((12,178,239,178),fill='#D7D5AC',width=4)
save('heldout-landscape','保留组：平涂风景','heldout',im,(64,48))

photo_info={
 'astronaut':('真实照片：宇航员','development','NASA; public domain / no known copyright restrictions'),
 'chelsea':('保留组：猫咪照片','heldout','Stefan van der Walt; CC0'),
 'rocket':('保留组：火箭照片','heldout','SpaceX; public domain')}
for name,(title,split,license_) in photo_info.items():
    path=DATA/(name+('.jpg' if name=='rocket' else '.png'))
    if not path.exists():raise RuntimeError(f'Missing official scikit-image source fixture: {path}')
    im=Image.open(path).convert('RGBA');im.thumbnail((320,320),Image.Resampling.LANCZOS)
    width=64; height=round(im.height/im.width*width)
    save('photo-'+name,title,split,im,(width,height),note=license_+'; official scikit-image v0.25.2 data')

(ROOT/'fixtures.json').write_text(json.dumps(fixtures,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'Prepared {len(fixtures)} deterministic fixtures; development={sum(f["split"]=="development" for f in fixtures)} heldout={sum(f["split"]=="heldout" for f in fixtures)}')
