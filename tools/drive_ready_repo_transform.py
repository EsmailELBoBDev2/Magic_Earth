#!/usr/bin/env python3
from pathlib import Path
import sys

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd().resolve()
AGENT = ROOT / "payload/cairodrive-google-search-only.js"
VP = ROOT / "verify_patcher.sh"
VR = ROOT / "VERIFY_REPO.sh"

def replace_once(s, old, new, label):
    n = s.count(old)
    if n != 1:
        raise SystemExit(f"ERROR: {label}: expected exactly one anchor, found {n}")
    return s.replace(old, new, 1)

def already_ready(s):
    return "const VERSION='v23.3-drive-ready-r2';" in s and "NATIVE_SEARCH_FALLBACK_DEFERRED" in s

agent = AGENT.read_text()
if already_ready(agent):
    print("drive-ready r2 transform: already applied")
    sys.exit(0)

agent = replace_once(
    agent,
    "const VERSION='v23.3-minimal-native-traffic-final';",
    "const VERSION='v23.3-drive-ready-r2';",
    "version marker",
)

agent = replace_once(
    agent,
    "const CATEGORY_CONTEXT_TTL_MS=700;\n",
    """const CATEGORY_CONTEXT_TTL_MS=700;
// Fast native-list mask: only data needed to construct a stock Magic Earth row.
// Keeping addressComponents preserves Google's structured street_number.
const FAST_SEARCH_FIELD_MASK=[
  'places.id','places.displayName','places.formattedAddress',
  'places.addressComponents','places.location','places.businessStatus',
  'places.movedPlaceId'
].join(',');
const FAST_SEARCH_MAX_RESULTS=10;
""",
    "fast search constants",
)

agent = replace_once(
    agent,
    "  const body=buildTextSearchBody(q,bias||getLocationBias(),radiusMeters,{});\n"
    "  const token=startHttpPost(TEXT_SEARCH_URL,googleHeaders(),body,false,SEARCH_READ_TIMEOUT_MS);",
    "  const body=buildTextSearchBody(q,bias||getLocationBias(),radiusMeters,{});\n"
    "  body.pageSize=Math.min(FAST_SEARCH_MAX_RESULTS,Math.max(1,Number(body.pageSize)||FAST_SEARCH_MAX_RESULTS));\n"
    "  const token=startHttpPost(TEXT_SEARCH_URL,googleHeaders(FAST_SEARCH_FIELD_MASK),body,false,SEARCH_READ_TIMEOUT_MS);",
    "typed lean request",
)
agent = replace_once(
    agent,
    "  const body=buildNearbySearchBody(types,bias||getLocationBias(),radiusMeters,inferLang(categoryName||''),{routingSummaries:false});\n"
    "  const token=startHttpPost(NEARBY_SEARCH_URL,googleHeaders(),body,false,SEARCH_READ_TIMEOUT_MS);",
    "  const body=buildNearbySearchBody(types,bias||getLocationBias(),radiusMeters,inferLang(categoryName||''),{routingSummaries:false});\n"
    "  body.maxResultCount=Math.min(FAST_SEARCH_MAX_RESULTS,Math.max(1,Number(body.maxResultCount)||FAST_SEARCH_MAX_RESULTS));\n"
    "  const token=startHttpPost(NEARBY_SEARCH_URL,googleHeaders(FAST_SEARCH_FIELD_MASK),body,false,SEARCH_READ_TIMEOUT_MS);",
    "nearby lean request",
)

agent = replace_once(
    agent,
    """  call('setName',JSON.stringify(String(place.name||'Google place')));
  if(Array.isArray(place.addressFields))call('setAddress',JSON.stringify({fields:place.addressFields}));
  call('setCoordinates',JSON.stringify({latitude:Number(place.latitude),longitude:Number(place.longitude)}));""",
    """  call('setName',JSON.stringify(String(place.name||'Google place')));
  if(Array.isArray(place.addressFields)){
    const fields=place.addressFields.slice();
    const street=String(fields[5]||'').replace(/\\s+/g,' ').trim();
    const number=String(fields[6]||'').trim();
    if(number&&street&&street!==number&&!street.startsWith(number+' '))fields[5]=`${number} ${street}`;
    // Never parse or invent a number. If Google did not provide structured
    // street_number, use Google's own formatted address as the stock display line.
    else if(!number&&String(place.formattedAddress||'').trim())fields[5]=String(place.formattedAddress).trim();
    call('setAddress',JSON.stringify({fields}));
    log(`ADDRESS_INJECT streetNumber=${number?'yes':'no'} stockDisplay=${String(fields[5]||'').slice(0,100)}`);
  }
  call('setCoordinates',JSON.stringify({latitude:Number(place.latitude),longitude:Number(place.longitude)}));""",
    "stock address display",
)

