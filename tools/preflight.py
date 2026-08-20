#!/usr/bin/env python3
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path

SUPPORTED = {
    "558e04e9a41aca50a3409ee7640785eedfefb23ff1fe787865b7595f029e19a4": {
        "name": "Magic Earth 7.1.26.26.21 analyzed arm64 build",
        "build_id": "b7188509a10e2fe7f90d3cfa65f68bc5",
        "snapshot_hash": "ace654289f5abc240509fc941453ebc5",
        "debounce_patch": "libapp+0x91bd54 exact-byte guarded",
    }
}
EXPECTED_PACKAGE = "com.generalmagic.magicearth"
SEMANTIC_MARKERS = [
    b"SearchService", b"SearchRepositoryImpl", b"Landmark", b"LandmarkList",
    b"NavigationService", b"RoutingService", b"NavigationInstruction",
]
DEX_REQUIRED = [
    b"ERoutePathAlgorithm", b"MagicEarth", b"ExternalCh",
    b"startNavigation", b"startNavigationWithRoute",
    b"startSimulation", b"startSimulationWithRoute", b"isSimulationActive",
]
GEM_REQUIRED_EXPORTS = ["native_call", "native_call_createObject", "set_dart_port"]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(cmd):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, check=False).stdout
    except Exception:
        return ""


def find_aapt2(explicit=None):
    if explicit and Path(explicit).is_file(): return explicit
    p=shutil.which("aapt2")
    if p: return p
    bases=[os.environ.get("ANDROID_SDK_ROOT"),os.environ.get("ANDROID_HOME"),
           "/opt/android-sdk",str(Path.home()/"Android/Sdk")]
    cands=[]
    for base in filter(None,bases):
        bt=Path(base)/"build-tools"
        if bt.is_dir(): cands += list(bt.glob("*/aapt2"))
    return str(sorted(cands, key=lambda x:x.parent.name)[-1]) if cands else None


def package_info(apk, aapt2):
    if not aapt2: return {"package":None,"badging":"aapt2 unavailable"}
    out=run([aapt2,"dump","badging",str(apk)])
    m=re.search(r"package:\s+name='([^']+)'\s+versionCode='([^']*)'\s+versionName='([^']*)'",out)
    return {"package":m.group(1) if m else None,"versionCode":m.group(2) if m else None,
            "versionName":m.group(3) if m else None,"badging":out[:10000]}


def manifest_features(apk,aapt2):
    if not aapt2: return {}
    out=run([aapt2,"dump","xmltree",str(apk),"--file","AndroidManifest.xml"])
    return {
        "has_car_application_metadata": "com.google.android.gms.car.application" in out,
        "has_car_navigation_category": "androidx.car.app.category.NAVIGATION" in out,
        "mentions_car_app_service": ("CarAppService" in out or "androidx.car.app" in out),
    }


def elf_exports(data: bytes) -> set[str]:
    if not shutil.which("readelf"):
        return set()
    with tempfile.NamedTemporaryFile(suffix=".so",delete=False) as f:
        f.write(data); tmp=f.name
    try:
        out=run(["readelf","-Ws",tmp])
        names=set()
        for line in out.splitlines():
            parts=line.split()
            if len(parts) >= 8 and parts[-1] != "UND":
                names.add(parts[-1].split('@')[0])
        return names
    finally:
        try: os.unlink(tmp)
        except OSError: pass


def build_id(data: bytes):
    if not shutil.which("readelf"): return None
    with tempfile.NamedTemporaryFile(suffix=".so",delete=False) as f:
        f.write(data); tmp=f.name
    try:
        notes=run(["readelf","-n",tmp])
        m=re.search(r"Build ID:\s*([0-9a-fA-F]+)",notes)
        return m.group(1).lower() if m else None
    finally:
        try: os.unlink(tmp)
        except OSError: pass


