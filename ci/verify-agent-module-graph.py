#!/usr/bin/env python3
from pathlib import Path
import re, sys
root=Path(__file__).resolve().parents[1]/'payload'
entry=root/'cairodrive-google-search-only.js'
text=entry.read_text(encoding='utf-8')
imports=re.findall(r"from\s+['\"](\./[^'\"]+)['\"]", text)
if not imports:
    raise SystemExit('AGENT MODULE GRAPH: FAIL — no relative imports detected')
missing=[]
for rel in imports:
    p=(entry.parent/rel).resolve()
    if not p.is_file(): missing.append(rel)
if missing:
    raise SystemExit('AGENT MODULE GRAPH: FAIL missing=' + ','.join(missing))
expected={'./search-core.mjs','./nav-core.mjs','./traffic-core.mjs'}
if not expected.issubset(set(imports)):
    raise SystemExit('AGENT MODULE GRAPH: FAIL — expected core imports missing')
print('AGENT MODULE GRAPH: PASS')
print('relative imports: ' + ', '.join(sorted(set(imports))))
