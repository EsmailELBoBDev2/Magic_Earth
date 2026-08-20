#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, zipfile
from pathlib import Path

KEY_PREFIXES=('AndroidManifest.xml','resources.arsc','lib/arm64-v8a/libapp.so','lib/arm64-v8a/libGEM.so','lib/arm64-v8a/libflutter.so')

def digest_stream(f):
    h=hashlib.sha256()
    for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def inventory(path:Path):
    out={}
    with zipfile.ZipFile(path) as z:
        for i in z.infolist():
            out[i.filename]={'size':i.file_size,'compressed':i.compress_size,'crc32':f'{i.CRC:08x}'}
        key={}
        for name in KEY_PREFIXES:
            if name in out:
                with z.open(name) as f:key[name]=digest_stream(f)
    return out,key

def main():
    ap=argparse.ArgumentParser();ap.add_argument('baseline',type=Path);ap.add_argument('current',type=Path);ap.add_argument('--out',type=Path)
    a=ap.parse_args(); b,bkey=inventory(a.baseline); c,ckey=inventory(a.current)
    bn=set(b); cn=set(c); common=bn&cn
    changed=[n for n in common if (b[n]['size'],b[n]['crc32']) != (c[n]['size'],c[n]['crc32'])]
    result={
      'schema':1,
      'baseline':str(a.baseline),'current':str(a.current),
      'counts':{'baseline_entries':len(b),'current_entries':len(c),'added':len(cn-bn),'removed':len(bn-cn),'changed':len(changed)},
      'added':sorted(cn-bn)[:1000],
      'removed':sorted(bn-cn)[:1000],
      'changed':[{ 'name':n,'baseline':b[n],'current':c[n]} for n in sorted(changed)[:2000]],
      'key_sha256':{n:{'baseline':bkey.get(n),'current':ckey.get(n),'changed':bkey.get(n)!=ckey.get(n)} for n in sorted(set(bkey)|set(ckey))}
    }
    text=json.dumps(result,indent=2)+'\n'
    if a.out:a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(text)
    print(text,end='')
if __name__=='__main__':raise SystemExit(main())
