#!/usr/bin/env python3
from __future__ import annotations
import argparse,re,zipfile
from pathlib import Path

def main():
    ap=argparse.ArgumentParser();ap.add_argument('apk');a=ap.parse_args();p=Path(a.apk)
    required=['ERoutePathAlgorithm','MagicEarth','startNavigation','startSimulation']
    optional=['ExternalCh','simplifiedMl','SimplifiedMl','mlch','MLCH']
    found={x:False for x in required+optional}
    with zipfile.ZipFile(p) as z:
        names=z.namelist(); gem=z.read('lib/arm64-v8a/libGEM.so')
        for n in names:
            if not re.fullmatch(r'classes\d*\.dex',Path(n).name): continue
            data=z.read(n)
            for x in found:
                if not found[x] and x.encode() in data: found[x]=True
    miss=[x for x in required if not found[x]]
    if miss:print('ROUTING SURFACE: FAIL missing='+','.join(miss));return 2
    opts=[x for x in optional if found[x]]
    print('ROUTING SURFACE: PASS')
    print('required: MagicEarth + navigation + simulation')
    print('optional algorithms detected:', ', '.join(opts) if opts else 'none')
    print('CH implementation marker:', 'yes' if b'CMapContractionHierarchy' in gem else 'not advertised')
    return 0
if __name__=='__main__':raise SystemExit(main())
