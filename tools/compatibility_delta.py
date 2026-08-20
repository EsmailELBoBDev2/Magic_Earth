#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path

REQUIRED_SEMANTIC = {"SearchService","SearchRepositoryImpl","NavigationService","RoutingService"}
REQUIRED_EXPORTS = {"native_call","native_call_createObject","set_dart_port"}
REQUIRED_ROUTING = {"ERoutePathAlgorithm","MagicEarth","startNavigation","startSimulation"}

def truthy_keys(d):
    return {k for k,v in (d or {}).items() if v}

def main():
    ap=argparse.ArgumentParser(description='Compare current APK compatibility fingerprint with known-good baseline')
    ap.add_argument('current', type=Path)
    ap.add_argument('--baseline', type=Path, default=Path('baseline/known-good.json'))
    ap.add_argument('--out', type=Path)
    a=ap.parse_args()
    cur=json.loads(a.current.read_text())
    base=json.loads(a.baseline.read_text())
    bup=base.get('upstream',{})
    result={
      'schema':1,
      'baseline':str(a.baseline),
      'current':str(a.current),
      'identity':{
        'package': {'baseline':bup.get('package'),'current':cur.get('package')},
        'versionName': {'baseline':bup.get('versionName'),'current':cur.get('versionName')},
        'versionCode': {'baseline':bup.get('versionCode'),'current':cur.get('versionCode')},
      },
      'hash_changed':{
        'apk': bup.get('apk_sha256') != cur.get('apk_sha256'),
        'libapp': bup.get('libapp_sha256') != cur.get('libapp_sha256'),
        'libgem': bup.get('libgem_sha256') != cur.get('libgem_sha256'),
      }
    }
    sections=(('semantic_markers',REQUIRED_SEMANTIC),('gem_exports',REQUIRED_EXPORTS),('routing_surface',REQUIRED_ROUTING))
    missing_required=[]
    for name,required in sections:
        old=truthy_keys(base.get(name,{})); new=truthy_keys(cur.get(name,{}))
        result[name]={
          'missing_from_baseline': sorted(old-new),
          'new_since_baseline': sorted(new-old),
          'required_missing': sorted(required-new),
        }
        missing_required += [f'{name}:{x}' for x in sorted(required-new)]
    package_changed = cur.get('package') != bup.get('package')
    tier=cur.get('compatibility_tier')
    if package_changed or missing_required or tier == 'INCOMPATIBLE': severity='HIGH'
    elif result['hash_changed']['libapp'] or result['hash_changed']['libgem']: severity='MEDIUM'
    elif result['hash_changed']['apk']: severity='LOW'
    else: severity='IDENTICAL'
    result['severity']=severity
    result['required_missing']=missing_required
    result['safe_to_attempt_patch']=severity != 'HIGH'
    text=json.dumps(result,indent=2)+'\n'
    if a.out:
        a.out.parent.mkdir(parents=True,exist_ok=True); a.out.write_text(text)
    print(text,end='')
    return 0 if result['safe_to_attempt_patch'] else 42
if __name__=='__main__': raise SystemExit(main())
