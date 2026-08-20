#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, os, re, shutil, subprocess, tempfile, zipfile
from pathlib import Path

EXPECTED_PACKAGE='com.generalmagic.magicearth'
KNOWN_LIBAPP={'558e04e9a41aca50a3409ee7640785eedfefb23ff1fe787865b7595f029e19a4':'7.1.26.26.21 exact analyzed target'}
SEMANTIC=[b'SearchService',b'SearchRepositoryImpl',b'NavigationService',b'RoutingService',b'NavigationInstruction',b'LandmarkList']
ROUTING=[b'ERoutePathAlgorithm',b'MagicEarth',b'ExternalCh',b'startNavigation',b'startSimulation']

def sha_bytes(b): return hashlib.sha256(b).hexdigest()
def sha_file(p:Path):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''): h.update(chunk)
    return h.hexdigest()
def run(cmd): return subprocess.run(cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,check=False).stdout

def find_sdk_tool(name, explicit=None):
    if explicit and Path(explicit).is_file(): return explicit
    p=shutil.which(name)
    if p:return p
    for base in filter(None,[os.environ.get('ANDROID_SDK_ROOT'),os.environ.get('ANDROID_HOME'),'/opt/android-sdk',str(Path.home()/'Android/Sdk')]):
        bt=Path(base)/'build-tools'
        if bt.is_dir():
            c=sorted(bt.glob(f'*/{name}'),key=lambda x:x.parent.name)
            if c:return str(c[-1])
    return None

def package_info(apk,aapt2):
    if not aapt2:return None,None,None
    out=run([aapt2,'dump','badging',str(apk)])
    m=re.search(r"package:\s+name='([^']+)'\s+versionCode='([^']*)'\s+versionName='([^']*)'",out)
    return (m.group(1),m.group(2),m.group(3)) if m else (None,None,None)

def signer_info(apk,apksigner):
    if not apksigner:return None
    out=run([apksigner,'verify','--print-certs',str(apk)])
    m=re.search(r'certificate SHA-256 digest:\s*([0-9a-fA-F:]+)',out)
    return m.group(1).replace(':','').lower() if m else None

def exports(lib):
    with tempfile.NamedTemporaryFile(suffix='.so',delete=False) as f:f.write(lib);p=f.name
    try:return run(['readelf','-Ws',p])
    finally:
        try:os.unlink(p)
        except OSError:pass

def main():
    ap=argparse.ArgumentParser(description='Portable/fail-closed Magic Earth compatibility preflight')
    ap.add_argument('apk',type=Path); ap.add_argument('--report',type=Path); ap.add_argument('--aapt2'); ap.add_argument('--apksigner')
    a=ap.parse_args(); report={'schema':2,'apk':str(a.apk)}
    if not a.apk.is_file():raise SystemExit('ERROR: APK missing')
    aapt2=find_sdk_tool('aapt2',a.aapt2); apksigner=find_sdk_tool('apksigner',a.apksigner)
    report['apk_sha256']=sha_file(a.apk); report['size_bytes']=a.apk.stat().st_size
    with zipfile.ZipFile(a.apk) as z:
        names=set(z.namelist()); manifest=z.read('AndroidManifest.xml') if 'AndroidManifest.xml' in names else b''
        req=['AndroidManifest.xml','lib/arm64-v8a/libapp.so','lib/arm64-v8a/libflutter.so','lib/arm64-v8a/libGEM.so']
        miss=[x for x in req if x not in names]
        if miss:
            report['missing_required_entries']=miss
            if a.report:a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,indent=2)+'\n')
            raise SystemExit('ERROR: missing '+','.join(miss))
        app=z.read('lib/arm64-v8a/libapp.so'); gem=z.read('lib/arm64-v8a/libGEM.so')
        report['libapp_sha256']=sha_bytes(app); report['libgem_sha256']=sha_bytes(gem)
        report['libapp_size_bytes']=len(app); report['libgem_size_bytes']=len(gem)
        report['semantic_markers']={x.decode():x in app for x in SEMANTIC}
        ex=exports(gem)
        report['gem_exports']={x:bool(re.search(rf'\b{re.escape(x)}$',ex,re.M)) for x in ('native_call','native_call_createObject','set_dart_port')}
        route={x.decode():False for x in ROUTING}; dex_count=0
        for n in names:
            if re.fullmatch(r'classes\d*\.dex',Path(n).name):
                dex_count+=1; data=z.read(n)
                for marker in ROUTING:
                    if not route[marker.decode()] and marker in data: route[marker.decode()]=True
        report['routing_surface']=route
        libs=[n for n in names if n.startswith('lib/') and n.endswith('.so')]
        report['inventory']={'zip_entries':len(names),'dex_count':dex_count,'native_lib_count':len(libs),'arm64_native_lib_count':sum(n.startswith('lib/arm64-v8a/') for n in libs)}
    pkg,vc,vn=package_info(a.apk,aapt2)
    if not pkg and (EXPECTED_PACKAGE.encode() in manifest or EXPECTED_PACKAGE.encode('utf-16le') in manifest): pkg=EXPECTED_PACKAGE
    report.update(package=pkg,versionCode=vc,versionName=vn,signer_cert_sha256=signer_info(a.apk,apksigner))
    known=KNOWN_LIBAPP.get(report['libapp_sha256']); report['known_exact_target']=known
    semantic_count=sum(report['semantic_markers'].values())
    required_exports=all(report['gem_exports'].values())
    required_route=all(report['routing_surface'][x] for x in ('ERoutePathAlgorithm','MagicEarth','startNavigation','startSimulation'))
    ok=(pkg==EXPECTED_PACKAGE and required_exports and semantic_count>=4 and required_route)
    report['compatibility_tier']='KNOWN_EXACT' if ok and known else ('PORTABLE_CANDIDATE' if ok else 'INCOMPATIBLE')
    if a.report:a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,indent=2)+'\n')
    print('=== CairoDrive portable preflight ===')
    print('Package:',pkg,'Version:',vn,'code',vc)
    print('APK:',report['apk_sha256'],'size',report['size_bytes'])
    print('libapp:',report['libapp_sha256'])
    print('Tier:',report['compatibility_tier'])
    print('GEM exports:',report['gem_exports'])
    print('Semantic markers:',semantic_count,'/',len(SEMANTIC))
    print('Routing:',report['routing_surface'])
    if report.get('signer_cert_sha256'): print('Signer SHA256:',report['signer_cert_sha256'])
    if not ok:
        print('PREFLIGHT: FAIL — future build changed required routing/search/native surface; refusing unsafe patch.')
        return 42
    print('PREFLIGHT: PASS — portable native_call/bootstrap path is compatible.')
    if not known: print('NOTE: future/unknown APK accepted by structural compatibility checks; optional AOT debounce may be skipped.')
    return 0
if __name__=='__main__':raise SystemExit(main())
