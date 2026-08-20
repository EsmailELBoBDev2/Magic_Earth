#!/usr/bin/env python3
from __future__ import annotations
import argparse,re,zipfile
from pathlib import Path

def strings(data,minlen=4):return {m.group().decode('ascii','ignore') for m in re.finditer(rb'[\x20-\x7e]{%d,}'%minlen,data)}
def main():
    ap=argparse.ArgumentParser();ap.add_argument('apk');a=ap.parse_args();p=Path(a.apk)
    with zipfile.ZipFile(p) as z:
        dex=b''.join(z.read(n) for n in z.namelist() if re.fullmatch(r'classes\d*\.dex',n));gem=z.read('lib/arm64-v8a/libGEM.so')
    s='\n'.join(strings(dex))
    required=['ERoutePathAlgorithm','MagicEarth','startNavigation','startSimulation']
    miss=[x for x in required if x not in s]
    if miss:print('ROUTING SURFACE: FAIL missing='+','.join(miss));return 2
    opts=[x for x in ['ExternalCh','simplifiedMl','SimplifiedMl','mlch','MLCH'] if x in s]
    print('ROUTING SURFACE: PASS')
    print('required: MagicEarth + navigation + simulation')
    print('optional algorithms detected:', ', '.join(opts) if opts else 'none')
    print('CH implementation marker:', 'yes' if b'CMapContractionHierarchy' in gem else 'not advertised')
    return 0
if __name__=='__main__':raise SystemExit(main())
