CairoDrive v22.3 V14 — Frida import-resolution fix

Fixes run #13:
  .cairodrive-frida.*/cairodrive-agent.js -> Could not resolve ./search-core.mjs etc.

Mechanism:
- generated Frida entrypoint is now a temporary file directly inside payload/;
- frida-compile 19.x sees it inside the npm project root;
- its existing ./search-core.mjs, ./nav-core.mjs and ./traffic-core.mjs imports remain valid siblings;
- dynamic relative-import precheck catches future missing modules before frida-compile;
- classifier now reports FRIDA_COMPILE_IMPORT_RESOLUTION and ignores provenance/package-lock noise.

Apply from repo root:
  mkdir -p .v14
  unzip -o ~/Downloads/CairoDrive-v22.3-V14-FRIDA-IMPORT-FIX.zip -d .v14
  ./.v14/APPLY_V14.sh
  rm -rf .v14
  ./VERIFY_REPO.sh
  git diff --check

Then stage only the two changed files:
  git add -- payload/build_patch.sh tools/classify_build_failure.py
  git commit -m "Fix Frida module resolution in CI"
  git push origin main