agent = replace_once(
    agent,
    """function replayStockSearch(originalRaw,reason){
  try{
    const rp=nativeCallOriginal(Memory.allocUtf8String(originalRaw),utf8Length(originalRaw));try{if(rp&&!rp.isNull())libcFree(rp);}catch(_){}
    log(`NATIVE_SEARCH_FALLBACK reason=${String(reason||'google-failure')}`);return true;
  }catch(e){log(`NATIVE_SEARCH_FALLBACK_ERROR ${String(e)}`);return false;}
}""",
    """function finishWithSafeStockFallback(listenerId,reason){
  // Async Google completion occurs after the intercepted native call returned.
  // Re-entering libGEM native_call here caused the observed 0x0 access violation.
  // Finish this request, cool Google briefly, and let the NEXT request pass
  // synchronously through the untouched stock Magic Earth call path.
  googleBlockedUntil=Math.max(googleBlockedUntil,Date.now()+15000);
  log(`NATIVE_SEARCH_FALLBACK_DEFERRED reason=${String(reason||'google-failure')} nextSearch=stock noNativeReentry=yes`);
  finishEmpty(listenerId);
}""",
    "safe stock fallback",
)

agent = replace_once(
    agent,
    """function injectPlacesAndComplete(places,listId,listenerId,generation,kind){
  let injected=0;
  for(const p of Array.isArray(places)?places:[]){
    if(generation!==searchGeneration)break;
    try{const id=createLandmark(p);pushLandmark(listId,id);injected++;}catch(e){log(`NATIVE_INJECT_ERROR ${String(e)}`);}
  }
  finishEmpty(listenerId);log(`NATIVE_INJECT kind=${kind} rows=${injected} gen=${generation}`);
}""",
    """function injectPlacesAndComplete(places,listId,listenerId,generation,kind){
  const rows=Array.isArray(places)?places:[];let injected=0,index=0;
  // Bound synchronous GEM work so a full result set cannot become one long
  // native/GL synchronization burst.
  const step=()=>{
    if(generation!==searchGeneration){finishEmpty(listenerId);return;}
    let burst=0;
    while(index<rows.length&&burst<4){
      const p=rows[index++];burst++;
      try{const id=createLandmark(p);pushLandmark(listId,id);injected++;}catch(e){log(`NATIVE_INJECT_ERROR ${String(e)}`);}
    }
    if(index<rows.length){setTimeout(step,0);return;}
    finishEmpty(listenerId);log(`NATIVE_INJECT kind=${kind} rows=${injected} gen=${generation} burstMax=4`);
  };
  step();
}""",
    "bounded injection",
)

agent = replace_once(
    agent,
    "    if(!(out&&out.suppressFallback)&&replayStockSearch(originalRaw,out&&out.reason||'google-failure'))return;\n"
    "    finishEmpty(listenerId);",
    "    if(!(out&&out.suppressFallback)){finishWithSafeStockFallback(listenerId,out&&out.reason||'google-failure');return;}\n"
    "    finishEmpty(listenerId);",
    "typed fallback call",
)
agent = replace_once(
    agent,
    "    if(!(out&&out.suppressFallback)&&replayStockSearch(originalRaw,out&&out.reason||'nearby-failure'))return;\n"
    "    finishEmpty(listenerId);",
    "    if(!(out&&out.suppressFallback)){finishWithSafeStockFallback(listenerId,out&&out.reason||'nearby-failure');return;}\n"
    "    finishEmpty(listenerId);",
    "nearby fallback call",
)

