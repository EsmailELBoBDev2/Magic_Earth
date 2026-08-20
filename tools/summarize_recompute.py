#!/usr/bin/env python3
"""Summarize CairoDrive route recompute latency markers from logcat/stdin."""
from __future__ import annotations
import re, sys, statistics

text = sys.stdin.read()
PAT = re.compile(r"ROUTE_RECOMPUTE_(E2E|DONE)\b[^\n]*?\bms=(\d+)[^\n]*?(?:\bsub1s=(yes|no))?", re.I)
rows = [(kind.upper(), int(ms), (sub or '').lower()) for kind, ms, sub in PAT.findall(text)]
# E2E is the driver-facing metric when our roadblock triggered the recalculation.
e2e = [ms for kind, ms, _ in rows if kind == 'E2E']
done = [ms for kind, ms, _ in rows if kind == 'DONE']
vals = e2e if e2e else done
source = 'ROUTE_RECOMPUTE_E2E' if e2e else 'ROUTE_RECOMPUTE_DONE'

def pct(vs, p):
    if not vs: return None
    a = sorted(vs)
    if len(a) == 1: return a[0]
    pos = (len(a)-1) * p
    lo = int(pos); hi = min(len(a)-1, lo+1); f = pos-lo
    return round(a[lo]*(1-f)+a[hi]*f)

if not vals:
    print('recompute samples: 0')
    print('No ROUTE_RECOMPUTE_E2E/DONE markers found yet.')
    sys.exit(0)

under = sum(v < 1000 for v in vals)
print(f'metric: {source}')
print(f'samples: {len(vals)}')
print(f'p50: {pct(vals,0.50)} ms')
print(f'p90: {pct(vals,0.90)} ms')
print(f'best: {min(vals)} ms')
print(f'worst: {max(vals)} ms')
print(f'mean: {round(statistics.fmean(vals))} ms')
print(f'sub-1s: {under}/{len(vals)} ({under*100/len(vals):.1f}%)')
if e2e and done:
    print(f'callback/status samples also seen: {len(done)}')
