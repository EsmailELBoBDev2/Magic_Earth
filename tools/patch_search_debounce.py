#!/usr/bin/env python3
"""Exact-target Magic Earth arm64 search debounce patch: 1000ms -> 400ms.

The patch is intentionally tiny and fail-closed: one AArch64 MOVZ immediate at the
verified target offset. It refuses unknown bytes so a future APK cannot be silently
corrupted.
"""
from pathlib import Path
import hashlib, sys

OFFSET=0x91BD54
ORIGINAL=bytes.fromhex('00 7d 80 d2')  # mov x0,#1000
PATCHED =bytes.fromhex('00 32 80 d2')  # mov x0,#400

if len(sys.argv)!=2:
    raise SystemExit(f'usage: {sys.argv[0]} libapp.so')
p=Path(sys.argv[1]); b=bytearray(p.read_bytes())
if len(b)<OFFSET+4: raise SystemExit('ERROR: libapp too small')
cur=bytes(b[OFFSET:OFFSET+4])
if cur==PATCHED:
    print('search debounce already 400ms')
elif cur==ORIGINAL:
    b[OFFSET:OFFSET+4]=PATCHED; p.write_bytes(b)
    print('search debounce patched: 1000ms -> 400ms')
else:
    raise SystemExit(f'ERROR: unexpected debounce bytes at 0x{OFFSET:x}: {cur.hex()}')
print('sha256',hashlib.sha256(p.read_bytes()).hexdigest())
