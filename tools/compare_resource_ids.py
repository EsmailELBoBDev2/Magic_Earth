#!/usr/bin/env python3
import re, subprocess, sys

def ids(aapt2, apk):
    p=subprocess.run([aapt2,'dump','resources',apk],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,check=False)
    if p.returncode: raise SystemExit(f'aapt2 dump resources failed for {apk}:\n{p.stdout[:2000]}')
    # Resource table IDs are the compatibility contract that matters to already
    # compiled Java/Dart/native references. Package-name text may change; IDs may not.
    return set(re.findall(r'\b0x[0-9a-fA-F]{8}\b',p.stdout))

if len(sys.argv)!=4: raise SystemExit('usage: compare_resource_ids.py AAPT2 BEFORE.apk AFTER.apk')
a,b,c=sys.argv[1:]
x,y=ids(a,b),ids(a,c)
missing=sorted(x-y); added=sorted(y-x)
print(f'resource ids before={len(x)} after={len(y)} missing={len(missing)} added={len(added)}')
if missing or added:
    print('missing sample:',missing[:20]);print('added sample:',added[:20]);raise SystemExit(1)
print('RESOURCE-ID STABILITY: PASS')