agent = replace_once(
    agent,
    """let __trafficObjectKeepAlive=null;
function configureNativeTraffic(){
  if(!Java.available)return;
  try{Java.perform(()=>{
    const car=findJavaEnum('com.magiclane.sdk.routesandnavigation.ERouteTransportMode','car');
    __carTransportValue=car?car.value:null;
    const online=findJavaEnum('com.magiclane.sdk.routesandnavigation.ETrafficUsage','online');
    if(!online||!online.obj){log('MAGICLANE_TRAFFIC_ENABLE_FAILED reason=online-enum-missing');return;}
    try{
      const Traffic=Java.use('com.magiclane.sdk.routesandnavigation.Traffic'),t=Traffic.$new(),prefs=t.getPreferences();
      prefs.setUseTraffic(online.obj);__trafficObjectKeepAlive=Java.retain(t);
      log('MAGICLANE_TRAFFIC_ENABLED mode=online source=native-sdk');
    }catch(e){log(`MAGICLANE_TRAFFIC_ENABLE_FAILED ${String(e)}`);}
  });}catch(e){log(`MAGICLANE_TRAFFIC_ENABLE_FAILED ${String(e)}`);}
}""",
    """function configureNativeTraffic(){
  if(!Java.available)return;
  try{Java.perform(()=>{
    const car=findJavaEnum('com.magiclane.sdk.routesandnavigation.ERouteTransportMode','car');
    __carTransportValue=car?car.value:null;
    // Stock Magic Earth owns its native traffic preference. A second Traffic
    // object did not enable Egypt traffic and only produced misleading offline
    // state. Google advisory + native CairoDrive paths are independent.
    log(`MAGICLANE_TRAFFIC_POLICY owner=stock forceEnable=no googleTrafficIndependent=yes carEnum=${Number.isFinite(__carTransportValue)?'resolved':'unknown'}`);
  });}catch(e){log(`MAGICLANE_TRAFFIC_POLICY_ERROR ${String(e)}`);}
}""",
    "native traffic ownership",
)

agent = replace_once(
    agent,
    "    for(const methodName of ['startNavigation','startNavigationWithRoute']){",
    "    for(const methodName of ['startNavigation','startNavigationWithRoute','startSimulation','startSimulationWithRoute']){",
    "passive simulation hooks",
)

