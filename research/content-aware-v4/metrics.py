"""Independent evaluation: NumPy/SciPy/scikit-image, no product algorithms."""
import math
import numpy as np
from scipy import ndimage as ndi
from skimage.color import rgb2gray,rgb2lab,deltaE_ciede2000
from skimage.feature import canny

CROSS=np.array([[0,1,0],[1,1,1],[0,1,0]],dtype=np.uint8)
def rgb_lab(rgb):return rgb2lab(np.asarray(rgb,dtype=float)/255)
def delta(a,b):return deltaE_ciede2000(a,b)
def area_reference(raw,w,h):
    sh,sw=raw.shape[:2];sx,sy=sw//w,sh//h
    assert sx*w==sw and sy*h==sh
    a=raw[...,3]/255; den=a.reshape(h,sy,w,sx).mean(axis=(1,3))
    num=(raw[...,:3]*a[...,None]).reshape(h,sy,w,sx,3).mean(axis=(1,3))
    rgb=np.divide(num,den[...,None],out=np.full_like(num,255.),where=den[...,None]>0)
    return rgb,den>=100/255

def reference_saliency(raw,w,h):
    """Fixed source-only multiscale DoG proxy, shared across every method."""
    alpha=raw[...,3,None]/255
    lightness=rgb_lab(raw[...,:3]*alpha+255*(1-alpha))[...,0]
    energy=np.abs(ndi.gaussian_filter(lightness,2)-ndi.gaussian_filter(lightness,6))+.5*np.abs(ndi.gaussian_filter(lightness,4)-ndi.gaussian_filter(lightness,12))
    scale=float(np.percentile(energy,95));s=np.clip(energy/scale,0,1) if scale>1e-9 else np.zeros_like(energy)
    sy,sx=raw.shape[0]//h,raw.shape[1]//w
    return s.reshape(h,sy,w,sx).mean(axis=(1,3))

def edge_scores(reference,predicted,tolerance):
    r=np.asarray(reference,dtype=bool);p=np.asarray(predicted,dtype=bool);rn=int(r.sum());pn=int(p.sum())
    if rn==0 or pn==0:return dict(precision=1. if not pn and not rn else 0.,recall=1. if not rn and not pn else 0.,f1=1. if not rn and not pn else 0.,referenceEdges=rn,predictedEdges=pn)
    pm=int(np.count_nonzero(ndi.distance_transform_edt(~r)[p]<=tolerance));rm=int(np.count_nonzero(ndi.distance_transform_edt(~p)[r]<=tolerance))
    precision=pm/pn;recall=rm/rn
    return dict(precision=precision,recall=recall,f1=2*precision*recall/(precision+recall) if precision+recall else 0.,referenceEdges=rn,predictedEdges=pn)

def components(labels,reference_lab=None,marker_positions=()):
    labels=np.asarray(labels);h,w=labels.shape;nonempty=int(np.count_nonzero(labels>=0));tiny=0;tiny_components=0;exempt=0;compact=[];area_list=[];count=0
    salient=np.zeros((h,w),bool)
    if reference_lab is not None:
        distances=np.zeros((h,w));n=np.zeros((h,w))
        for dy,dx in [(0,1),(1,0)]:
            aa=(slice(0,h-dy),slice(0,w-dx));bb=(slice(dy,h),slice(dx,w))
            d=delta(reference_lab[aa],reference_lab[bb]);distances[aa]+=d;distances[bb]+=d;n[aa]+=1;n[bb]+=1
        salient=np.divide(distances,n,out=np.zeros_like(n),where=n>0)>=12
    for x,y in marker_positions:salient[y,x]=True
    for label in np.unique(labels):
        if label<0:continue
        cc,num=ndi.label(labels==label,CROSS)
        for k in range(1,num+1):
            m=cc==k;area=int(m.sum());count+=1
            padded=np.pad(m,1);perim=0
            for dy,dx in [(0,1),(0,-1),(1,0),(-1,0)]:perim+=int(np.count_nonzero(m&~padded[1+dy:1+dy+h,1+dx:1+dx+w]))
            compact.append(perim*perim/(4*math.pi*area));area_list.append(area)
            if area<=2:
                tiny+=area;tiny_components+=1
                if np.any(m&salient):exempt+=area
    return dict(componentCount=count,tinyComponents=tiny_components,tinyCells=tiny,nonempty=nonempty,speckleRatio=tiny/nonempty if nonempty else 0.,
                speckleBelow005=bool(nonempty and tiny/nonempty<.005),referenceSalientTinyCells=exempt,nonExemptTinyCells=tiny-exempt,
                nonExemptSpeckleRatio=(tiny-exempt)/nonempty if nonempty else 0.,compactnessMean=float(np.mean(compact)) if compact else None,
                compactnessAreaWeighted=float(np.average(compact,weights=area_list)) if compact else None)

