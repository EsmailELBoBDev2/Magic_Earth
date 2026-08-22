#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"
cd "$ROOT"

die(){ echo "ERROR: $*" >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Run this inside the Magic_Earth repository."
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || die "Switch to main first."
[[ -z "$(git status --porcelain)" ]] || die "Worktree is not clean. Commit/stash existing changes first."

echo "==> Sync current main"
git fetch origin
git pull --ff-only origin main

AGENT="payload/cairodrive-google-search-only.js"
VERIFY="verify_patcher.sh"
VERIFY_REPO="VERIFY_REPO.sh"
[[ -f "$AGENT" && -f "$VERIFY" && -f "$VERIFY_REPO" ]] || die "Expected CairoDrive files are missing."

python3 - <<'PY'
from pathlib import Path
import sys

agent_p = Path("payload/cairodrive-google-search-only.js")
verify_p = Path("verify_patcher.sh")
repo_verify_p = Path("VERIFY_REPO.sh")

agent = agent_p.read_text()
verify = verify_p.read_text()
repo_verify = repo_verify_p.read_text()

def once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"R4 patch drift: cannot find {label}")
    if text.count(old) != 1:
        raise SystemExit(f"R4 patch drift: {label} matched {text.count(old)} times, expected 1")
    return text.replace(old, new, 1)

