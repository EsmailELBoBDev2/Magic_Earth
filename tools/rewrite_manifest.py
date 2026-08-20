#!/usr/bin/env python3
import argparse, re, sys, xml.etree.ElementTree as ET
from pathlib import Path

ANDROID='http://schemas.android.com/apk/res/android'
A='{%s}'%ANDROID
ET.register_namespace('android',ANDROID)

COMPONENTS={'activity','activity-alias','service','receiver','provider'}
CLASS_ATTRS={'name','backupAgent','targetActivity','manageSpaceActivity','appComponentFactory'}
PREFIX_ATTRS={'authorities','permission','readPermission','writePermission','taskAffinity'}

def fqcn(value, oldpkg):
    if not value: return value
    if value.startswith('.'):
        return oldpkg+value
    # Android treats an unqualified class name as package-relative.
    if '.' not in value:
        return oldpkg+'.'+value
    return value

def rewrite_prefixed(value,old,new):
    if not value: return value
    # Authorities may contain semicolon-separated names.
    parts=value.split(';')
    out=[]
    for x in parts:
        x=x.strip()
        out.append(new+x[len(old):] if x.startswith(old) else x)
    return ';'.join(out)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('manifest',type=Path)
    ap.add_argument('--old-package',default='com.generalmagic.magicearth')
    ap.add_argument('--new-package',default='com.cairodrive.app')
    ap.add_argument('--label',default='CairoDrive')
    ap.add_argument('--version-code')
    ap.add_argument('--version-name-suffix',default='-cairodrive10.1')
    args=ap.parse_args()
    tree=ET.parse(args.manifest); root=tree.getroot()
    old=root.get('package')
    if old!=args.old_package:
        raise SystemExit(f'ERROR: decoded manifest package is {old!r}, expected {args.old_package!r}')
    app=root.find('application')
    if app is None: raise SystemExit('ERROR: no <application>')

    # Match AAPT2 --rename-manifest-package semantics: fully qualify every
    # package-relative component against the ORIGINAL package before changing
    # the manifest package. Otherwise .MainActivity would silently become
    # com.cairodrive.app.MainActivity even though the class lives in the
    # original DEX/native app namespace.
    for el in [app]+list(app.iter()):
        tag=el.tag.split('}')[-1]
        if el is app:
            for name in ('name','backupAgent','appComponentFactory','manageSpaceActivity'):
                k=A+name
                if k in el.attrib: el.set(k,fqcn(el.get(k),old))
        if tag in COMPONENTS:
            for name in ('name','targetActivity'):
                k=A+name
                if k in el.attrib: el.set(k,fqcn(el.get(k),old))
        for name in PREFIX_ATTRS:
            k=A+name
            if k in el.attrib: el.set(k,rewrite_prefixed(el.get(k),old,args.new_package))
        # Full package process names are safe to rename; colon-local process
        # names intentionally stay local to the new package.
        k=A+'process'
        if k in el.attrib and (el.get(k) or '').startswith(old):
            el.set(k,args.new_package+el.get(k)[len(old):])

    # App-defined permissions and their references must not collide with the
    # stock Magic Earth package when both apps are installed side-by-side.
    for el in root.iter():
        for name in ('name','permission','readPermission','writePermission'):
            k=A+name
            v=el.get(k)
            if v and v.startswith(old) and el.tag.split('}')[-1] not in COMPONENTS:
                el.set(k,args.new_package+v[len(old):])

    # CairoDrive stores its runtime-restricted Google key in private app storage.
    # Disable Android backup for the side-by-side test package so that private
    # state is not copied to cloud/device backup. This does not change stock
    # Magic Earth because the original package is untouched.
    app.set(A+'allowBackup','false')

    # Manifest hygiene from the exact 7.1.26.26 target: POST_NOTIFICATIONS is
    # declared twice and `Manifest.permission.CAPTURE_AUDIO_OUTPUT` is a literal
    # malformed permission name (not android.permission.CAPTURE_AUDIO_OUTPUT).
    # Remove only the duplicate/invalid declarations; do not strip legitimate
    # stock permissions that optional Magic Earth features may still use.
    seen_permissions=set()
    for el in list(root):
        if el.tag.split('}')[-1] != 'uses-permission':
            continue
        name=el.get(A+'name') or ''
        if name == 'Manifest.permission.CAPTURE_AUDIO_OUTPUT' or name in seen_permissions:
            root.remove(el)
            continue
        seen_permissions.add(name)

    root.set('package',args.new_package)
    app.set(A+'label',args.label)
    if args.version_code:
        if not str(args.version_code).isdigit(): raise SystemExit('ERROR: --version-code must be an integer')
        root.set(A+'versionCode',str(args.version_code))
    if args.version_name_suffix:
        vn=root.get(A+'versionName')
        if vn and not vn.endswith(args.version_name_suffix): root.set(A+'versionName',vn+args.version_name_suffix)
    tree.write(args.manifest,encoding='utf-8',xml_declaration=True)
    print(f'manifest package rewritten: {old} -> {args.new_package}')
    print('component class names preserved against original package namespace')
    print(f'application label: {args.label}')
    print('security: allowBackup=false; duplicate/invalid uses-permission entries removed')

if __name__=='__main__': main()
