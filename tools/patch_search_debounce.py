#!/usr/bin/env python3
"""Portable best-effort Magic Earth search debounce patch (1000ms -> 400ms).

The old patch used a fixed libapp offset. v22.3 instead searches for the exact
AOT instruction neighborhood and patches only when exactly one safe signature
is present. If a future compiler changes the function, the optimization is
skipped; the build still works because debounce is not required for correctness.
"""
from pathlib import Path
import argparse, hashlib

MOV1000=bytes.fromhex('00 7d 80 d2')
MOV400 =bytes.fromhex('00 32 80 d2')
# Verified target context around the MOV. Keep enough neighboring bytes to avoid
# accidentally patching an unrelated constant.
PREFIX=bytes.fromhex('c2 00 00 94 e1 03 00 aa')
SUFFIX=bytes.fromhex('20 70 00 f8 e0 03 01 aa')

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('libapp'); ap.add_argument('--required',action='store_true')
    a=ap.parse_args(); p=Path(a.libapp); b=bytearray(p.read_bytes())
    exact=PREFIX+MOV1000+SUFFIX; patched=PREFIX+MOV400+SUFFIX
    hits=[]; start=0
    while True:
        i=b.find(exact,start)
        if i<0: break
        hits.append(i+len(PREFIX)); start=i+1
    if len(hits)==1:
        off=hits[0]; b[off:off+4]=MOV400; p.write_bytes(b)
        print(f'search debounce patched by signature at 0x{off:x}: 1000ms -> 400ms')
    elif patched in b and b.count(patched)==1:
        print('search debounce already 400ms (signature matched)')
    else:
        msg=f'search debounce optimization skipped: safe signature count={len(hits)}'
        if a.required: raise SystemExit('ERROR: '+msg)
        print('WARNING:',msg)
    print('sha256',hashlib.sha256(p.read_bytes()).hexdigest())
if __name__=='__main__': main()
