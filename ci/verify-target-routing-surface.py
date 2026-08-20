#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, re, sys, zipfile
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
        libapp=z.read('lib/arm64-v8a/libapp.so')
    libapp_sha=hashlib.sha256(libapp).hexdigest()
    exact=(libapp_sha==EXPECTED_LIBAPP_SHA256)
    strings='\n'.join(ascii_strings(dex))
    required=['ERoutePathAlgorithm','MagicEarth','ExternalCh','startNavigation','startNavigationWithRoute','startSimulation','startSimulationWithRoute','isSimulationActive']
    missing=[x for x in required if x not in strings]
    if missing:
        print('TARGET ROUTING SURFACE: FAIL missing=' + ','.join(missing), file=sys.stderr)
        return 2
    if b'CMapContractionHierarchy' not in gem:
        print('TARGET ROUTING SURFACE: FAIL libGEM CH implementation marker missing', file=sys.stderr)
        return 4
    newer=[x for x in ['simplifiedMl','SimplifiedMl','MLCH','Mlch'] if x in strings]
    print('TARGET ROUTING SURFACE: PASS')
    print('target mode: ' + ('exact-analyzed' if exact else 'future-compatible-candidate'))
    print('libapp sha256: ' + libapp_sha)
    print('route algorithms used by CairoDrive: MagicEarth, ExternalCh')
    print('simulation: startSimulation + startSimulationWithRoute present')
    if newer:
        print('additional newer route algorithms detected but not auto-enabled: ' + ','.join(newer))
    elif exact:
        print('newer simplifiedMl/mlch enum names: absent (correct for this exact target)')
    print('libGEM contraction-hierarchy marker: present')
    return 0

if __name__=='__main__':
    raise SystemExit(main())
