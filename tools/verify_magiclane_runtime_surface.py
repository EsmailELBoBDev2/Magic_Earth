#!/usr/bin/env python3
import io,struct,sys,zipfile

APK=sys.argv[1] if len(sys.argv)>1 else ''
if not APK: raise SystemExit('usage: verify_magiclane_runtime_surface.py APK')

def uleb(b,p):
    v=0;s=0
    while True:
        x=b[p];p+=1;v|=(x&0x7f)<<s
        if x<0x80:return v,p
        s+=7
        if s>35:raise ValueError('bad uleb')

def methods(b):
    if not b.startswith(b'dex\n'):return []
    ss,so=struct.unpack_from('<II',b,56);ts,to=struct.unpack_from('<II',b,64);ps,po=struct.unpack_from('<II',b,72);ms,mo=struct.unpack_from('<II',b,88)
    strings=[]
    for i in range(ss):
        off=struct.unpack_from('<I',b,so+4*i)[0];_,p=uleb(b,off);e=b.index(0,p);strings.append(b[p:e].decode('utf-8','replace'))
    types=[strings[struct.unpack_from('<I',b,to+4*i)[0]] for i in range(ts)]
    protos=[]
    for i in range(ps):
        _,ret,params=struct.unpack_from('<III',b,po+12*i);args=[]
        if params:
            n=struct.unpack_from('<I',b,params)[0]
            args=[types[struct.unpack_from('<H',b,params+4+2*j)[0]] for j in range(n)]
        protos.append((types[ret],tuple(args)))
    out=[]
    for i in range(ms):
        ci,pi,ni=struct.unpack_from('<HHI',b,mo+8*i);out.append((types[ci],strings[ni],protos[pi]))
    return out

allm=[]
with zipfile.ZipFile(APK) as z:
    dex=sorted(n for n in z.namelist() if n.startswith('classes') and n.endswith('.dex'))
    if not dex: raise SystemExit('ERROR: no DEX files in APK')
    for n in dex: allm.extend(methods(z.read(n)))
S=set(allm)
def need(cls,name,ret,args):
    sig=(cls,name,(ret,tuple(args)))
    if sig not in S: raise SystemExit('ERROR: Magic Lane runtime surface changed: '+repr(sig))

C='Lcom/magiclane/sdk/places/Coordinates;'
need(C,'<init>','V',[])
need(C,'setLatitude','V',['D']);need(C,'setLongitude','V',['D'])
need('Lcom/magiclane/sdk/core/Path$Companion;','produceWithCoords','Lcom/magiclane/sdk/core/Path;',['Ljava/util/ArrayList;'])
need('Lcom/magiclane/sdk/core/GemSurfaceView;','getMapView','Lcom/magiclane/sdk/d3scene/MapView;',[])
need('Lcom/magiclane/sdk/d3scene/MapView;','isFollowingPosition','Z',[])
need('Lcom/magiclane/sdk/d3scene/MapViewPreferences;','getPaths','Lcom/magiclane/sdk/core/MapViewPathCollection;',[])
need('Lcom/magiclane/sdk/core/MapViewPathCollection;','add','V',['Lcom/magiclane/sdk/core/Path;','Lcom/magiclane/sdk/core/Rgba;','Lcom/magiclane/sdk/core/Rgba;','D','D'])
RGBA='Lcom/magiclane/sdk/core/Rgba;'
need(RGBA,'<init>','V',[])
for n in ('setRed','setGreen','setBlue','setAlpha'): need(RGBA,n,'V',['I'])
need('Lcom/magiclane/sdk/routesandnavigation/Route;','getCoordinateOnRoute',C,['I'])
need('Lcom/magiclane/sdk/routesandnavigation/NavigationService;','setNavigationRoadBlock','V',['I','I','Lcom/magiclane/sdk/routesandnavigation/NavigationListener;'])
need('Lcom/magiclane/sdk/util/GemCall;','execute','Ljava/lang/Object;',['Lkotlin/jvm/functions/Function0;'])
print('Magic Lane exact runtime surface: PASS')