agent = replace_once(
    agent,
    """function collectTrafficRouteSnapshot(route){
  if(!route||!Java.available)return null;
  try{
    const totalTd=route.getTimeDistance(false),remainTd=route.getTimeDistance(true);if(!totalTd||!remainTd)return null;
    const total=Number(totalTd.getTotalDistance()),remain=Number(remainTd.getTotalDistance());if(!Number.isFinite(total)||!Number.isFinite(remain)||remain<800||total<=0)return null;
    const progressed=Math.max(0,total-remain);
    const ActivityThread=Java.use('android.app.ActivityThread'),app=ActivityThread.currentApplication();if(!app)return null;
    const loc=bestLocalLocation(app.getApplicationContext());
    if(!loc||!Number.isFinite(loc.latitude)||!Number.isFinite(loc.longitude)||!Number.isFinite(loc.accuracy)||loc.accuracy>50||Date.now()-loc.time>120000)return null;
    const destination=magicRouteCoordinate(route,Math.max(0,total-2));if(!destination)return null;""",
    """function collectTrafficRouteSnapshot(route,cap){
  if(!route||!Java.available)return null;
  try{
    const totalTd=route.getTimeDistance(false),remainTd=route.getTimeDistance(true);if(!totalTd||!remainTd)return null;
    const total=Number(totalTd.getTotalDistance()),remain=Number(remainTd.getTotalDistance());if(!Number.isFinite(total)||!Number.isFinite(remain)||remain<800||total<=0)return null;
    const progressed=Math.max(0,total-remain);
    let simulation=false;
    try{simulation=!!(cap&&cap.service&&cap.listener&&typeof cap.service.isSimulationActive==='function'&&cap.service.isSimulationActive(cap.listener));}catch(_){}
    let loc=null;
    if(simulation){
      // In SDK simulation the virtual route position is authoritative; real GPS
      // is intentionally irrelevant.
      const here=magicRouteCoordinate(route,Math.min(total,progressed+2));
      const ahead=magicRouteCoordinate(route,Math.min(total,progressed+40));
      if(here)loc={latitude:here.latitude,longitude:here.longitude,accuracy:5,time:Date.now(),bearing:ahead?bearingDeg(here,ahead):NaN};
    }else{
      const ActivityThread=Java.use('android.app.ActivityThread'),app=ActivityThread.currentApplication();if(!app)return null;
      loc=bestLocalLocation(app.getApplicationContext());
    }
    if(!loc||!Number.isFinite(loc.latitude)||!Number.isFinite(loc.longitude)||!Number.isFinite(loc.accuracy)||loc.accuracy>50||Date.now()-loc.time>120000)return null;
    const destination=magicRouteCoordinate(route,Math.max(0,total-2));if(!destination)return null;""",
    "simulation-aware traffic snapshot",
)
agent = replace_once(
    agent,
    "    return {origin:{latitude:loc.latitude,longitude:loc.longitude},destination,samples,vias,total,remain,progressed,accuracyM:loc.accuracy};",
    "    return {origin:{latitude:loc.latitude,longitude:loc.longitude},destination,samples,vias,total,remain,progressed,accuracyM:loc.accuracy,mode:simulation?'simulation':'live'};",
    "snapshot mode",
)
agent = replace_once(
    agent,
    "  const t0=Date.now();log(`GOOGLE_TRAFFIC_REQUEST remainM=${Math.round(snapshot.remain)} samples=${snapshot.samples.length}`);",
    "  const t0=Date.now();log(`GOOGLE_TRAFFIC_REQUEST mode=${snapshot.mode||'live'} remainM=${Math.round(snapshot.remain)} samples=${snapshot.samples.length}`);",
    "traffic mode log",
)
agent = replace_once(
    agent,
    "  const snap=collectTrafficRouteSnapshot(route);",
    "  const snap=collectTrafficRouteSnapshot(route,cap);",
    "traffic snapshot caller",
)
agent = replace_once(
    agent,
    "  log('CAIRODRIVE_READY scope=google-places+google-traffic-advisory+native-traffic-paths+narrow-road stockUI=yes stockNavigation=yes stockInternals=untouched');",
    "  log('CAIRODRIVE_READY scope=google-places+google-traffic-advisory+native-traffic-paths+narrow-road stockUI=yes stockNavigation=yes stockInternals=untouched driveReady=r2');",
    "ready marker",
)

must = [
    "FAST_SEARCH_MAX_RESULTS=10",
    "ADDRESS_INJECT streetNumber=",
    "NATIVE_SEARCH_FALLBACK_DEFERRED",
    "noNativeReentry=yes",
    "burstMax=4",
    "'startSimulation'",
    "'startSimulationWithRoute'",
    "mode:simulation?'simulation':'live'",
    "MAGICLANE_TRAFFIC_POLICY owner=stock forceEnable=no",
    "driveReady=r2",
]
for m in must:
    if m not in agent:
        raise SystemExit(f"ERROR: transformed agent missing marker: {m}")
for forbidden in ["replayStockSearch(", "Traffic.$new()", "isNavigationActive(null)", "getNavigationRoute(null)"]:
    if forbidden in agent:
        raise SystemExit(f"ERROR: forbidden pattern remained: {forbidden}")
AGENT.write_text(agent)