def main():
    ap=argparse.ArgumentParser(description="Fail-closed / future-aware Magic Earth patch preflight")
    ap.add_argument("apk",type=Path)
    ap.add_argument("--report",type=Path)
    ap.add_argument("--aapt2")
    ap.add_argument("--strict-exact",action="store_true",
                    help="refuse structurally compatible future targets; exact analyzed fingerprint only")
    ap.add_argument("--allow-unknown",action="store_true",
                    help="diagnostic only; allow even incompatible targets")
    args=ap.parse_args()
    if not args.apk.is_file():
        print(f"ERROR: APK not found: {args.apk}",file=sys.stderr); return 2
    aapt2=find_aapt2(args.aapt2)
    report={"apk":str(args.apk.resolve()),"apk_sha256":sha256_bytes(args.apk.read_bytes()),"aapt2":aapt2}
    try:
        with zipfile.ZipFile(args.apk) as z:
            names=set(z.namelist())
            required=["AndroidManifest.xml","lib/arm64-v8a/libapp.so","lib/arm64-v8a/libflutter.so","lib/arm64-v8a/libGEM.so"]
            missing=[x for x in required if x not in names]
            report["missing_required"]=missing
            if missing: raise RuntimeError("missing required entries: "+", ".join(missing))
            manifest_raw=z.read("AndroidManifest.xml")
            libapp=z.read("lib/arm64-v8a/libapp.so")
            libgem=z.read("lib/arm64-v8a/libGEM.so")
            dex_names=sorted(n for n in names if re.fullmatch(r"classes\d*\.dex",Path(n).name))
            dex=b"".join(z.read(n) for n in dex_names)
            report["libapp_sha256"]=sha256_bytes(libapp)
            report["libapp_size"]=len(libapp)
            report["libapp_build_id"]=build_id(libapp)
            report["libgem_sha256"]=sha256_bytes(libgem)
            report["dex_files"]=dex_names
            report["semantic_markers"]={m.decode(): (m in libapp) for m in SEMANTIC_MARKERS}
            report["dex_markers"]={m.decode(): (m in dex) for m in DEX_REQUIRED}
            exports=elf_exports(libgem)
            report["gem_exports"]={name:(name in exports) for name in GEM_REQUIRED_EXPORTS}
            report["gem_ch_marker"]=(b"CMapContractionHierarchy" in libgem)
            pkg_ascii=EXPECTED_PACKAGE.encode("utf-8")
            pkg_utf16=EXPECTED_PACKAGE.encode("utf-16le")
            report["manifest_package_hint"]=(pkg_ascii in manifest_raw or pkg_utf16 in manifest_raw)
    except Exception as e:
        report["error"]=str(e)
        if args.report:
            args.report.parent.mkdir(parents=True,exist_ok=True)
            args.report.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n")
        print("PREFLIGHT: FAIL —",e,file=sys.stderr); return 3

    report.update(package_info(args.apk,aapt2))
    report["manifest_features"]=manifest_features(args.apk,aapt2)
    fp=report["libapp_sha256"]
    target=SUPPORTED.get(fp)
    package_value=report.get("package")
    package_ok=(package_value==EXPECTED_PACKAGE) or (
        package_value is None and aapt2 is None and bool(report.get("manifest_package_hint"))
    )
    semantic_ok=all(report["semantic_markers"].values())
    dex_ok=all(report["dex_markers"].values())
    gem_ok=all(report["gem_exports"].values())
    compatible=package_ok and semantic_ok and dex_ok and gem_ok
    report["supported_target"]=target
    report["package_ok"]=package_ok
    report["future_compatible_surface"]=compatible
    if target and package_ok:
        report["status"]="EXACT_SUPPORTED"
    elif compatible:
        report["status"]="FUTURE_COMPATIBLE_CANDIDATE"
    else:
        report["status"]="INCOMPATIBLE_OR_REPACKAGED"
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n")

    print("=== Magic Earth preflight ===")
    print("APK SHA256:     ",report["apk_sha256"])
    print("Package:        ",report.get("package"))
    print("Version:        ",report.get("versionName"),"code",report.get("versionCode"))
    print("libapp SHA256:  ",fp)
    print("libapp build-id:",report.get("libapp_build_id") or "unreadable")
    print("Target:         ",target["name"] if target else "future/unknown fingerprint")
    print("Required GEM exports:","PASS" if gem_ok else "FAIL")
    print("Required Dart/API markers:","PASS" if semantic_ok and dex_ok else "FAIL")
    print("Mode:           ",report["status"])

    if report["status"]=="EXACT_SUPPORTED":
        print("PREFLIGHT: PASS — exact analyzed build; exact binary optimization profile enabled.")
        return 0
    if report["status"]=="FUTURE_COMPATIBLE_CANDIDATE" and not args.strict_exact:
        print("PREFLIGHT: PASS — future-compatible surface detected.")
        print("Exact-offset tweaks are disabled; exported/runtime hooks remain fail-open.")
        return 0
    if args.allow_unknown:
        print("PREFLIGHT: DIAGNOSTIC OVERRIDE — unsafe target accepted by explicit request.")
        return 0
    print("\nREFUSING PATCH: required Magic Lane/CairoDrive surface is not compatible.")
    print("A fingerprint report was generated for rebase analysis.")
    return 42

if __name__=="__main__": raise SystemExit(main())
