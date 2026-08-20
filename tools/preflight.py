#!/usr/bin/env python3
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path

SUPPORTED = {
    # Exact arm64 libapp.so fingerprint from the analyzed Magic Earth build.
    "558e04e9a41aca50a3409ee7640785eedfefb23ff1fe787865b7595f029e19a4": {
        "name": "Magic Earth 7.1.26.26.21 analyzed arm64 build",
        "build_id": "b7188509a10e2fe7f90d3cfa65f68bc5",
        "snapshot_hash": "ace654289f5abc240509fc941453ebc5",
        "debounce_patch": "libapp+0x91bd54 exact-byte guarded",
    }
}
EXPECTED_PACKAGE = "com.generalmagic.magicearth"
SEMANTIC_MARKERS = [
    b"SearchMenuBloc", b"SearchService", b"SearchRepositoryImpl",
    b"NavigationService", b"NavigationServiceImpl", b"RoutingService",
    b"SearchAlongRouteLandmark", b"NavigationInstruction", b"laneImage",
    b"GuidedAddressSearchService", b"LandmarkAlertsViewPage", b"AddAlertLandmarkEvent",
]

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def run(cmd):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False).stdout
    except Exception:
        return ""

def find_aapt2(explicit=None):
    if explicit and Path(explicit).is_file(): return explicit
    p=shutil.which("aapt2")
    if p: return p
    bases=[os.environ.get("ANDROID_SDK_ROOT"),os.environ.get("ANDROID_HOME"),"/opt/android-sdk",str(Path.home()/"Android/Sdk")]
    cands=[]
    for base in filter(None,bases):
        bt=Path(base)/"build-tools"
        if bt.is_dir(): cands += list(bt.glob("*/aapt2"))
    return str(sorted(cands, key=lambda x:x.parent.name)[-1]) if cands else None

def package_info(apk, aapt2):
    if not aapt2: return {"package":None,"badging":"aapt2 unavailable"}
    out=run([aapt2,"dump","badging",str(apk)])
    m=re.search(r"package:\s+name='([^']+)'\s+versionCode='([^']*)'\s+versionName='([^']*)'",out)
    return {"package":m.group(1) if m else None,"versionCode":m.group(2) if m else None,"versionName":m.group(3) if m else None,"badging":out[:10000]}

def manifest_features(apk,aapt2):
    if not aapt2: return {}
    out=run([aapt2,"dump","xmltree",str(apk),"--file","AndroidManifest.xml"])
    return {
        "has_car_application_metadata": "com.google.android.gms.car.application" in out,
        "has_car_navigation_category": "androidx.car.app.category.NAVIGATION" in out,
        "mentions_car_app_service": ("CarAppService" in out or "androidx.car.app" in out),
        "manifest_dump_excerpt": "\n".join([l for l in out.splitlines() if any(k in l for k in ("car.application","category.NAVIGATION","CarAppService","service","MainActivity"))][:120])
    }

def main():
    ap=argparse.ArgumentParser(description="Fail-closed Magic Earth patch preflight")
    ap.add_argument("apk",type=Path)
    ap.add_argument("--report",type=Path)
    ap.add_argument("--aapt2")
    ap.add_argument("--allow-unknown",action="store_true",help="diagnostic only; main patcher never uses this")
    args=ap.parse_args()
    if not args.apk.is_file():
        print(f"ERROR: APK not found: {args.apk}",file=sys.stderr); return 2
    aapt2=find_aapt2(args.aapt2)
    report={"apk":str(args.apk.resolve()),"apk_sha256":sha256_bytes(args.apk.read_bytes()),"aapt2":aapt2}
    try:
        with zipfile.ZipFile(args.apk) as z:
            names=set(z.namelist())
            required=["AndroidManifest.xml","lib/arm64-v8a/libapp.so","lib/arm64-v8a/libflutter.so"]
            missing=[x for x in required if x not in names]
            report["missing_required"]=missing
            if missing: raise RuntimeError("missing required entries: "+", ".join(missing))
            libapp=z.read("lib/arm64-v8a/libapp.so")
            report["libapp_sha256"]=sha256_bytes(libapp)
            report["libapp_size"]=len(libapp)
            report["dex_files"]=sorted(n for n in names if re.fullmatch(r"classes\d*\.dex",Path(n).name))
            report["semantic_markers"]={m.decode(): (m in libapp) for m in SEMANTIC_MARKERS}
            with tempfile.NamedTemporaryFile(suffix=".so",delete=False) as f:
                f.write(libapp); tmp=f.name
            try:
                notes=run(["readelf","-n",tmp]) if shutil.which("readelf") else ""
                bid=re.search(r"Build ID:\s*([0-9a-fA-F]+)",notes)
                report["libapp_build_id"]=bid.group(1).lower() if bid else None
            finally:
                try: os.unlink(tmp)
                except OSError: pass
    except Exception as e:
        report["error"]=str(e)
        if args.report:
            args.report.parent.mkdir(parents=True,exist_ok=True); args.report.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n")
        print("PREFLIGHT: FAIL —",e,file=sys.stderr); return 3
    report.update(package_info(args.apk,aapt2))
    report["manifest_features"]=manifest_features(args.apk,aapt2)
    fp=report["libapp_sha256"]
    target=SUPPORTED.get(fp)
    report["supported_target"]=target
    report["package_ok"]=(report.get("package")==EXPECTED_PACKAGE)
    report["status"]="SUPPORTED" if target and report["package_ok"] else "UNKNOWN_OR_REPACKAGED"
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True); args.report.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n")
    print("=== Magic Earth preflight ===")
    print("APK SHA256:     ",report["apk_sha256"])
    print("Package:        ",report.get("package"))
    print("Version:        ",report.get("versionName"),"code",report.get("versionCode"))
    print("libapp SHA256:  ",fp)
    print("libapp build-id:",report.get("libapp_build_id") or "unreadable")
    print("Target:         ",target["name"] if target else "UNKNOWN")
    print("Car metadata:   ",report["manifest_features"].get("has_car_application_metadata",False))
    print("Car nav cat:    ",report["manifest_features"].get("has_car_navigation_category",False))
    if report["status"]!="SUPPORTED":
        print("\nREFUSING BLIND PATCH: this APK is not the exact analyzed binary.")
        print("A fingerprint report was generated. Rebase the hook offsets/byte patches first.")
        return 0 if args.allow_unknown else 42
    print("PREFLIGHT: PASS — exact analyzed Magic Earth build; binary patches may proceed.")
    return 0

if __name__=="__main__": raise SystemExit(main())