# Lightweight verifier.
s = VP.read_text()
s = replace_once(
    s,
    "node traffic_core_selftest.mjs\nTMP=\"$(mktemp -d)\"",
    "node traffic_core_selftest.mjs\nnode drive_ready_corridor_selftest.mjs\nTMP=\"$(mktemp -d)\"",
    "verify_patcher corridor selftest",
)
s = replace_once(
    s,
    "grep -Fq \"VERSION='v23.3-minimal-native-traffic-final'\" payload/cairodrive-google-search-only.js",
    "grep -Fq \"VERSION='v23.3-drive-ready-r2'\" payload/cairodrive-google-search-only.js",
    "verify_patcher version",
)
insert_after = "grep -Fq 'SEARCH_INTERCEPT kind=category' payload/cairodrive-google-search-only.js\n"
extra = insert_after + """grep -Fq 'FAST_SEARCH_MAX_RESULTS=10' payload/cairodrive-google-search-only.js
grep -Fq 'ADDRESS_INJECT streetNumber=' payload/cairodrive-google-search-only.js
grep -Fq 'NATIVE_SEARCH_FALLBACK_DEFERRED' payload/cairodrive-google-search-only.js
grep -Fq 'noNativeReentry=yes' payload/cairodrive-google-search-only.js
! grep -Fq 'replayStockSearch(' payload/cairodrive-google-search-only.js
grep -Fq 'burstMax=4' payload/cairodrive-google-search-only.js
grep -Fq "'startSimulation'" payload/cairodrive-google-search-only.js
grep -Fq "'startSimulationWithRoute'" payload/cairodrive-google-search-only.js
grep -Fq 'MAGICLANE_TRAFFIC_POLICY owner=stock forceEnable=no' payload/cairodrive-google-search-only.js
! grep -Fq 'Traffic.$new()' payload/cairodrive-google-search-only.js
"""
s = replace_once(s, insert_after, extra, "verify_patcher r2 guards")
s = replace_once(
    s,
    "echo 'v23.3 minimal stock-UI + simplified optimized native traffic static verification: PASS'",
    "echo 'v23.3 drive-ready r2 stock-UI + optimized native traffic static verification: PASS'",
    "verify_patcher summary",
)
VP.write_text(s)

# Full verifier.
s = VR.read_text()
s = replace_once(
    s,
    "node traffic_core_selftest.mjs >/dev/null",
    "node traffic_core_selftest.mjs >/dev/null\nnode drive_ready_corridor_selftest.mjs >/dev/null",
    "VERIFY_REPO corridor selftest",
)
s = replace_once(
    s,
    "grep -Fq \"VERSION='v23.3-minimal-native-traffic-final'\" payload/cairodrive-google-search-only.js",
    "grep -Fq \"VERSION='v23.3-drive-ready-r2'\" payload/cairodrive-google-search-only.js",
    "VERIFY_REPO version",
)
s = replace_once(
    s,
    "grep -Fq 'MAGICLANE_TRAFFIC_ENABLED mode=online' payload/cairodrive-google-search-only.js",
    "grep -Fq 'MAGICLANE_TRAFFIC_POLICY owner=stock forceEnable=no' payload/cairodrive-google-search-only.js\n"
    "! grep -Fq 'Traffic.$new()' payload/cairodrive-google-search-only.js",
    "VERIFY_REPO traffic ownership",
)
insert_after = "grep -Fq 'SEARCH_INTERCEPT kind=category' payload/cairodrive-google-search-only.js\n"
extra = insert_after + """grep -Fq 'FAST_SEARCH_MAX_RESULTS=10' payload/cairodrive-google-search-only.js
grep -Fq 'ADDRESS_INJECT streetNumber=' payload/cairodrive-google-search-only.js
grep -Fq 'NATIVE_SEARCH_FALLBACK_DEFERRED' payload/cairodrive-google-search-only.js
grep -Fq 'noNativeReentry=yes' payload/cairodrive-google-search-only.js
! grep -Fq 'replayStockSearch(' payload/cairodrive-google-search-only.js
grep -Fq 'burstMax=4' payload/cairodrive-google-search-only.js
grep -Fq "'startSimulation'" payload/cairodrive-google-search-only.js
grep -Fq "'startSimulationWithRoute'" payload/cairodrive-google-search-only.js
grep -Fq "mode:simulation?'simulation':'live'" payload/cairodrive-google-search-only.js
"""
s = replace_once(s, insert_after, extra, "VERIFY_REPO r2 guards")
s = replace_once(
    s,
    "echo 'VERIFY_REPO: PASS — v23.3 minimal stock-UI runtime, simplified optimized native traffic paths, Google Places/traffic hygiene, narrow-road safety, stock performance preservation, monotonic Play versionCode, and Play-key signing checks pass.'",
    "echo 'VERIFY_REPO: PASS — v23.3 drive-ready r2: lean Google Places, safe stock fallback, simulation-aware Google traffic, conservative narrow-road handling, bounded native traffic rendering, stock performance preservation, monotonic Play versionCode, and Play-key signing checks pass.'",
    "VERIFY_REPO summary",
)
VR.write_text(s)

print("DRIVE_READY_R2_TRANSFORM: PASS")
