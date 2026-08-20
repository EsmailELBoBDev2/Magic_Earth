#!/usr/bin/env python3
from __future__ import annotations
import argparse, re, sys, zipfile
from pathlib import Path

EXPECTED_LIBAPP_SHA256 = '558e04e9a41aca50a3409ee7640785eedfefb23ff1fe787865b7595f029e19a4'


def ascii_strings(data: bytes, min_len: int = 4):
    return [m.group().decode('ascii', 'ignore') for m in re.finditer(rb'[\x20-\x7e]{%d,}' % min_len, data)]


def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument('apk')
    args=ap.parse_args()
    apk=Path(args.apk)
    if not apk.is_file():
        raise SystemExit(f'APK not found: {apk}')
    with zipfile.ZipFile(apk) as z:
        dex_names=[n for n in z.namelist() if re.fullmatch(r'classes\d*\.dex', n)]
        dex=b''.join(z.read(n) for n in dex_names)
        gem=z.read('lib/arm64-v8a/libGEM.so')
    strings='\n'.join(ascii_strings(dex))
    required=['ERoutePathAlgorithm','MagicEarth','ExternalCh','startNavigation','startNavigationWithRoute','startSimulation','startSimulationWithRoute','isSimulationActive']
    missing=[x for x in required if x not in strings]
    if missing:
        print('TARGET ROUTING SURFACE: FAIL missing=' + ','.join(missing), file=sys.stderr)
        return 2
    forbidden=['simplifiedMl','SimplifiedMl','MLCH','Mlch']
    present=[x for x in forbidden if x in strings]
    if present:
        print('TARGET ROUTING SURFACE: FAIL unexpected newer enum surface=' + ','.join(present), file=sys.stderr)
        return 3
    if b'CMapContractionHierarchy' not in gem:
        print('TARGET ROUTING SURFACE: FAIL libGEM CH implementation marker missing', file=sys.stderr)
        return 4
    print('TARGET ROUTING SURFACE: PASS')
    print('route algorithms: MagicEarth, ExternalCh')
    print('simulation: startSimulation + startSimulationWithRoute present')
    print('newer simplifiedMl/mlch enum names: absent (correct for this exact target)')
    print('libGEM contraction-hierarchy marker: present')
    return 0

if __name__=='__main__':
    raise SystemExit(main())
