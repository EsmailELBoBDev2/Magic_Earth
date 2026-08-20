#!/usr/bin/env python3
from __future__ import annotations
import re, sys, statistics
from pathlib import Path
PAT=re.compile(r"ROUTE_RECOMPUTE_(?:E2E|DONE)\b[^\n]*?\bms=(\d+)",re.I)

def vals(path):
    text=Path(path).read_text(errors='replace')
    e2e=[int(x) for x in re.findall(r"ROUTE_RECOMPUTE_E2E\b[^\n]*?\bms=(\d+)",text,re.I)]
    return e2e or [int(x) for x in re.findall(r"ROUTE_RECOMPUTE_DONE\b[^\n]*?\bms=(\d+)",text,re.I)]

def pct(a,p):
    a=sorted(a)
    if not a:return None
    if len(a)==1:return a[0]
    pos=(len(a)-1)*p; lo=int(pos); hi=min(len(a)-1,lo+1); f=pos-lo
    return round(a[lo]*(1-f)+a[hi]*f)

def summary(name,a):
    if not a:return {'name':name,'n':0}
    return {'name':name,'n':len(a),'p50':pct(a,.5),'p90':pct(a,.9),'mean':round(statistics.fmean(a)),'best':min(a),'worst':max(a),'under':sum(x<1000 for x in a)}

if len(sys.argv)!=3:
    print(f'usage: {Path(sys.argv[0]).name} STOCK_LOG EXTERNALCH_LOG',file=sys.stderr);sys.exit(2)
ss=[summary('MagicEarth/stock',vals(sys.argv[1])),summary('ExternalCh',vals(sys.argv[2]))]
for s in ss:
    if not s['n']:
        print(f"{s['name']}: no recompute samples")
        continue
    print(f"{s['name']}: n={s['n']} p50={s['p50']}ms p90={s['p90']}ms mean={s['mean']}ms best={s['best']}ms worst={s['worst']}ms sub1s={s['under']}/{s['n']} ({100*s['under']/s['n']:.1f}%)")
if all(s['n'] for s in ss):
    a,b=ss
    gain=(a['p90']-b['p90'])/a['p90']*100 if a['p90'] else 0
    print(f"p90 change vs stock: {gain:+.1f}% faster" if gain>=0 else f"p90 change vs stock: {-gain:.1f}% slower")
    if gain>=20 and b['worst']<1500:
        print('latency verdict: PROMISING (still require route-quality/traffic/roadblock validation)')
    else:
        print('latency verdict: DO NOT PROMOTE based on speed')
