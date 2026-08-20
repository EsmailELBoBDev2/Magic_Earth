#!/usr/bin/env python3
import json,sys
features=[]
for path in sys.argv[1:]:
    with open(path,encoding='utf-8') as f:
        for n,line in enumerate(f,1):
            line=line.strip()
            if not line: continue
            try:
                obj=json.loads(line)
                if obj.get('type')=='Feature': features.append(obj)
            except Exception as e:
                print(f'warning: {path}:{n}: {e}',file=sys.stderr)
print(json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False,indent=2))