if "RUNTIME_TUNING='r4-peak-safe'" not in agent:
    if "RUNTIME_TUNING='r3-fast-reliable'" not in agent:
        raise SystemExit("R4 requires the current R3 source.")

    agent = once(
        agent,
        "const RUNTIME_TUNING='r3-fast-reliable';",
        "const RUNTIME_TUNING='r4-peak-safe';",
        "runtime tuning marker",
    )

    agent = once(
        agent,
        "const FAST_RETRY_DELAY_MS=90;\n",
        "const FAST_RETRY_DELAY_MS=90;\n"
        "const NAV_INITIAL_ASSIST_MS=400;\n"
        "const TRAFFIC_POLL_MS=40;\n",
        "fast retry constants",
    )

    agent = once(
        agent,
        "let __navSession=null,__navGeneration=0,__routeAssistTimer=null,__trafficInFlight=false,__trafficRefreshMs=180000,__lastTrafficRoadblockAt=0;\n"
        "const __narrowAvoided=new Map();",
        "let __navSession=null,__navGeneration=0,__routeAssistTimer=null,__trafficInFlight=false,__trafficRefreshMs=180000,__lastTrafficRoadblockAt=0;\n"
        "let __roadBlockBindings=null;\n"
        "const __narrowAvoided=new Map();",
        "navigation state",
    )

    agent = once(
        agent,
        """function scheduleRouteAssist(delayMs=2000){
  try{if(__routeAssistTimer)clearTimeout(__routeAssistTimer);}catch(_){}
  __routeAssistTimer=setTimeout(routeAssistTick,Math.max(500,Number(delayMs)||2000));
}
function captureNavigationSession(service,args){
  let listener=null;
  for(const a of args||[]){if(!a)continue;const n=javaObjectClassName(a);if(/NavigationListener/.test(n)){listener=a;break;}}
  if(!listener)return;
  __navGeneration++;
  __navSession={service:Java.retain(service),listener:Java.retain(listener),at:Date.now(),generation:__navGeneration};
  __trafficRefreshMs=180000;__trafficInFlight=false;
  log(`NAV_SESSION_CAPTURED listener=${javaObjectClassName(listener)} minimalAssist=traffic+narrow`);
  scheduleRouteAssist(1800);
}""",
        """function scheduleRouteAssist(delayMs=2000){
  try{if(__routeAssistTimer)clearTimeout(__routeAssistTimer);}catch(_){}
  __routeAssistTimer=setTimeout(routeAssistTick,Math.max(250,Number(delayMs)||2000));
}
function initialAssistRetryDelay(ageMs){
  const age=Math.max(0,Number(ageMs)||0);
  if(age<1200)return 400;
  if(age<4000)return 700;
  return 1500;
}
function captureNavigationSession(service,args){
  let listener=null;
  for(const a of args||[]){if(!a)continue;const n=javaObjectClassName(a);if(/NavigationListener/.test(n)){listener=a;break;}}
  if(!listener)return;
  __navGeneration++;
  __navSession={service:Java.retain(service),listener:Java.retain(listener),at:Date.now(),generation:__navGeneration};
  __trafficRefreshMs=180000;__trafficInFlight=false;__roadBlockBindings=null;
  log(`NAV_SESSION_CAPTURED listener=${javaObjectClassName(listener)} minimalAssist=traffic+narrow firstAssistMs=${NAV_INITIAL_ASSIST_MS}`);
  scheduleRouteAssist(NAV_INITIAL_ASSIST_MS);
}""",
        "initial route assist scheduling",
    )

    old_roadblock = """function invokeNavigationRoadBlock(lengthM,startDistanceM,reason){
  const cap=__navSession;if(!cap||!routeServiceActive(cap))return false;
  const length=Math.max(30,Math.min(1200,Math.round(Number(lengthM)||0))),start=Math.max(0,Math.min(5000,Math.round(Number(startDistanceM)||0)));
  try{
    const f=cap.service.setNavigationRoadBlock,ovs=f&&f.overloads?f.overloads:[];
    for(const ov of ovs){
      const types=(ov.argumentTypes||[]).map(x=>String(x.className||x.name||x));
      if(types.filter(t=>/\\bint\\b/.test(t)).length<2)continue;
      let intIndex=0,supported=true;const mapped=[];
      for(const t of types){
        if(/\\bint\\b/.test(t))mapped.push(intIndex++===0?length:start);
        else if(/NavigationListener/.test(t))mapped.push(cap.listener);
        else if(/boolean/.test(t))mapped.push(false);
        else if(/float|double/.test(t))mapped.push(0);
        else if(/long|short|byte/.test(t))mapped.push(0);
        else mapped.push(null);
      }
      try{
        ov.call(cap.service,...mapped);
        log(`${reason==='narrow'?'NARROW':'GOOGLE_TRAFFIC'}_ROADBLOCK_APPLIED lengthM=${length} startAheadM=${start}`);
        scheduleRouteAssist(4500);return true;
      }catch(_){}
    }
  }catch(e){log(`ROADBLOCK_ERROR reason=${reason} ${String(e)}`);}
  return false;
}"""

    new_roadblock = """function resolveRoadBlockBindings(cap){
  if(__roadBlockBindings)return __roadBlockBindings;
  const out=[];
  try{
    const f=cap&&cap.service&&cap.service.setNavigationRoadBlock,ovs=f&&f.overloads?f.overloads:[];
    for(const ov of ovs){
      const types=(ov.argumentTypes||[]).map(x=>String(x.className||x.name||x));
      if(types.filter(t=>/\\bint\\b/.test(t)).length>=2)out.push({ov,types});
    }
  }catch(e){log(`ROADBLOCK_BINDING_ERROR ${String(e)}`);}
  __roadBlockBindings=out;
  log(`ROADBLOCK_BINDINGS_CACHED count=${out.length}`);
  return out;
}
function invokeNavigationRoadBlock(lengthM,startDistanceM,reason){
  const cap=__navSession;if(!cap||!routeServiceActive(cap))return false;
  const length=Math.max(30,Math.min(1200,Math.round(Number(lengthM)||0))),start=Math.max(0,Math.min(5000,Math.round(Number(startDistanceM)||0)));
  try{
    for(const binding of resolveRoadBlockBindings(cap)){
      const ov=binding.ov,types=binding.types;
      let intIndex=0;const mapped=[];
      for(const t of types){
        if(/\\bint\\b/.test(t))mapped.push(intIndex++===0?length:start);
        else if(/NavigationListener/.test(t))mapped.push(cap.listener);
        else if(/boolean/.test(t))mapped.push(false);
        else if(/float|double/.test(t))mapped.push(0);
        else if(/long|short|byte/.test(t))mapped.push(0);
        else mapped.push(null);
      }
      try{
        ov.call(cap.service,...mapped);
        log(`${reason==='narrow'?'NARROW':'GOOGLE_TRAFFIC'}_ROADBLOCK_APPLIED lengthM=${length} startAheadM=${start} bindingCached=yes`);
        scheduleRouteAssist(4500);return true;
      }catch(_){}
    }
  }catch(e){log(`ROADBLOCK_ERROR reason=${reason} ${String(e)}`);}
  return false;
}"""

    agent = once(agent, old_roadblock, new_roadblock, "native roadblock invocation")

    agent = once(
        agent,
        "const result=await new Promise(resolve=>{const tick=()=>{const r=pollHttp(token);if(!r||!r.done){setTimeout(tick,120);return;}resolve(r);};tick();});",
        "const result=await new Promise(resolve=>{const tick=()=>{const r=pollHttp(token);if(!r||!r.done){setTimeout(tick,TRAFFIC_POLL_MS);return;}resolve(r);};tick();});",
        "traffic completion polling",
    )

    old_tick = """function routeAssistTick(){
  __routeAssistTimer=null;
  const cap=__navSession;if(!cap)return;
  if(!routeServiceActive(cap)){
    if(Date.now()-cap.at<20000){scheduleRouteAssist(4000);return;}
    __navSession=null;__trafficMapPending=null;enqueueTrafficMapJob('clear','navigation-ended');return;
  }
  const route=currentRoute(cap);if(!route){scheduleRouteAssist(5000);return;}
  maybeAvoidNarrow(route);
  const snap=collectTrafficRouteSnapshot(route,cap);
  if(snap)setTimeout(()=>requestGoogleTrafficAdvice(snap,cap.generation),0);
  scheduleRouteAssist(__trafficRefreshMs);
}"""

    new_tick = """function routeAssistTick(){
  __routeAssistTimer=null;
  const cap=__navSession;if(!cap)return;
  const age=Math.max(0,Date.now()-cap.at);
  if(!routeServiceActive(cap)){
    if(age<20000){scheduleRouteAssist(initialAssistRetryDelay(age));return;}
    __navSession=null;__trafficMapPending=null;__roadBlockBindings=null;enqueueTrafficMapJob('clear','navigation-ended');return;
  }
  const route=currentRoute(cap);
  if(!route){scheduleRouteAssist(initialAssistRetryDelay(age));return;}
  maybeAvoidNarrow(route);
  const snap=collectTrafficRouteSnapshot(route,cap);
  if(snap){
    setTimeout(()=>requestGoogleTrafficAdvice(snap,cap.generation),0);
    scheduleRouteAssist(__trafficRefreshMs);
    return;
  }
  // A 400 ms first assist can legitimately beat GPS/route readiness. Retry
  // briefly instead of turning one early miss into a 2-5 minute traffic delay.
  if(age<8000){scheduleRouteAssist(initialAssistRetryDelay(age));return;}
  scheduleRouteAssist(Math.min(__trafficRefreshMs,15000));
}"""

    agent = once(agent, old_tick, new_tick, "route assist readiness loop")