def measure(raw,cells,w,h,palette,fixture,region=None):
    rgb_map={p['code']:np.array([int(p['hex'][i:i+2],16) for i in (1,3,5)],float) for p in palette};index={p['code']:i for i,p in enumerate(palette)}
    labels=np.array([index.get(c,-1) for c in cells]).reshape(h,w)
    rgb=np.array([rgb_map[c] if c is not None else [255.,255.,255.] for c in cells]).reshape(h,w,3)
    ref,occupied=area_reference(raw,w,h);pred=labels>=0
    occupancy=int(np.count_nonzero(pred!=occupied));valid=pred&occupied
    labs=rgb_lab(rgb);rlabs=rgb_lab(ref);errors=delta(labs,rlabs)
    reference_weights=1+2*reference_saliency(raw,w,h)
    weighted=lambda m:float(np.sum(errors[m]*reference_weights[m])/np.sum(reference_weights[m])) if m.any() else None
    out=dict(occupancyMismatch=occupancy,meanDeltaE2000=float(errors[valid].mean()) if valid.any() else None,saliencyWeightedDeltaE2000=weighted(valid),regionType=fixture.get('regionType','unavailable'),regionDeltaE2000=None,complementDeltaE2000=None,regionSaliencyWeightedDeltaE2000=None,complementSaliencyWeightedDeltaE2000=None,roiPriorityWeightedDeltaE2000=None)
    if region is not None:
        sy,sx=raw.shape[0]//h,raw.shape[1]//w;r=region.reshape(h,sy,w,sx).mean(axis=(1,3))>=127.5;rv=r&valid;bv=~r&valid
        out['regionDeltaE2000']=float(errors[rv].mean()) if rv.any() else None;out['complementDeltaE2000']=float(errors[bv].mean()) if bv.any() else None
        out['regionSaliencyWeightedDeltaE2000']=weighted(rv);out['complementSaliencyWeightedDeltaE2000']=weighted(bv)
        weights=1+r.astype(float);out['roiPriorityWeightedDeltaE2000']=float(np.sum(errors[valid]*weights[valid])/np.sum(weights[valid])) if valid.any() else None
    sh,sw=raw.shape[:2];source=raw[...,:3]*(raw[...,3,None]/255)+255*(1-raw[...,3,None]/255)
    projected=np.repeat(np.repeat(rgb,sh//h,axis=0),sw//w,axis=1)
    redge=canny(rgb2gray(source/255),sigma=1.2,low_threshold=.08,high_threshold=.2,use_quantiles=False)
    pedge=canny(rgb2gray(projected/255),sigma=1.2,low_threshold=.08,high_threshold=.2,use_quantiles=False)
    for name,tol in [('Exact',0),('Tol1',4)]:
        e=edge_scores(redge,pedge,tol)
        for field,value in e.items():out['edge'+name+field[0].upper()+field[1:]]=value
    markers=fixture.get('markers',[]);out.update(components(labels,rlabs,[(m['x'],m['y']) for m in markers]))
    out['rowTransitions']=int(np.count_nonzero((labels[:,:-1]!=labels[:,1:])&(labels[:,:-1]>=0)&(labels[:,1:]>=0)))
    out['markersTotal']=len(markers);out['markersPreserved']=0;details=[]
    for m in markers:
        x,y=m['x'],m['y'];bx,by=m['backgroundPoint'];target=rgb_lab(m['rgb']);background=rgb_lab(m['backgroundRgb']);direction=target-background
        observed=labs[y,x]-labs[by,bx];projection=float(np.dot(observed,direction)/max(np.dot(direction,direction),1e-12))
        contrast=float(delta(labs[y,x],labs[by,bx]));expected=float(delta(target,background));retention=contrast/max(expected,1e-12)
        keep=bool(labels[y,x]>=0 and labels[y,x]!=labels[by,bx] and projection>=.5 and retention>=.5)
        out['markersPreserved']+=int(keep);details.append(dict(name=m['name'],preserved=keep,contrastRetention=retention,directionalRetention=projection,targetDeltaE2000=float(delta(labs[y,x],target))))
    out['markerDetails']=details
    return out
