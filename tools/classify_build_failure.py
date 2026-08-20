#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, re
from pathlib import Path

RULES = [
    ("FRIDA_COMPILE_PROJECT_ROOT", [r"Entrypoint must be inside the project root", r"frida-compile"]),
    ("FRIDA_INSTALL_OR_BINDING", [r"frida_binding", r"npm (?:ERR|error).*frida", r"npm rebuild frida"]),
    ("GEM_GLOBAL_DISCOVERY", [r"could not derive set_dart_port globals", r"discover_gem_globals", r"set_dart_port.*not found"]),
    ("APKTOOL_OR_RESOURCE_REBUILD", [r"apktool", r"brut\.androlib", r"resources\.arsc", r"resource.*(?:error|failed)"]),
    ("MANIFEST_REWRITE", [r"rewrite_manifest", r"AndroidManifest\.xml", r"manifest.*(?:error|failed)"]),
    ("JAVA_OR_DEX_BUILD", [r"javac", r"\bd8\b", r"helper DEX", r"classes\d*\.dex"]),
    ("APK_OR_AAB_SIGNING", [r"apksigner", r"jarsigner", r"keystore", r"certificate", r"signature.*(?:error|failed)"]),
    ("AAB_OR_BUNDLETOOL", [r"bundletool", r"\.aab\b", r"universal\.apk"]),
    ("DEPENDENCY_OR_NETWORK", [r"curl: \([0-9]+\)", r"Could not resolve host", r"Connection timed out", r"npm ERR", r"HTTP [45][0-9]{2}"]),
    ("GENERIC_BUILD_FAILURE", [r"\bERROR\b", r"Process completed with exit code", r"command not found"]),
]

def read_files(root: Path):
    files=[]
    for p in sorted(root.rglob('*')):
        if p.is_file() and p.stat().st_size <= 20*1024*1024 and p.suffix.lower() in {'.log','.txt','.json'}:
            try: text=p.read_text(errors='replace')
            except Exception: continue
            files.append((p,text))
    return files

def main():
    ap=argparse.ArgumentParser(description='Classify a CairoDrive CI/build failure from saved evidence')
    ap.add_argument('evidence_dir',type=Path)
    ap.add_argument('--out',type=Path)
    a=ap.parse_args()
    files=read_files(a.evidence_dir) if a.evidence_dir.exists() else []
    hits=[]
    for category,patterns in RULES:
        matched=[]
        for p,text in files:
            lines=text.splitlines()
            for i,line in enumerate(lines,1):
                if any(re.search(rx,line,re.I) for rx in patterns):
                    matched.append({'file':str(p.relative_to(a.evidence_dir)),'line':i,'text':line[:600]})
                    if len(matched)>=20: break
            if len(matched)>=20: break
        if matched:
            hits.append({'category':category,'matches':matched})
    primary=hits[0]['category'] if hits else 'NO_BUILD_LOG_CLASSIFICATION'
    result={'schema':1,'primary':primary,'categories':[h['category'] for h in hits],'details':hits}
    text=json.dumps(result,indent=2)+'\n'
    if a.out:
        a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(text)
    print(text,end='')
if __name__=='__main__': raise SystemExit(main())