# verifier updates are idempotent
if "RUNTIME_TUNING='r4-peak-safe'" not in verify:
    verify = once(
        verify,
        "grep -Fq \"RUNTIME_TUNING='r3-fast-reliable'\" payload/cairodrive-google-search-only.js",
        "grep -Fq \"RUNTIME_TUNING='r4-peak-safe'\" payload/cairodrive-google-search-only.js",
        "verify tuning marker",
    )

if "NAV_INITIAL_ASSIST_MS=400" not in verify:
    verify = once(
        verify,
        "grep -Fq 'NEARBY_POLL_MS=25' payload/cairodrive-google-search-only.js\n",
        "grep -Fq 'NEARBY_POLL_MS=25' payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'NAV_INITIAL_ASSIST_MS=400' payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'TRAFFIC_POLL_MS=40' payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'ROADBLOCK_BINDINGS_CACHED' payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'bindingCached=yes' payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'initialAssistRetryDelay' payload/cairodrive-google-search-only.js\n",
        "R4 verifier markers",
    )

verify = verify.replace(
    "echo 'v23.3 R2 + R3 fast/reliable hotfix static verification: PASS'",
    "echo 'v23.3 R2 + R4 peak-safe runtime tuning static verification: PASS'",
)

if "RUNTIME_TUNING='r4-peak-safe'" not in repo_verify:
    repo_verify = once(
        repo_verify,
        "grep -Fq \"VERSION='v23.3-drive-ready-r2'\" payload/cairodrive-google-search-only.js\n",
        "grep -Fq \"VERSION='v23.3-drive-ready-r2'\" payload/cairodrive-google-search-only.js\n"
        "grep -Fq \"RUNTIME_TUNING='r4-peak-safe'\" payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'NAV_INITIAL_ASSIST_MS=400' payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'TRAFFIC_POLL_MS=40' payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'ROADBLOCK_BINDINGS_CACHED' payload/cairodrive-google-search-only.js\n"
        "grep -Fq 'bindingCached=yes' payload/cairodrive-google-search-only.js\n",
        "repository R4 guards",
    )

agent_p.write_text(agent)
verify_p.write_text(verify)
repo_verify_p.write_text(repo_verify)
PY

echo "==> R4 source assertions"
grep -Fq "RUNTIME_TUNING='r4-peak-safe'" "$AGENT"
grep -Fq 'NAV_INITIAL_ASSIST_MS=400' "$AGENT"
grep -Fq 'TRAFFIC_POLL_MS=40' "$AGENT"
grep -Fq 'ROADBLOCK_BINDINGS_CACHED' "$AGENT"
grep -Fq 'bindingCached=yes' "$AGENT"
grep -Fq 'initialAssistRetryDelay' "$AGENT"
grep -Fq 'Math.min(__trafficRefreshMs,15000)' "$AGENT"

echo "==> Syntax + selftests"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$AGENT" "$TMP/agent.mjs"
node --check "$TMP/agent.mjs"
node search_core_selftest.mjs
node traffic_core_selftest.mjs
node drive_ready_corridor_selftest.mjs
./verify_patcher.sh
./VERIFY_REPO.sh
git diff --check

echo "==> Changes"
git diff --stat
git diff -- "$AGENT" "$VERIFY" "$VERIFY_REPO"

if git diff --quiet; then
  echo "R4 peak-safe tuning is already applied and committed."
  exit 0
fi

git add "$AGENT" "$VERIFY" "$VERIFY_REPO"
git commit -m "Reduce navigation assist latency without changing route quality"
git push origin main

echo
echo "===== R4 PEAK-SAFE APPLIED ====="
echo "Changes:"
echo "  - initial traffic/narrow assist: 1800ms -> 400ms"
echo "  - adaptive early readiness retry; no accidental 4-5s penalty"
echo "  - traffic completion poll: 120ms -> 40ms"
echo "  - setNavigationRoadBlock overload metadata cached per nav session"
echo "  - route algorithm / alternatives / traffic thresholds / narrow gates unchanged"
echo
echo "Expected runtime markers:"
echo "  NAV_SESSION_CAPTURED ... firstAssistMs=400"
echo "  ROADBLOCK_BINDINGS_CACHED count=..."
echo "  NARROW_ROADBLOCK_APPLIED ... bindingCached=yes"
echo "  GOOGLE_TRAFFIC_ROADBLOCK_APPLIED ... bindingCached=yes"
