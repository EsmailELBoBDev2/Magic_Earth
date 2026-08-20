/*
 * CairoDrive v22.3 KISS + FAST-REROUTE + AUTO-SIM A/B PLACES + TRAFFIC + DRIVE ASSIST.
 * Google Places remains the only search modification. Navigation stays Magic Lane,
 * with three cooperative assists only: online traffic preference, Fastest +
 * avoidTraffic=All + avoidUnpavedRoads for CAR route calculations, and a compact supplemental
 * alert surface driven by Magic Lane's own live instruction. Stock Magic Earth stays
 * responsible for ordinary turn/lane/ETA presentation.
 * Google Routes traffic is used only as an invisible advisory signal: CairoDrive
 * map-matches congestion against the active Magic Lane route and can ask Magic
 * Lane to reroute around a high-confidence jam. No Google route/traffic geometry
 * is rendered. Rich Google place metadata remains lazily populated.
 */

import Java from 'frida-java-bridge';
import {
  FIELD_MASK, DETAILS_FIELD_MASK, detailsFieldMaskForType, TEXT_SEARCH_URL, NEARBY_SEARCH_URL, AUTOCOMPLETE_URL, AUTOCOMPLETE_FIELD_MASK, normalizeQuery, shouldCallGoogle, safeBias,
  buildTextSearchBody, buildNearbySearchBody, googleTypesForMagicCategory, magicGenericCategoryName,
  encodeGooglePolyline, buildAutocompleteBody, parseAutocompleteResponse, parsePlacesResponse, parsePlaceDetailsResponse, classifyGoogleFailure, inferLang, openAtArrivalStatus
} from './search-core.mjs';
import {patchRouteRequestObject,eventToBanner,shouldShowBanner} from './nav-core.mjs';
import {ROUTES_URL,ROUTES_FIELD_MASK,buildTrafficRequest,parseTrafficRoutesResponse,matchMagicSamplesToTraffic,hasMeaningfulTrafficDelay,classifyTrafficLevel,trafficRefreshIntervalMs,bearingDeg} from './traffic-core.mjs';

'use strict';

const TAG = 'cairodrive';
const VERSION = 'v22.3-kiss-fast-reroute-auto-sim-ab';
const ROUTE_RECOMPUTE_TARGET_MS = 1000;
const FULL_NAV_OVERLAY = false;
const CONNECT_TIMEOUT_MS = 3500;
const READ_TIMEOUT_MS = 4000;
const CATEGORY_CONTEXT_TTL_MS = 700;

let __androidLogWrite = null;
let __androidLogTag = null;
function nativeAndroidLog(text) {
  try {
    if (!__androidLogWrite) {
      const liblog = Process.findModuleByName('liblog.so') || Process.getModuleByName('liblog.so');
      __androidLogWrite = new NativeFunction(liblog.getExportByName('__android_log_write'), 'int', ['int','pointer','pointer']);
    }
    if (!__androidLogTag) __androidLogTag = Memory.allocUtf8String(TAG);
    __androidLogWrite(4, __androidLogTag, Memory.allocUtf8String(String(text)));
  } catch (_) {}
}
let __JCairoLog = null;
const __mirrorQueue=[];
let __mirrorFlushBusy=false;
function mirrorLocalLog(text) {
  // logcat stays immediate. The persistent mirror is batched so high-frequency
  // GPS/navigation diagnostics do not cross the JS->Java bridge once per line.
  __mirrorQueue.push(String(text));
  if(__mirrorQueue.length>512)__mirrorQueue.splice(0,__mirrorQueue.length-512);
  if(__mirrorQueue.length>=24)flushMirrorLogs();
}
function flushMirrorLogs() {
  if(__mirrorFlushBusy||!Java.available||!__mirrorQueue.length)return;
  __mirrorFlushBusy=true;
  const batch=__mirrorQueue.splice(0,64).join('\n');
  try {
    Java.perform(() => {
      try {
        if (!__JCairoLog) {
          __JCairoLog = Java.use('com.cairodrive.log.CairoLog');
          const ActivityThread = Java.use('android.app.ActivityThread');
          const app = ActivityThread.currentApplication();
          if (app) __JCairoLog.init(app.getApplicationContext());
        }
        if (__JCairoLog) __JCairoLog.mirrorBatch(batch);
      } finally { __mirrorFlushBusy=false; }
    });
  } catch (_) { __mirrorFlushBusy=false; }
}
setInterval(flushMirrorLogs,1000);
function log(s) {
  const text = `[cairodrive-${VERSION}] ${String(s)}`;
  nativeAndroidLog(text);
  mirrorLocalLog(text);
}

function readStagedSecret(path) {
  try { return String(File.readAllText(path) || '').trim(); } catch (_) { return ''; }
}

// Drive-test builds can bake restricted Google keys into the compiled agent.
// The tracked private-repo config is injected by payload/build_patch.sh before
// frida-compile. Runtime staging remains available as an emergency key override.
const EMBEDDED_GOOGLE_PLACES_API_KEY = '__CAIRODRIVE_EMBEDDED_GOOGLE_PLACES_KEY__';
const EMBEDDED_GOOGLE_ROUTES_API_KEY = '__CAIRODRIVE_EMBEDDED_GOOGLE_ROUTES_KEY__';
function embeddedKey(v) {
  const s=String(v||'').trim();
  return s.startsWith('__CAIRODRIVE_EMBEDDED_') ? '' : s;
}
let GOOGLE_PLACES_API_KEY = readStagedSecret('/data/local/tmp/gpk') || embeddedKey(EMBEDDED_GOOGLE_PLACES_API_KEY);
let GOOGLE_ROUTES_API_KEY = readStagedSecret('/data/local/tmp/grk') || embeddedKey(EMBEDDED_GOOGLE_ROUTES_API_KEY);
let __privateStateLoaded = false;
let __privateStateAttemptedAt = 0;
let ANDROID_PACKAGE = 'com.cairodrive.app';
let ANDROID_CERT_SHA1 = '';
let __identityResolved = false;

function migratePrivateState(force = false) {
  const now = Date.now();
  if (!force && __privateStateLoaded) return true;
  if (!force && now - __privateStateAttemptedAt < 500) return __privateStateLoaded;
  __privateStateAttemptedAt = now;

  const staged = readStagedSecret('/data/local/tmp/gpk');
  const stagedRoutes = readStagedSecret('/data/local/tmp/grk');
  if (staged) GOOGLE_PLACES_API_KEY = staged;
  if (stagedRoutes) GOOGLE_ROUTES_API_KEY = stagedRoutes;
  if (!Java.available) return false;
  try {
    Java.perform(() => {
      const ActivityThread = Java.use('android.app.ActivityThread');
      const app = ActivityThread.currentApplication();
      if (!app) return;
      const prefs = app.getSharedPreferences('cairodrive_private', 0);
      const saved = String(prefs.getString('google_places_key', '') || '').trim();
      const savedRoutes = String(prefs.getString('google_routes_key', '') || '').trim();
      let committed=true;
      if(staged||stagedRoutes){
        const edit=prefs.edit();
        if(staged)edit.putString('google_places_key',staged);
        if(stagedRoutes)edit.putString('google_routes_key',stagedRoutes);
        committed=!!edit.commit(); // persist before deleting plaintext staging files
      }
      GOOGLE_PLACES_API_KEY = staged || saved || GOOGLE_PLACES_API_KEY;
      GOOGLE_ROUTES_API_KEY = stagedRoutes || savedRoutes || GOOGLE_ROUTES_API_KEY || GOOGLE_PLACES_API_KEY;
      if(committed){
        try { const JFile=Java.use('java.io.File'); JFile.$new('/data/local/tmp/gpk').delete(); JFile.$new('/data/local/tmp/grk').delete(); } catch (_) {}
      }
      __privateStateLoaded = true;
      log(`KEY_STATE places=${GOOGLE_PLACES_API_KEY ? 'yes' : 'no'} routes=${GOOGLE_ROUTES_API_KEY ? 'yes' : 'no'} routesKey=${GOOGLE_ROUTES_API_KEY&&GOOGLE_ROUTES_API_KEY===GOOGLE_PLACES_API_KEY?'shared':'separate'} storage=private-prefs stagingCleared=${committed?'yes':'no'}`);
    });
  } catch (e) {
    log(`KEY_STATE_ERROR ${String(e)}`);
  }
  return __privateStateLoaded;
}

function resolveIdentity() {
  if (__identityResolved) return true;
  if (!Java.available) return false;
  try {
    Java.perform(() => {
      const ActivityThread = Java.use('android.app.ActivityThread');
      const app = ActivityThread.currentApplication();
      if (!app) return;
      const ctx = app.getApplicationContext();
      const pm = ctx.getPackageManager();
      const pkg = String(ctx.getPackageName());
      const Build = Java.use('android.os.Build$VERSION');
      let certBytes;
      if (Build.SDK_INT.value >= 28) {
        const info = pm.getPackageInfo(pkg, 0x08000000);
        const si = info.signingInfo.value;
        const signers = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
        certBytes = signers[0].toByteArray();
      } else {
        const info = pm.getPackageInfo(pkg, 64);
        certBytes = info.signatures.value[0].toByteArray();
      }
      const MessageDigest = Java.use('java.security.MessageDigest');
      const digest = MessageDigest.getInstance('SHA-1').digest(certBytes);
      let hex = '';
      for (let i=0; i<digest.length; i++) hex += (digest[i] & 0xff).toString(16).padStart(2,'0');
      ANDROID_PACKAGE = pkg;
      ANDROID_CERT_SHA1 = hex.toUpperCase();
      __identityResolved = true;
      log(`IDENTITY_READY package=${ANDROID_PACKAGE} certSha1=${ANDROID_CERT_SHA1}`);
    });
  } catch (e) {
    log(`IDENTITY_ERROR ${String(e)}`);
  }
  return __identityResolved && !!ANDROID_CERT_SHA1;
}

let __locationBiasCache = null;
let __locationBiasCacheAt = 0;
function getLocationBias() {
  const now = Date.now();
  if (__locationBiasCache && now - __locationBiasCacheAt < 300000) return __locationBiasCache;
  let best = null;
  if (Java.available) {
    try {
      Java.perform(() => {
        const ActivityThread = Java.use('android.app.ActivityThread');
        const app = ActivityThread.currentApplication();
        if (!app) return;
        const LM = Java.use('android.location.LocationManager');
        const lm = Java.cast(app.getApplicationContext().getSystemService('location'), LM);
        for (const provider of ['gps','network','passive']) {
          try {
            const l = lm.getLastKnownLocation(provider);
            if (!l) continue;
            const c = {latitude:Number(l.getLatitude()), longitude:Number(l.getLongitude()), time:Number(l.getTime()), accuracy:Number(l.getAccuracy())};
            const s = safeBias(c, null);
            if (!s) continue;
            if (!best || c.time > best.time || (c.time === best.time && c.accuracy < best.accuracy)) best = c;
          } catch (_) {}
        }
      });
    } catch (_) {}
  }
  __locationBiasCache = safeBias(best);
  __locationBiasCacheAt = now;
  return __locationBiasCache;
}

let __JAsyncHttp = null;
function ensureAsyncHttp() {
  if (__JAsyncHttp) return __JAsyncHttp;
  if (!Java.available) return null;
  try {
    Java.perform(() => { __JAsyncHttp = Java.use('com.cairodrive.search.AsyncHttp'); });
    if (__JAsyncHttp) log('HTTP_HELPER_READY workers=2 places=1 traffic=1');
  } catch (e) {
    log(`HTTP_HELPER_ERROR ${String(e)}`);
    __JAsyncHttp = null;
  }
  return __JAsyncHttp;
}

function startHttpPost(url, headers, body, traffic=false, readTimeoutMs=READ_TIMEOUT_MS) {
  const H = ensureAsyncHttp();
  if (!H) return null;
  let token = null;
  try {
    Java.perform(() => {
      token = String(traffic ? H.startTrafficPostJson(String(url),JSON.stringify(headers),JSON.stringify(body),CONNECT_TIMEOUT_MS,readTimeoutMs) : H.startPostJson(String(url),JSON.stringify(headers),JSON.stringify(body),CONNECT_TIMEOUT_MS,readTimeoutMs));
    });
  } catch (e) { log(`HTTP_START_ERROR traffic=${traffic?'yes':'no'} ${String(e)}`); }
  return token;
}
function startHttp(headers,body){return startHttpPost(TEXT_SEARCH_URL,headers,body,false,READ_TIMEOUT_MS);}
function startHttpGet(url, headers) {
  const H=ensureAsyncHttp();
  if(!H)return null;
  let token=null;
  try {
    Java.perform(()=>{ token=String(H.startGetJson(String(url),JSON.stringify(headers),CONNECT_TIMEOUT_MS,READ_TIMEOUT_MS)); });
  } catch(e){ log(`HTTP_GET_START_ERROR ${String(e)}`); }
  return token;
}
function pollHttp(token) {
  if (!token || !__JAsyncHttp) return null;
  let out = null;
  try { Java.perform(() => { const r = __JAsyncHttp.poll(Number(token)); if (r !== null) out = String(r); }); }
  catch (e) { return {done:true, error:String(e)}; }
  if (out === null) return {done:false};
  if (out === 'CANCELLED') return {done:true, cancelled:true};
  if (out.startsWith('ERR:')) return {done:true, error:out.slice(4)};
  if (out.startsWith('OK:')) {
    const nl = out.indexOf('\n');
    return {done:true, status:Number(out.slice(3, nl < 0 ? undefined : nl)), body:nl < 0 ? '' : out.slice(nl+1)};
  }
  return {done:true, error:'bad-helper-response'};
}
function cancelHttp(token) {
  if (!token || !__JAsyncHttp) return;
  try { Java.perform(() => __JAsyncHttp.cancel(Number(token))); } catch (_) {}
}

let googleBlockedUntil = 0;
let googleAuthBlocked = false;
let googleRequests = 0;
let googleCancelled = 0;
let googleSuccess = 0;
let googleDetailsRequests = 0;
let googleDetailsSuccess = 0;
let googleRoutesAuthBlocked=false;
let googleRoutesBlockedUntil=0;
let googleTrafficRequests=0;
let googleTrafficSuccess=0;


let __lastFallbackToastAt = 0;
function showNativeFallbackToast(reason) {
  log(`NATIVE_SEARCH_FALLBACK reason=${String(reason||'unknown')}`);
  const now=Date.now();
  if(now-__lastFallbackToastAt<12000 || !Java.available)return;
  __lastFallbackToastAt=now;
  try{
    Java.perform(()=>{
      const ActivityThread=Java.use('android.app.ActivityThread');
      const app=ActivityThread.currentApplication(); if(!app)return;
      const Toast=Java.use('android.widget.Toast');
      Toast.makeText(app.getApplicationContext(),'Google Places unavailable — using Magic Earth search',Toast.LENGTH_SHORT.value).show();
    });
  }catch(_){}
}
let __networkAvailableCache=true;
let __networkAvailableAt=0;
function androidNetworkAvailable(force=false) {
  const now=Date.now();
  if(!force && now-__networkAvailableAt<1500)return __networkAvailableCache;
  // Connectivity is an optimization gate only. Any Java/API uncertainty fails
  // open so stock Google behavior is never disabled because of our probe.
  let available=true;
  if(Java.available){
    try{
      Java.perform(()=>{
        try{
          const ActivityThread=Java.use('android.app.ActivityThread');
          const app=ActivityThread.currentApplication(); if(!app)return;
          const CM=Java.use('android.net.ConnectivityManager');
          const svc=app.getApplicationContext().getSystemService('connectivity'); if(!svc){available=false;return;}
          const cm=Java.cast(svc,CM);
          try{
            const network=cm.getActiveNetwork(); if(!network){available=false;return;}
            const caps=cm.getNetworkCapabilities(network); if(!caps){available=false;return;}
            available=!!caps.hasCapability(12); // NET_CAPABILITY_INTERNET
          }catch(_){
            try{const info=cm.getActiveNetworkInfo();available=!!(info&&info.isConnected());}catch(__){available=true;}
          }
        }catch(_){available=true;}
      });
    }catch(_){available=true;}
  }
  __networkAvailableCache=available;__networkAvailableAt=now;return available;
}
function markPlacesNetworkFailure(){googleBlockedUntil=Math.max(googleBlockedUntil,Date.now()+4000);__networkAvailableAt=0;}

function biasFromSearchArgs(args){
  if(!args||typeof args!=='object')return null;
  for(const k of ['referenceCoordinates','referencePosition','position','coordinates']){
    const v=args[k]; if(!v||typeof v!=='object')continue;
    const b=safeBias({latitude:Number(v.latitude),longitude:Number(v.longitude)},null); if(b)return b;
  }
  return null;
}

function googleAvailableBeforeIntercept() {
  migratePrivateState();
  if(!GOOGLE_PLACES_API_KEY)return {ok:false,reason:'missing-key'};
  if(googleAuthBlocked)return {ok:false,reason:'auth-blocked'};
  if(Date.now()<googleBlockedUntil)return {ok:false,reason:'cooldown'};
  if(!androidNetworkAvailable())return {ok:false,reason:'offline'};
  // Identity normally resolves immediately after app start. If it does not,
  // fail open to stock search rather than swallowing the user's query.
  if(!resolveIdentity())return {ok:false,reason:'identity-not-ready'};
  return {ok:true,reason:''};
}

function googleHeaders(fieldMask = FIELD_MASK) {
  return {
    'Content-Type':'application/json',
    'X-Goog-Api-Key':GOOGLE_PLACES_API_KEY,
    'X-Goog-FieldMask':fieldMask,
    'X-Android-Package':ANDROID_PACKAGE,
    'X-Android-Cert':ANDROID_CERT_SHA1
  };
}

function googleRoutesHeaders() {
  return {
    'Content-Type':'application/json',
    'X-Goog-Api-Key':GOOGLE_ROUTES_API_KEY || GOOGLE_PLACES_API_KEY,
    'X-Goog-FieldMask':ROUTES_FIELD_MASK,
    'X-Android-Package':ANDROID_PACKAGE,
    'X-Android-Cert':ANDROID_CERT_SHA1
  };
}

async function googleTextSearch(query, bias, generation, radiusMeters, forceShort = false, searchOptions = {}) {
  const q = normalizeQuery(query);
  if (!forceShort && !shouldCallGoogle(q)) {
    log(`GOOGLE_SKIP reason=short-query qlen=${Array.from(q).length}`);
    return {ok:false, places:[], reason:'short-query', suppressFallback:false};
  }
  if (!q) return {ok:false, places:[], reason:'empty-query', suppressFallback:true};
  if(!androidNetworkAvailable()){log('GOOGLE_BLOCKED reason=offline');return {ok:false,places:[],reason:'offline'};}
  migratePrivateState();
  if (!GOOGLE_PLACES_API_KEY) {
    log('GOOGLE_BLOCKED reason=missing-key');
    return {ok:false, places:[], reason:'missing-key'};
  }
  if (!resolveIdentity()) {
    log('GOOGLE_BLOCKED reason=identity-not-ready');
    return {ok:false, places:[], reason:'identity-not-ready'};
  }
  if (googleAuthBlocked) {
    log('GOOGLE_BLOCKED reason=auth-blocked-until-restart-or-new-key');
    return {ok:false, places:[], reason:'auth-blocked'};
  }
  if (Date.now() < googleBlockedUntil) {
    log(`GOOGLE_BLOCKED reason=cooldown remainingMs=${googleBlockedUntil-Date.now()}`);
    return {ok:false, places:[], reason:'cooldown'};
  }

  const body = buildTextSearchBody(q, bias || getLocationBias(), radiusMeters || 50000, searchOptions || {});
  const token = startHttp(googleHeaders(searchOptions&&searchOptions.searchAlongRouteEncoded?`${FIELD_MASK},routingSummaries`:FIELD_MASK), body);
  if (!token) return {ok:false, places:[], reason:'http-helper-unavailable'};
  googleRequests++;
  const t0 = Date.now();
  log(`GOOGLE_REQUEST endpoint=text qlen=${Array.from(q).length} lang=${inferLang(q)} requestNo=${googleRequests} alongRoute=${searchOptions&&searchOptions.searchAlongRouteEncoded?'yes':'no'} routingSummaries=${searchOptions&&searchOptions.searchAlongRouteEncoded?'yes':'no'}`);

  return await new Promise(resolve => {
    const tick = () => {
      if (generation !== searchGeneration) {
        cancelHttp(token);
        googleCancelled++;
        log(`HTTP_CANCEL reason=stale gen=${generation} current=${searchGeneration}`);
        resolve({ok:false, places:[], reason:'stale', suppressFallback:true});
        return;
      }
      const r = pollHttp(token);
      if (!r || !r.done) { setTimeout(tick, 50); return; }
      if (r.cancelled) { resolve({ok:false, places:[], reason:'cancelled', suppressFallback:true}); return; }
      if (r.error) {
        markPlacesNetworkFailure();
        log(`GOOGLE_NETWORK_ERROR ${String(r.error).slice(0,180)}`);
        resolve({ok:false, places:[], reason:'network'});
        return;
      }
      if (r.status < 200 || r.status >= 300) {
        const f = classifyGoogleFailure(r.status, r.body);
        if (f.kind === 'auth') googleAuthBlocked = true;
        else if (Number.isFinite(f.cooldownMs) && f.cooldownMs > 0) googleBlockedUntil = Date.now() + f.cooldownMs;
        log(`GOOGLE_HTTP status=${r.status} kind=${f.kind} code=${f.code || 'none'} message=${String(f.message || '').slice(0,140)}`);
        resolve({ok:false, places:[], reason:`http-${r.status}`});
        return;
      }
      try {
        const places = parsePlacesResponse(r.body);
        googleSuccess++;
        log(`GOOGLE_OK results=${places.length} ms=${Date.now()-t0} successNo=${googleSuccess}`);
        resolve({ok:true, places, reason:''});
      } catch (e) {
        log(`GOOGLE_PARSE_ERROR ${String(e)}`);
        resolve({ok:false, places:[], reason:'parse'});
      }
    };
    tick();
  });
}


async function googleNearbySearch(categoryId, categoryName, bias, generation, radiusMeters=25000, typesOverride=null) {
  const types=Array.isArray(typesOverride)&&typesOverride.length?[...new Set(typesOverride)]:googleTypesForMagicCategory(categoryId,categoryName);
  if(!types.length)return {ok:false,places:[],reason:'unmapped-category',textFallback:true};
  if(!androidNetworkAvailable()){log(`GOOGLE_NEARBY_BLOCKED categoryId=${categoryId} reason=offline`);return {ok:false,places:[],reason:'offline'};}
  migratePrivateState();
  if(!GOOGLE_PLACES_API_KEY||!resolveIdentity()||googleAuthBlocked||Date.now()<googleBlockedUntil)return {ok:false,places:[],reason:'google-blocked'};
  const routeAware=navigationStillActive();
  const body=buildNearbySearchBody(types,bias||getLocationBias(),radiusMeters,inferLang(categoryName||''),{routingSummaries:routeAware});
  const token=startHttpPost(NEARBY_SEARCH_URL,googleHeaders(routeAware?`${FIELD_MASK},routingSummaries`:FIELD_MASK),body,false,READ_TIMEOUT_MS);
  if(!token)return {ok:false,places:[],reason:'http-helper-unavailable'};
  googleRequests++;const t0=Date.now();
  log(`GOOGLE_NEARBY_REQUEST categoryId=${categoryId} types=${types.join(',')} rank=DISTANCE requestNo=${googleRequests} routingSummaries=${routeAware?'traffic-aware':'no'}`);
  return await new Promise(resolve=>{const tick=()=>{
    if(generation!==searchGeneration){cancelHttp(token);googleCancelled++;resolve({ok:false,places:[],reason:'stale',suppressFallback:true});return;}
    const r=pollHttp(token);if(!r||!r.done){setTimeout(tick,100);return;}
    if(r.cancelled){resolve({ok:false,places:[],reason:'cancelled',suppressFallback:true});return;}
    if(r.error){markPlacesNetworkFailure();log(`GOOGLE_NEARBY_NETWORK_ERROR ${String(r.error).slice(0,160)}`);resolve({ok:false,places:[],reason:'network'});return;}
    if(r.status<200||r.status>=300){const f=classifyGoogleFailure(r.status,r.body);if(f.kind==='auth')googleAuthBlocked=true;else if(Number.isFinite(f.cooldownMs)&&f.cooldownMs>0)googleBlockedUntil=Date.now()+f.cooldownMs;log(`GOOGLE_NEARBY_HTTP status=${r.status} kind=${f.kind}`);resolve({ok:false,places:[],reason:`http-${r.status}`});return;}
    try{const places=parsePlacesResponse(r.body);googleSuccess++;log(`GOOGLE_NEARBY_OK categoryId=${categoryId} results=${places.length} ms=${Date.now()-t0}`);resolve({ok:true,places,reason:''});}catch(e){log(`GOOGLE_NEARBY_PARSE_ERROR ${String(e)}`);resolve({ok:false,places:[],reason:'parse'});}
  };tick();});
}


let googleAutocompleteRequests=0;
function newAutocompleteSessionToken(){
  let token=`cd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if(Java.available){try{Java.perform(()=>{try{const U=Java.use('java.util.UUID');token=String(U.randomUUID().toString());}catch(_){}});}catch(_){}}
  return token;
}
async function googleAutocomplete(query,bias,generation,sessionToken){
  const q=normalizeQuery(query);
  if(!shouldCallGoogle(q))return {ok:false,predictions:[],reason:'short-query',suppressFallback:true};
  if(!androidNetworkAvailable())return {ok:false,predictions:[],reason:'offline'};
  migratePrivateState();
  if(!GOOGLE_PLACES_API_KEY||!resolveIdentity()||googleAuthBlocked||Date.now()<googleBlockedUntil)return {ok:false,predictions:[],reason:'google-blocked'};
  const body=buildAutocompleteBody(q,bias||getLocationBias(),sessionToken,50000);
  const token=startHttpPost(AUTOCOMPLETE_URL,googleHeaders(AUTOCOMPLETE_FIELD_MASK),body,false,READ_TIMEOUT_MS);
  if(!token)return {ok:false,predictions:[],reason:'http-helper-unavailable'};
  googleRequests++;googleAutocompleteRequests++;const t0=Date.now();
  log(`AUTOCOMPLETE_REQUEST qlen=${Array.from(q).length} requestNo=${googleRequests} session=yes`);
  return await new Promise(resolve=>{const tick=()=>{
    if(generation!==searchGeneration){cancelHttp(token);googleCancelled++;resolve({ok:false,predictions:[],reason:'stale',suppressFallback:true});return;}
    const r=pollHttp(token);if(!r||!r.done){setTimeout(tick,100);return;}
    if(r.cancelled){resolve({ok:false,predictions:[],reason:'cancelled',suppressFallback:true});return;}
    if(r.error){markPlacesNetworkFailure();log(`AUTOCOMPLETE_NETWORK_ERROR ${String(r.error).slice(0,160)}`);resolve({ok:false,predictions:[],reason:'network'});return;}
    if(r.status<200||r.status>=300){const f=classifyGoogleFailure(r.status,r.body);if(f.kind==='auth')googleAuthBlocked=true;else if(Number.isFinite(f.cooldownMs)&&f.cooldownMs>0)googleBlockedUntil=Date.now()+f.cooldownMs;log(`AUTOCOMPLETE_HTTP status=${r.status} kind=${f.kind}`);resolve({ok:false,predictions:[],reason:`http-${r.status}`});return;}
    try{const predictions=parseAutocompleteResponse(r.body);log(`AUTOCOMPLETE_OK count=${predictions.length} ms=${Date.now()-t0}`);resolve({ok:true,predictions,reason:''});}catch(e){log(`AUTOCOMPLETE_PARSE_ERROR ${String(e)}`);resolve({ok:false,predictions:[],reason:'parse'});}
  };tick();});
}


async function googlePlaceDetails(placeId, query, generation, sessionToken="", movedDepth=0, movedSeen=null, primaryTypeHint="") {
  const pid=String(placeId||'').trim();
  if(!pid)return {ok:false,place:null,reason:'missing-place-id'};
  const seen=movedSeen instanceof Set?movedSeen:new Set();
  if(seen.has(pid))return {ok:false,place:null,reason:'moved-place-loop'};
  seen.add(pid);
  if(!androidNetworkAvailable())return {ok:false,place:null,reason:'offline'};
  migratePrivateState();
  if(!GOOGLE_PLACES_API_KEY||googleAuthBlocked||Date.now()<googleBlockedUntil)return {ok:false,place:null,reason:'google-blocked'};
  const sessionQ=sessionToken?`&sessionToken=${encodeURIComponent(String(sessionToken))}`:'';
  const url=`https://places.googleapis.com/v1/places/${encodeURIComponent(pid)}?languageCode=${encodeURIComponent(inferLang(query||''))}&regionCode=EG${sessionQ}`;
  const detailsMask=detailsFieldMaskForType(primaryTypeHint);
  const token=startHttpGet(url,googleHeaders(detailsMask));
  if(!token)return {ok:false,place:null,reason:'http-helper-unavailable'};
  googleRequests++; googleDetailsRequests++;
  const t0=Date.now();
  log(`PLACE_DETAILS_REQUEST placeId=${pid.slice(0,80)} requestNo=${googleRequests} typeHint=${String(primaryTypeHint||'generic').slice(0,50)} fields=${detailsMask.split(',').length}`);
  return await new Promise(resolve=>{
    const tick=()=>{
      if(generation!==searchGeneration){cancelHttp(token);googleCancelled++;log(`PLACE_DETAILS_CANCEL reason=stale placeId=${pid.slice(0,60)}`);resolve({ok:false,place:null,reason:'stale'});return;}
      const r=pollHttp(token);
      if(!r||!r.done){setTimeout(tick,100);return;}
      if(r.cancelled){resolve({ok:false,place:null,reason:'cancelled'});return;}
      if(r.error){markPlacesNetworkFailure();log(`PLACE_DETAILS_NETWORK_ERROR ${String(r.error).slice(0,180)}`);resolve({ok:false,place:null,reason:'network'});return;}
      if(r.status<200||r.status>=300){
        const f=classifyGoogleFailure(r.status,r.body);
        if(f.kind==='auth')googleAuthBlocked=true;
        else if(Number.isFinite(f.cooldownMs)&&f.cooldownMs>0)googleBlockedUntil=Date.now()+f.cooldownMs;
        log(`PLACE_DETAILS_HTTP status=${r.status} kind=${f.kind}`);
        resolve({ok:false,place:null,reason:`http-${r.status}`});return;
      }
      try{
        const rawPlace=JSON.parse(r.body||'{}');
        const moved=String(rawPlace&&rawPlace.movedPlaceId||'').trim();
        if(String(rawPlace&&rawPlace.businessStatus||'')==='CLOSED_PERMANENTLY'&&moved&&moved!==pid){
          if(movedDepth>=5||seen.has(moved)){
            log(`PLACE_DETAILS_MOVED_STOP from=${pid.slice(0,60)} to=${moved.slice(0,60)} reason=${movedDepth>=5?'depth-limit':'loop'}`);
            resolve({ok:false,place:null,reason:'moved-place-chain'});return;
          }
          log(`PLACE_DETAILS_MOVED_FOLLOW depth=${movedDepth+1} from=${pid.slice(0,60)} to=${moved.slice(0,60)}`);
          googlePlaceDetails(moved,query,generation,sessionToken,movedDepth+1,seen,String(rawPlace&&rawPlace.primaryType||primaryTypeHint||'')).then(resolve);
          return;
        }
        const place=parsePlaceDetailsResponse(rawPlace,{placeId:pid});
        if(!place)throw new Error('invalid-place-details');
        googleDetailsSuccess++;
        log(`PLACE_DETAILS_OK placeId=${pid.slice(0,80)} ms=${Date.now()-t0} navPoint=${place.navigationPoint?'yes':'no'} detailsSuccess=${googleDetailsSuccess}`);
        resolve({ok:true,place,reason:''});
      }catch(e){log(`PLACE_DETAILS_PARSE_ERROR ${String(e)}`);resolve({ok:false,place:null,reason:'parse'});}
    };tick();
  });
}

function utf8Length(s) {
  let n=0;
  for (let i=0;i<s.length;i++) {
    const c=s.charCodeAt(i);
    if(c<0x80)n++; else if(c<0x800)n+=2;
    else if(c>=0xd800&&c<=0xdbff&&i+1<s.length&&s.charCodeAt(i+1)>=0xdc00&&s.charCodeAt(i+1)<=0xdfff){n+=4;i++;}
    else n+=3;
  }
  return n;
}
function extractIntegerText(raw,key) {
  const re=new RegExp('"'+key.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')+'"\\s*:\\s*(-?\\d+)');
  const m=re.exec(raw); return m?m[1]:null;
}
function extractResultId(raw) { const m=/"result"\s*:\s*(-?\d+)/.exec(raw); return m?m[1]:null; }

let gem=null, nativeCallOriginal=null, nativeCreate=null, libcFree=null, libcStrdup=null;
let dartPort=null, postCObject=null, replacementKeepAlive=null;

function callGemRaw(raw,createObject) {
  const p=Memory.allocUtf8String(raw);
  const fn=createObject?nativeCreate:nativeCallOriginal;
  const rp=fn(p,utf8Length(raw));
  if(rp.isNull())throw new Error('libGEM returned NULL');
  const text=rp.readUtf8String();
  try{libcFree(rp);}catch(_){}
  return text;
}
function callGemObject(id,className,method,argsJson,dependencyId=-1) {
  const raw='{"id":'+id+',"class":'+JSON.stringify(className)+',"method":'+JSON.stringify(method)+',"args":'+argsJson+',"dependencyId":'+dependencyId+'}';
  return callGemRaw(raw,false);
}
function resolveMagicLaneCategoryName(categoryId) {
  const n=Number(categoryId); if(!Number.isFinite(n))return '';
  for(const method of ['getCategory','getGenericCategory']) {
    try {
      const resp=callGemRaw('{"id":0,"class":"GenericCategories","method":'+JSON.stringify(method)+',"args":'+Math.trunc(n)+',"dependencyId":-1}',false);
      const objId=extractResultId(resp); if(!objId)continue;
      const nameResp=callGemObject(objId,'LandmarkCategory','getName','{}');
      const d=JSON.parse(String(nameResp));
      const name=d&&typeof d.result==='string'?d.result.trim():'';
      if(name)return name;
    } catch (_) {}
  }
  return magicGenericCategoryName(n);
}


const __googleLandmarkBindings=new Map();
let __activeGoogleDestination=null;
function bindGoogleLandmark(landmarkId, place, query='') {
  const id=String(landmarkId);
  if(!place||!place.placeId)return;
  __googleLandmarkBindings.set(id,{landmarkId:Number(landmarkId),placeId:String(place.placeId),query:String(query||''),place,createdAt:Date.now(),detailsRequested:!!place.richLoaded,richLoaded:!!place.richLoaded});
  if(__googleLandmarkBindings.size>160){
    const rows=[...__googleLandmarkBindings.entries()].sort((a,b)=>Number(a[1].createdAt)-Number(b[1].createdAt));
    for(const [k] of rows.slice(0,rows.length-120))__googleLandmarkBindings.delete(k);
  }
}
function collectRequestIntegers(v,out,depth=0){
  if(depth>9||v===null||v===undefined)return;
  if(typeof v==='number'&&Number.isFinite(v)){out.add(String(Math.trunc(v)));return;}
  if(typeof v==='string'&&/^-?\d{1,20}$/.test(v)){out.add(v);return;}
  if(Array.isArray(v)){for(const x of v)collectRequestIntegers(x,out,depth+1);return;}
  if(typeof v==='object'){for(const k of Object.keys(v))collectRequestIntegers(v[k],out,depth+1);}
}
function findGoogleBindingInRequest(req){
  const ids=new Set();collectRequestIntegers(req&&req.args,ids);collectRequestIntegers(req&&req.id,ids);
  for(const id of ids){const b=__googleLandmarkBindings.get(String(id));if(b)return b;}
  return null;
}

let __contactInfoTypes = {ready:false, phone:null, url:null, email:null};
function resolveContactInfoTypes() {
  if (__contactInfoTypes.ready || !Java.available) return;
  try {
    Java.perform(() => {
      try {
        const E=Java.use('com.magiclane.sdk.places.EContactInfoFieldType');
        const values=E.values();
        for(let i=0;i<values.length;i++){
          const v=values[i]; let name=''; let id=null;
          try{name=String(v.toString()).toLowerCase();}catch(_){}
          try{id=Number(v.getValue());}catch(_){try{id=Number(v.value.value);}catch(__){}}
          if(!Number.isFinite(id))continue;
          if(name.includes('phone'))__contactInfoTypes.phone=id;
          else if(name.includes('url')||name.includes('web'))__contactInfoTypes.url=id;
          else if(name.includes('email'))__contactInfoTypes.email=id;
        }
        __contactInfoTypes.ready=true;
        log(`CONTACT_TYPES_READY phone=${__contactInfoTypes.phone} url=${__contactInfoTypes.url} email=${__contactInfoTypes.email}`);
      } catch(e) { log(`CONTACT_TYPES_ERROR ${String(e)}`); }
    });
  } catch(e) { log(`CONTACT_TYPES_ERROR ${String(e)}`); }
}
function populateNativeContactInfo(landmarkId, place) {
  if(!place || (!place.phone && !place.website)) return false;
  resolveContactInfoTypes();
  try {
    const cr=callGemRaw('{"class":"ContactInfo"}',true);
    const ci=extractResultId(cr); if(!ci)throw new Error(`ContactInfo create failed: ${cr}`);
    let added=0;
    const add=(type,value,name)=>{
      if(!Number.isFinite(type)||!value)return;
      const args=JSON.stringify({type:Math.trunc(type),value:String(value).slice(0,1000),name:String(name)});
      callGemObject(ci,'ContactInfo','addField',args,-1); added++;
    };
    add(__contactInfoTypes.phone,place.phone,'Phone');
    add(__contactInfoTypes.url,place.website,'Website');
    if(added>0){
      callGemObject(landmarkId,'Landmark','setContactInfo',String(ci),-1);
      log(`LANDMARK_CONTACT_POPULATED id=${landmarkId} fields=${added}`);
      return true;
    }
  } catch(e) { log(`LANDMARK_CONTACT_FAIL id=${landmarkId} ${String(e)}`); }
  return false;
}


function enrichExistingLandmark(landmarkId, place) {
  const id=Number(landmarkId); if(!Number.isFinite(id)||!place)return false;
  const call=(method,argsJson)=>callGemObject(id,'Landmark',method,argsJson,-1);
  try{ if(place.name)call('setName',JSON.stringify(String(place.name))); }catch(_){}
  try{ if(Array.isArray(place.addressFields))call('setAddress',JSON.stringify({fields:place.addressFields})); }catch(_){}
  try{ if(Number.isFinite(Number(place.latitude))&&Number.isFinite(Number(place.longitude)))call('setCoordinates',JSON.stringify({latitude:Number(place.latitude),longitude:Number(place.longitude)})); }catch(e){log(`LANDMARK_RICH_SET_FAIL field=coordinates ${String(e)}`);}
  try{ if(place.description)call('setDescription',JSON.stringify(String(place.description).slice(0,3000))); }catch(e){log(`LANDMARK_RICH_SET_FAIL field=description ${String(e)}`);}
  try{ call('setAuthor',JSON.stringify('Google Maps')); }catch(_){}
  if(Array.isArray(place.extraInfoLines))for(const line of place.extraInfoLines.slice(0,40)){const text=String(line||'').trim();if(!text)continue;try{call('addExtraInfo',JSON.stringify(text.slice(0,900)));}catch(_){break;}}
  populateNativeContactInfo(id,place);
  return true;
}
function requestSelectedPlaceDetails(binding){
  if(!binding||binding.detailsRequested)return;
  binding.detailsRequested=true;
  const gen=searchGeneration;
  __activeGoogleDestination=binding;
  setTimeout(async()=>{
    const outcome=await googlePlaceDetails(binding.placeId,binding.query,gen,"",0,null,String(binding.place&&binding.place.rawPrimaryType||""));
    if(!outcome||!outcome.ok||!outcome.place){binding.detailsRequested=false;return;}
    binding.place=outcome.place; binding.richLoaded=true; binding.enrichedAt=Date.now();
    enrichExistingLandmark(binding.landmarkId,outcome.place);
    if(outcome.place.navigationPoint)log(`NAV_POINT_SELECTED landmark=${binding.landmarkId} usage=${(outcome.place.navigationPoint.usages||[]).join('/')||'generic'} lat=${outcome.place.latitude.toFixed(7)} lon=${outcome.place.longitude.toFixed(7)}`);
    log(`LANDMARK_DETAILS_ENRICHED landmark=${binding.landmarkId} placeId=${binding.placeId.slice(0,80)} extras=${Array.isArray(outcome.place.extraInfoLines)?outcome.place.extraInfoLines.length:0}`);
  },0);
}

function createLandmark(place, query='') {
  const createResp=callGemRaw('{"class":"Landmark"}',true);
  const id=extractResultId(createResp);
  if(!id)throw new Error(`Landmark create failed: ${createResp}`);
  const call=(method,argsJson)=>callGemObject(id,'Landmark',method,argsJson,-1);
  call('setName',JSON.stringify(String(place.name||'Google place')));
  if(Array.isArray(place.addressFields)) call('setAddress',JSON.stringify({fields:place.addressFields}));
  call('setCoordinates',JSON.stringify({latitude:Number(place.latitude),longitude:Number(place.longitude)}));
  call('setImageFromIconId','108006');
  // Populate Magic Earth's own Landmark metadata instead of adding a second
  // full-screen POI UI. Search rows stay intentionally lean; rich metadata is
  // fetched only after selection through one asynchronous Place Details request.
  if(place.description) { try { call('setDescription',JSON.stringify(String(place.description).slice(0,3000))); } catch(e) { log(`LANDMARK_RICH_SET_FAIL field=description ${String(e)}`); } }
  try { call('setAuthor',JSON.stringify('Google Maps')); } catch(_) {}
  if(Array.isArray(place.extraInfoLines)) {
    for(const line of place.extraInfoLines.slice(0,32)) {
      const text=String(line||'').trim(); if(!text)continue;
      try { call('addExtraInfo',JSON.stringify(text.slice(0,900))); }
      catch(e) { log(`LANDMARK_RICH_SET_FAIL field=extraInfo ${String(e)}`); break; }
    }
  }
  populateNativeContactInfo(Number(id),place);
  bindGoogleLandmark(id,place,query);
  if(place.description || (place.extraInfoLines&&place.extraInfoLines.length)) log(`LANDMARK_BASIC_POPULATED id=${id} placeId=${String(place.placeId||'').slice(0,80)} extras=${Array.isArray(place.extraInfoLines)?place.extraInfoLines.length:0}`);
  return id;
}
function pushLandmark(listId,landmarkId) {
  callGemRaw('{"id":'+listId+',"class":"LandmarkList","method":"push_back","args":'+landmarkId+',"dependencyId":-1}',false);
}

let __setDartPortAddr=null;
function executablePointer(p){
  try{const r=Process.findRangeByAddress(p);return !!(r&&String(r.protection||'').includes('x'));}catch(_){return false;}
}
function discoverPostCObjectFromSetDartPort(addr){
  // Version-adaptive discovery: set_dart_port loads a pointer-to-pointer from
  // a module global immediately before BLR. Decode that tiny exported function
  // instead of hard-coding a libGEM global offset.
  try{
    let pc=addr, pages=new Map(), slots=new Map(), deref=new Map();
    for(let i=0;i<48;i++){
      const ins=Instruction.parse(pc), op=String(ins.opStr||'').toLowerCase();
      let m;
      if(ins.mnemonic==='adrp' && (m=op.match(/^([xw][0-9]+),\s*#?(0x[0-9a-f]+)$/))){
        pages.set(m[1].replace(/^w/,'x'),ptr(m[2]));
      } else if(ins.mnemonic==='ldr' && (m=op.match(/^([xw][0-9]+),\s*\[([xw][0-9]+),\s*#?(0x[0-9a-f]+)\]$/))){
        const dst=m[1].replace(/^w/,'x'), base=m[2].replace(/^w/,'x');
        if(dst===base && pages.has(base)) slots.set(dst,pages.get(base).add(parseInt(m[3],16)));
      } else if(ins.mnemonic==='ldr' && (m=op.match(/^([xw][0-9]+),\s*\[([xw][0-9]+)\]$/))){
        const dst=m[1].replace(/^w/,'x'), base=m[2].replace(/^w/,'x');
        if(dst===base && slots.has(base)) deref.set(dst,slots.get(base));
      } else if(ins.mnemonic==='blr' && (m=op.match(/^([xw][0-9]+)$/))){
        const reg=m[1].replace(/^w/,'x'), slotAddr=deref.get(reg);
        if(slotAddr){
          const holder=slotAddr.readPointer();
          if(!holder.isNull()){
            const fp=holder.readPointer();
            if(!fp.isNull() && executablePointer(fp)){
              log(`DART_POST_DISCOVERED setPortOff=${addr.sub(gem.base)} slotOff=${slotAddr.sub(gem.base)}`);
              return new NativeFunction(fp,'bool',['int64','pointer']);
            }
          }
        }
      }
      pc=pc.add(ins.size);
    }
  }catch(e){log(`DART_POST_DISCOVERY_ERROR ${String(e)}`);}
  return null;
}
function resolveDartPortAndPoster() {
  if(!gem)return false;
  try {
    if(!postCObject && __setDartPortAddr) postCObject=discoverPostCObjectFromSetDartPort(__setDartPortAddr);
    // Exact-target fallback only. Future builds never consume these offsets.
    const exactSetPort=__setDartPortAddr && __setDartPortAddr.sub(gem.base).toString()==='0x296b130';
    if(!dartPort && exactSetPort) {
      const p=gem.base.add(0x2d1b5f0).readS64();
      if(p.toString()!=='0')dartPort=p;
    }
    if(!postCObject && exactSetPort) {
      const holder=gem.base.add(0x2b6d5e8).readPointer();
      if(!holder.isNull()) {
        const fp=holder.readPointer();
        if(!fp.isNull()&&executablePointer(fp))postCObject=new NativeFunction(fp,'bool',['int64','pointer']);
      }
    }
  } catch(e) { log(`DART_PORT_ERROR ${String(e)}`); }
  return !!dartPort&&!!postCObject;
}
function postCompleteEvent(listenerIdText) {
  if(!resolveDartPortAndPoster())throw new Error('Dart ReceivePort/PostCObject not ready');
  const event=JSON.stringify({eventName:String(listenerIdText),arguments:{eventType:'completeEvent',errCode:0,hint:''}});
  const str=Memory.allocUtf8String(event);
  const obj=Memory.alloc(16); obj.writeS32(5); obj.add(4).writeU32(0); obj.add(8).writePointer(str);
  return postCObject(int64(dartPort.toString()),obj);
}

let searchGeneration=0;
const pendingCategoryByThread=new Map();

function finishEmpty(listenerId) { try{postCompleteEvent(listenerId);}catch(e){log(`COMPLETE_ERROR ${String(e)}`);} }

let __autocompletePanelClass=null;
function ensureAutocompletePanel(){
  if(__autocompletePanelClass)return __autocompletePanelClass;if(!Java.available)return null;
  try{Java.perform(()=>{__autocompletePanelClass=Java.use('com.cairodrive.search.AutocompletePanel');});}catch(e){log(`AUTOCOMPLETE_PANEL_ERROR ${String(e)}`);}
  return __autocompletePanelClass;
}
function autocompletePanelPayload(predictions){return (predictions||[]).slice(0,5).map((p,i)=>{const dist=formatDistanceMeters(p.distanceMeters);const secondary=[String(p.secondaryText||'').replace(/[\t\r\n]+/g,' '),dist].filter(Boolean).join(' · ');return `${i}\t${String(p.mainText||p.text||'').replace(/[\t\r\n]+/g,' ')}\t${secondary}`;}).join('\n');}
function showAutocompletePanel(predictions){const P=ensureAutocompletePanel();if(!P)return false;try{Java.perform(()=>P.show(autocompletePanelPayload(predictions)));return true;}catch(e){log(`AUTOCOMPLETE_PANEL_SHOW_ERROR ${String(e)}`);return false;}}
function hideAutocompletePanel(){if(!__autocompletePanelClass)return;try{Java.perform(()=>__autocompletePanelClass.hide());}catch(_){} }
function consumeAutocompleteSelection(){if(!__autocompletePanelClass)return -1;let v=-1;try{Java.perform(()=>{v=Number(__autocompletePanelClass.consumeSelection());});}catch(_){}return v;}
function replayStockSearch(originalRaw,reason){try{const rp=nativeCallOriginal(Memory.allocUtf8String(originalRaw),utf8Length(originalRaw));try{if(rp&&!rp.isNull())libcFree(rp);}catch(_){}showNativeFallbackToast(reason);return true;}catch(e){log(`NATIVE_SEARCH_FALLBACK_ERROR ${String(e)}`);return false;}}
function injectPlacesAndComplete(query,places,listId,listenerId,generation,kind){let injected=0;for(const p of Array.isArray(places)?places:[]){if(generation!==searchGeneration)break;try{const id=createLandmark(p,query);pushLandmark(listId,id);injected++;}catch(e){log(`NATIVE_INJECT_ERROR ${String(e)}`);}}finishEmpty(listenerId);log(`NATIVE_INJECT kind=${kind} rows=${injected} gen=${generation}`);return injected;}

function deliverAutocomplete(query,listId,listenerId,generation,bias,originalRaw){
  setTimeout(async()=>{
    const sessionToken=newAutocompleteSessionToken();
    if(generation!==searchGeneration){finishEmpty(listenerId);return;}
    const a=await googleAutocomplete(query,bias,generation,sessionToken);
    if(generation!==searchGeneration){hideAutocompletePanel();finishEmpty(listenerId);return;}
    if(!a||!a.ok){if(a&&a.suppressFallback){finishEmpty(listenerId);return;}if(!replayStockSearch(originalRaw,a&&a.reason||'autocomplete-failure'))finishEmpty(listenerId);return;}
    const predictions=Array.isArray(a.predictions)?a.predictions:[];
    if(!predictions.length){
      log('AUTOCOMPLETE_EMPTY action=lean-text-search');
      const all=await googleTextSearch(query,bias,generation,50000,false);
      if(generation!==searchGeneration){finishEmpty(listenerId);return;}
      if(all&&all.ok)injectPlacesAndComplete(query,all.places,listId,listenerId,generation,'typed-search-all');
      else if(!replayStockSearch(originalRaw,all&&all.reason||'autocomplete-empty'))finishEmpty(listenerId);
      return;
    }
    if(!showAutocompletePanel(predictions)){
      const all=await googleTextSearch(query,bias,generation,50000,false);
      if(all&&all.ok)injectPlacesAndComplete(query,all.places,listId,listenerId,generation,'typed-panel-fallback');
      else if(!replayStockSearch(originalRaw,all&&all.reason||'panel-unavailable'))finishEmpty(listenerId);
      return;
    }
    log(`AUTOCOMPLETE_PANEL_SHOW count=${predictions.length}`);const opened=Date.now();
    const poll=()=>{
      if(generation!==searchGeneration){hideAutocompletePanel();finishEmpty(listenerId);return;}
      if(Date.now()-opened>20000){hideAutocompletePanel();log('AUTOCOMPLETE_PANEL_TIMEOUT');finishEmpty(listenerId);return;}
      const choice=consumeAutocompleteSelection();if(choice===-1){setTimeout(poll,120);return;}
      hideAutocompletePanel();
      if(choice===100){setTimeout(async()=>{const all=await googleTextSearch(query,bias,generation,50000,false);if(generation!==searchGeneration){finishEmpty(listenerId);return;}if(all&&all.ok)injectPlacesAndComplete(query,all.places,listId,listenerId,generation,'typed-search-all');else if(!replayStockSearch(originalRaw,all&&all.reason||'search-all-failure'))finishEmpty(listenerId);},0);return;}
      const pred=predictions[choice];if(!pred){finishEmpty(listenerId);return;}
      log(`AUTOCOMPLETE_SELECT index=${choice} placeId=${pred.placeId.slice(0,80)} session=yes`);
      setTimeout(async()=>{const d=await googlePlaceDetails(pred.placeId,query,generation,sessionToken,0,null,String(pred.types&&pred.types[0]||""));if(generation!==searchGeneration){finishEmpty(listenerId);return;}if(d&&d.ok&&d.place){injectPlacesAndComplete(query,[d.place],listId,listenerId,generation,'autocomplete-select');}else if(!replayStockSearch(originalRaw,d&&d.reason||'details-after-autocomplete-failure'))finishEmpty(listenerId);},0);
    };poll();
  },0);
}

function activeRouteSearchContext() {
  if(!Java.available||!__navServiceKeepAlive)return null;
  let ctx=null;
  try{
    Java.perform(()=>{
      const active=routeServiceActive(__navServiceKeepAlive);
      if(!active)return;
      let route=null;try{route=__navServiceKeepAlive.getNavigationRoute(null);}catch(_){try{route=__navServiceKeepAlive.getNavigationRoute();}catch(__){}}
      const snap=collectTrafficRouteSnapshot(route);if(!snap||snap.remain<1000)return;
      const pts=[snap.origin,...snap.samples.map(x=>({latitude:x.latitude,longitude:x.longitude})),snap.destination];
      const encoded=encodeGooglePolyline(pts);
      if(encoded.length>=8)ctx={searchAlongRouteEncoded:encoded,routingOrigin:snap.origin,remainingM:snap.remain,points:pts.length};
    });
  }catch(e){log(`SEARCH_ALONG_ROUTE_CONTEXT_ERROR ${String(e)}`);}
  return ctx;
}

function deliverSearch(query,listId,listenerId,generation,bias,kind,originalRaw,categoryId=null,categoryTypes=null) {
  setTimeout(async()=>{
    if(generation!==searchGeneration){finishEmpty(listenerId);return;}
    const along=kind==='category'?activeRouteSearchContext():null;
    if(along)log(`SEARCH_ALONG_ROUTE_GOOGLE kind=${kind} remainingM=${Math.round(along.remainingM)} points=${along.points}`);
    let outcome;
    const mappedTypes=Array.isArray(categoryTypes)&&categoryTypes.length?categoryTypes:googleTypesForMagicCategory(categoryId,query);
    if(kind==='category'&&!mappedTypes.length){
      log(`CATEGORY_NATIVE_FALLBACK categoryId=${categoryId} reason=no-safe-google-type-map`);
      if(!replayStockSearch(originalRaw,'category-native-semantic-fallback'))finishEmpty(listenerId);
      return;
    }
    if(kind==='category'&&!along){
      outcome=await googleNearbySearch(categoryId,query,bias,generation,25000,mappedTypes);
    }else{
      outcome=await googleTextSearch(query,bias,generation,kind==='category'?25000:50000,kind==='category',along||{});
    }
    if(generation!==searchGeneration){finishEmpty(listenerId);return;}
    if(!outcome || !outcome.ok){
      if(outcome && outcome.suppressFallback){finishEmpty(listenerId);return;}
      try{
        const rp=nativeCallOriginal(Memory.allocUtf8String(originalRaw),utf8Length(originalRaw));
        try{if(rp&&!rp.isNull())libcFree(rp);}catch(_){}
        showNativeFallbackToast(outcome&&outcome.reason?outcome.reason:'google-failure');
        return; // stock SearchService owns completion from here
      }catch(e){
        log(`NATIVE_SEARCH_FALLBACK_ERROR ${String(e)}`);
        finishEmpty(listenerId); return;
      }
    }
    const places=Array.isArray(outcome.places)?outcome.places:[];
    let injected=0;
    for(const p of places) {
      if(generation!==searchGeneration){finishEmpty(listenerId);return;}
      try { const id=createLandmark(p,query); pushLandmark(listId,id); injected++; }
      catch(e){log(`NATIVE_INJECT_ERROR ${String(e)}`);}
    }
    try { postCompleteEvent(listenerId); }
    catch(e){log(`COMPLETE_ERROR ${String(e)}`);}
    log(`NATIVE_INJECT kind=${kind} rows=${injected} gen=${generation}`);
  },0);
}

function handleGemDispatch(raw) {
  let req; try{req=JSON.parse(raw);}catch(_){return null;}
  if(!req||!req.class||!req.method)return null;

  if(req.class==='SearchService'&&req.method==='searchLandmarkDetails') {
    const binding=findGoogleBindingInRequest(req);
    if(binding){
      log(`PLACE_DETAILS_SELECT landmark=${binding.landmarkId} placeId=${binding.placeId.slice(0,80)}`);
      requestSelectedPlaceDetails(binding);
    }
    return null; // stock Magic Earth details UI remains authoritative/fail-open
  }

  if(req.class==='LandmarkStoreCollection'&&req.method==='addStoreCategoryId'&&req.args) {
    const categoryId=Number(req.args.categoryId), storeId=Number(req.args.storeId);
    if(Number.isFinite(categoryId)) {
      const tid=Process.getCurrentThreadId(), now=Date.now();
      const prev=pendingCategoryByThread.get(tid);
      const categories=prev&&now-prev.at<=CATEGORY_CONTEXT_TTL_MS&&Array.isArray(prev.categories)?prev.categories.slice():[];
      categories.push({categoryId,storeId});
      pendingCategoryByThread.set(tid,{categories,at:now});
    }
    return null;
  }

  if(req.class==='SearchService'&&req.method==='search'&&req.args) {
    const query=normalizeQuery(typeof req.args.textFilter==='string'?req.args.textFilter:'');
    const availability=googleAvailableBeforeIntercept();
    if(!availability.ok || !shouldCallGoogle(query)) { if(!availability.ok)showNativeFallbackToast(availability.reason); return null; }
    const listId=extractIntegerText(raw,'results'), listenerId=extractIntegerText(raw,'listener');
    if(!listId||!listenerId){log('SEARCH_FORWARD reason=ids-not-parsed');return null;}
    searchGeneration++; const gen=searchGeneration;
    log(`SEARCH_INTERCEPT kind=typed qlen=${Array.from(query).length} gen=${gen}`);
    const bias=biasFromSearchArgs(req.args)||getLocationBias();
    deliverAutocomplete(query,listId,listenerId,gen,bias,raw);
    return {handled:true};
  }

  if(req.class==='SearchService'&&req.method==='searchAroundPosition'&&req.args) {
    const tid=Process.getCurrentThreadId();
    const ctx=pendingCategoryByThread.get(tid);
    if(!ctx||Date.now()-ctx.at>CATEGORY_CONTEXT_TTL_MS){if(ctx)pendingCategoryByThread.delete(tid);return null;}
    pendingCategoryByThread.delete(tid);
    if(!Array.isArray(ctx.categories)||!ctx.categories.length)return null;
    const availability=googleAvailableBeforeIntercept();
    if(!availability.ok){showNativeFallbackToast(availability.reason);return null;}
    const listId=extractIntegerText(raw,'results'), listenerId=extractIntegerText(raw,'listener');
    const pos=req.args.position||{};
    const bias=safeBias({latitude:Number(pos.latitude),longitude:Number(pos.longitude)});
    if(!listId||!listenerId){log('CATEGORY_FORWARD reason=ids-not-parsed');return null;}
    const resolved=ctx.categories.map(cat=>{const name=resolveMagicLaneCategoryName(cat.categoryId);return {...cat,name,types:googleTypesForMagicCategory(cat.categoryId,name)};});
    if(resolved.length>1 && resolved.some(x=>!x.types.length)){
      log(`CATEGORY_FORWARD reason=multi-category-unmapped count=${resolved.length}`);
      return null;
    }
    const categoryTypes=[...new Set(resolved.flatMap(x=>x.types))].slice(0,50);
    const name=resolved.map(x=>x.name).filter(Boolean).join(' / ') || magicGenericCategoryName(resolved[0].categoryId);
    if(!name){log(`CATEGORY_EMPTY reason=name-unresolved categoryId=${resolved[0].categoryId}`);finishEmpty(listenerId);return {handled:true};}
    const categoryId=resolved.length===1?resolved[0].categoryId:resolved.map(x=>x.categoryId).join(',');
    searchGeneration++; const gen=searchGeneration;
    log(`SEARCH_INTERCEPT kind=category categoryId=${categoryId} count=${resolved.length} mappedTypes=${categoryTypes.length} qlen=${Array.from(name).length} gen=${gen}`);
    deliverSearch(name,listId,listenerId,gen,bias,'category',raw,categoryId,categoryTypes);
    return {handled:true};
  }
  return null;
}



// --------------------- Magic Lane cooperative navigation ---------------------
// Magic Lane remains the displayed route/navigation authority. Google Routes is
// advisory only: traffic geometry is never drawn and Google routes are never
// started. A high-confidence jam mapped onto the active Magic Lane route may be
// converted into a temporary Magic Lane navigation roadblock so Magic Lane itself
// computes the replacement route.
const __navEnums = { trafficAll:null, fastest:null, car:null, trafficOnline:null, alternativesNever:null, magicEarth:null, externalCh:null, experimentalPathAlgorithmValue:null, experimentalPathAlgorithmName:'', departureHeadingDeg:null, departureHeadingAccuracyDeg:null, enableTerrainProfile:true, fastReroute:false, preferOnlineCalculation:false };
const ROUTE_ALGO_EXPERIMENT_MODE = readStagedSecret('/data/local/tmp/cairodrive_route_algo').trim().toLowerCase();
const SIMULATION_TEST_MODE = readStagedSecret('/data/local/tmp/cairodrive_simulation').trim().toLowerCase();
const SIMULATION_TEST_ENABLED = ['1','true','on','yes','rewrite','ab','benchmark'].includes(SIMULATION_TEST_MODE);
const SIMULATION_SPEED_REQUEST = Number(readStagedSecret('/data/local/tmp/cairodrive_simulation_speed') || '4');
const BENCHMARK_ROADBLOCK_PATH = '/data/local/tmp/cairodrive_benchmark_roadblock';
let __benchmarkLastControlToken='';
let __benchmarkPending=null;
let __lastBenchmarkControlPollAt=0;
let __navEnumsReady = false;

function routeServiceActive(service, listener=null) {
  if(!service)return false;
  try{if(listener&&typeof service.isNavigationActive==='function'&&service.isNavigationActive(listener))return true;}catch(_){}
  try{if(typeof service.isNavigationActive==='function'&&service.isNavigationActive(null))return true;}catch(_){}
  try{if(typeof service.isNavigationActive==='function'&&service.isNavigationActive())return true;}catch(_){}
  try{if(listener&&typeof service.isSimulationActive==='function'&&service.isSimulationActive(listener))return true;}catch(_){}
  try{if(typeof service.isSimulationActive==='function'&&service.isSimulationActive(null))return true;}catch(_){}
  try{if(typeof service.isSimulationActive==='function'&&service.isSimulationActive())return true;}catch(_){}
  return false;
}
function routeServiceSimulationActive(service, listener=null) {
  if(!service)return false;
  try{if(listener&&typeof service.isSimulationActive==='function')return !!service.isSimulationActive(listener);}catch(_){}
  try{if(typeof service.isSimulationActive==='function')return !!service.isSimulationActive(null);}catch(_){}
  try{if(typeof service.isSimulationActive==='function')return !!service.isSimulationActive();}catch(_){}
  return false;
}
let __trafficObjectKeepAlive = null;
let __navServiceKeepAlive = null;
let __navBannerClass = null;
let __activityHookKeepAlive = null;
let __navPollTimer = null;
let __navTickFn = null;
let __navTickRunning = false;
let __lastNavBannerKey = '';
let __laneColors = null;
let __lastRouteShapeLogAt = 0;
let __driveTraceTimer = null;
let __lastTraceSystemAt = 0;
let __reportProgressListener = null;
let __repeatSoundListener = null;
let __lastControlPollAt = 0;
let __trafficAdviceInFlight=false;
let __lastTrafficAdviceAt=0;
let __trafficRefreshAfterMs=180000;
let __lastTrafficRoadblockAt=0;
let __trafficDestinationSig='';
let __trafficAdviceSeq=0;
let __trafficSeverityLevel=1;
let __trafficSeverityUntil=0;
let __narrowHazardUntil=0;
let __lastBetterRouteSuggestionAt=0;
const __trafficAvoidedSections=new Map();
let __routeAssistReason='';
let __routeAssistReasonUntil=0;
let __lastMotionHint=null;
let __lastSpeedAssistLogKey='';
let __lastOverSpeedToastAt=0;
let __lastDriveTraceAt=0;
let __lastDriveTraceKey='';
let __lastNativeTrafficEventKey='';
let __lastRouteWarningKey='';
let __lastNavigationStatusKey='';
let __restrictionEnumCache=null;
let __lastRestrictionAssistKey='';
let __nativeSpeedAlarmConfigured=false;
let __alarmHooksInstalled=false;
let __alarmHookKeepAlive=[];
let __betterRouteHooksInstalled=false;
let __capturedNavigation=null;
let __betterRouteSwitchAt=0;
let __lastBetterRouteEventKey='';
let __lastBetterRouteEventAt=0;
let __betterRouteGeneration=0;
let __routeCalculationStartedAt=0;
let __routeCalculationCount=0;
let __routeRecomputeInFlight=false;
let __routeRecomputeTriggerAt=0;
let __routeRecomputeTriggerReason='';
let __activeTrafficHttpToken=null;
const __hookedNavigationListenerClasses=new Set();

function toastMessage(msg) {
  if (!Java.available || !msg) return;
  try { Java.perform(() => {
    const ActivityThread=Java.use('android.app.ActivityThread'); const app=ActivityThread.currentApplication(); if(!app)return;
    const Toast=Java.use('android.widget.Toast'); Toast.makeText(app.getApplicationContext(),String(msg),Toast.LENGTH_SHORT.value).show();
  }); } catch (_) {}
}

function consumeDriveControlActions() {
  if (!Java.available || !__navBannerClass) return;
  const now=Date.now(); if(now-__lastControlPollAt<250)return; __lastControlPollAt=now;
  try {
    const action=Number(__navBannerClass.consumeAction());
    if(action===1) repeatCurrentVoiceInstruction();
    else if(action===2) {
      const uid=Number(__navBannerClass.consumeReportUid());
      if(uid===0) showDynamicReportChoices();
      else if(uid>0) submitNativeSocialReport(uid);
      else if(uid===-1001) queueLocalOsmTrafficCalming('bump');
      else if(uid===-1002) queueLocalOsmTrafficCalming('hump');
      else if(uid===-1003) queueLocalOsmTrafficCalming('table');
    }
    else if(action===3) { let ok=false; try{ok=!!__navBannerClass.pauseMedia();}catch(_){} log(`MEDIA_PAUSE dispatched=${ok?'yes':'no'}`); if(!ok)toastMessage('No active media session accepted Pause'); }
  } catch(e) { log(`DRIVE_CONTROL_ERROR ${String(e)}`); }
}

function repeatCurrentVoiceInstruction() {
  try {
    if (!__navServiceKeepAlive) { log('VOICE_REPEAT_SKIPPED reason=no-navigation-service'); toastMessage('No navigation instruction to repeat'); return; }
    let ni=null; try{ni=__navServiceKeepAlive.getNavigationInstruction(null);}catch(_){try{ni=__navServiceKeepAlive.getNavigationInstruction();}catch(__){}}
    if(!ni){log('VOICE_REPEAT_SKIPPED reason=no-instruction');toastMessage('No navigation instruction to repeat');return;}
    let text=''; try{text=String(ni.getNextTurnInstruction()||'').trim();}catch(_){}
    if(!text){log('VOICE_REPEAT_SKIPPED reason=no-text');toastMessage('No voice instruction available');return;}
    const SPS=Java.use('com.magiclane.sdk.core.SoundPlayingService');
    const Listener=Java.use('com.magiclane.sdk.core.SoundPlayingListener');
    if(!__repeatSoundListener)__repeatSoundListener=Java.retain(Listener.$new());
    const prefs=SPS.getPlayingPreferences();
    const rc=SPS.playText(text,__repeatSoundListener,prefs);
    log(`VOICE_REPEAT_PLAY result=${Number(rc)} text=${JSON.stringify(text).slice(0,180)}`);
  } catch(e) { log(`VOICE_REPEAT_ERROR ${String(e)}`); toastMessage('Repeat unavailable — stock guidance continues'); }
}

let __socialChoicesCache={at:0,spec:'',allowed:new Set()};
function javaListItems(list){
  const out=[];if(!list)return out;
  try{const n=Number(list.size());for(let i=0;i<n;i++)out.push(list.get(i));return out;}catch(_){}
  try{for(let i=0;i<Number(list.length);i++)out.push(list[i]);}catch(_){}
  return out;
}
function getDynamicSocialReportChoices(){
  const now=Date.now();if(now-__socialChoicesCache.at<60000&&__socialChoicesCache.spec)return __socialChoicesCache;
  const rows=[[-1001,'Speed bump — save for OSM'],[-1002,'Speed hump — save for OSM'],[-1003,'Raised table/crossing — save for OSM']];
  const allowed=new Set();
  try{
    const MD=Java.use('com.magiclane.sdk.core.MapDetails');const md=MD.$new();let iso='';
    try{iso=String(md.getIsoCodeForCurrentPosition()||'');}catch(_){try{iso=String(md.isoCodeForCurrentPosition.value||'');}catch(__){}}
    const SO=Java.use('com.magiclane.sdk.core.SocialOverlay');let info=null;
    try{info=SO.getReportsOverlayInfo();}catch(_){try{info=SO.reportsOverlayInfo.value;}catch(__){}}
    let cats=null;if(info){try{cats=info.getCategories(iso);}catch(_){try{cats=info.getSocialReportsCategories();}catch(__){}}}
    const walk=(cat,prefix,depth)=>{if(!cat||depth>4||rows.length>45)return;let uid=NaN,name='';
      try{uid=Number(cat.getUid());}catch(_){try{uid=Number(cat.uid.value);}catch(__){}}
      try{name=String(cat.getName()||'').trim();}catch(_){try{name=String(cat.name.value||'').trim();}catch(__){}}
      let children=null;try{children=cat.getSubcategories();}catch(_){try{children=cat.subcategories.value;}catch(__){}}
      const arr=javaListItems(children);if(arr.length){for(const ch of arr)walk(ch,name||prefix,depth+1);return;}
      if(Number.isFinite(uid)&&uid>0&&name){allowed.add(uid);rows.push([uid,prefix&&prefix!==name?`${prefix} — ${name}`:name]);}
    };
    for(const c of javaListItems(cats))walk(c,'',0);
    log(`SOCIAL_REPORT_CATEGORIES country=${iso||'unknown'} leafCount=${allowed.size} source=MagicLane`);
  }catch(e){log(`SOCIAL_REPORT_CATEGORIES_FAIL ${String(e)}`);}
  const spec=rows.map(([id,label])=>`${id}|${String(label).replace(/[\n|]/g,' ')}`).join('\n');
  __socialChoicesCache={at:now,spec,allowed};return __socialChoicesCache;
}
function showDynamicReportChoices(){
  try{const c=getDynamicSocialReportChoices();__navBannerClass.showReportChoices(c.spec);}
  catch(e){log(`SOCIAL_REPORT_MENU_ERROR ${String(e)}`);toastMessage('Report menu unavailable');}
}
function submitNativeSocialReport(categoryUid) {
  const uid=Number(categoryUid);
  const choices=getDynamicSocialReportChoices();
  if(choices.allowed.size&&!choices.allowed.has(uid)){log(`SOCIAL_REPORT_REJECT uid=${uid} reason=not-available-in-current-country`);toastMessage('That report type is not available here');return;}
  try {
    const SO=Java.use('com.magiclane.sdk.core.SocialOverlay');
    const PL=Java.use('com.magiclane.sdk.core.ProgressListener');
    if(!__reportProgressListener)__reportProgressListener=Java.retain(PL.$new());
    // Exact target APK exposes prepareReporting(int, DataSource).  Kotlin's default
    // parameters are represented in DEX, so category=0 + null data source requests
    // the current high-accuracy navigation/device position.
    let prep=0;
    try { prep=Number(SO.prepareReporting(0,null)); }
    catch(_) { try { prep=Number(SO.prepareReporting$default(SO,0,null,3,null)); } catch(__) {} }
    if(!(prep>0)){log(`SOCIAL_REPORT_PREP_FAIL uid=${uid} code=${prep}`);toastMessage('Report not sent — GPS accuracy is not good enough');return;}
    let rc=-999;
    try { rc=Number(SO.report(prep,uid,__reportProgressListener,'',null,null)); }
    catch(_) { try { rc=Number(SO.report$default(SO,prep,uid,__reportProgressListener,'',null,null,56,null)); } catch(__){} }
    log(`SOCIAL_REPORT_SENT uid=${uid} prepare=${prep} result=${rc}`);
    if(rc>=0)toastMessage('Road report submitted'); else toastMessage('Road report could not be submitted');
  } catch(e) { log(`SOCIAL_REPORT_ERROR uid=${uid} ${String(e)}`); toastMessage('Report unavailable — stock app is unchanged'); }
}

function driveTraceEnabled(){ return true; } // v22.3 first-test diagnostics; intended to be reduced after runtime validation.

function bestLocalLocation(ctx) {
  try {
    const LM=Java.use('android.location.LocationManager'); const lm=Java.cast(ctx.getSystemService('location'),LM);
    let best=null;
    for(const provider of ['gps','fused','network','passive']) {
      try {
        const l=lm.getLastKnownLocation(provider); if(!l)continue;
        const t=Number(l.getTime()), acc=Number(l.getAccuracy());
        if(!best || t>best.t || (t===best.t && acc<best.acc)) best={p:provider,t,lat:Number(l.getLatitude()),lon:Number(l.getLongitude()),acc,speed:l.hasSpeed()?Number(l.getSpeed()):-1,bearing:l.hasBearing()?Number(l.getBearing()):-1,bearingAcc:(()=>{try{return l.hasBearingAccuracy()?Number(l.getBearingAccuracyDegrees()):25;}catch(_){return 25;}})(),alt:l.hasAltitude()?Number(l.getAltitude()):null};
      } catch(_) {}
    }
    return best;
  } catch(_) { return null; }
}

function queueLocalOsmTrafficCalming(kind) {
  if(!Java.available)return;
  const k=String(kind||'').toLowerCase();
  if(!['bump','hump','table'].includes(k)){log(`OSM_TRAFFIC_CALMING_REJECT kind=${k}`);return;}
  try {
    const ActivityThread=Java.use('android.app.ActivityThread'); const app=ActivityThread.currentApplication(); if(!app)return; const ctx=app.getApplicationContext();
    const loc=bestLocalLocation(ctx);
    if(!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || !Number.isFinite(loc.acc) || loc.acc>35) {
      log(`OSM_TRAFFIC_CALMING_NOT_QUEUED kind=${k} reason=gps-accuracy accM=${loc&&Number.isFinite(loc.acc)?loc.acc.toFixed(1):'none'}`);
      toastMessage('Speed-calming report not saved — wait for better GPS'); return;
    }
    const root=ctx.getExternalFilesDir(null); if(!root)throw new Error('external-files-dir unavailable');
    const FileCls=Java.use('java.io.File'); const dir=FileCls.$new(root,'cairodrive'); if(!dir.exists())dir.mkdirs();
    const out=FileCls.$new(dir,'osm_traffic_calming.geojsonl');
    const FOS=Java.use('java.io.FileOutputStream'); const OSW=Java.use('java.io.OutputStreamWriter'); const BW=Java.use('java.io.BufferedWriter');
    const fos=FOS.$new(out,true); const osw=OSW.$new(fos,'UTF-8'); const bw=BW.$new(osw);
    const rec={type:'Feature',geometry:{type:'Point',coordinates:[loc.lon,loc.lat]},properties:{source:'cairodrive-drive-report',osmTag:`traffic_calming=${k}`,traffic_calming:k,accuracy_m:Number(loc.acc.toFixed(1)),bearing_deg:loc.bearing>=0?Number(loc.bearing.toFixed(1)):null,speed_mps:loc.speed>=0?Number(loc.speed.toFixed(2)):null,provider:loc.p,timestamp:new Date().toISOString(),uploaded:false}};
    bw.write(JSON.stringify(rec)); bw.newLine(); bw.flush(); bw.close();
    log(`OSM_TRAFFIC_CALMING_QUEUED kind=${k} lat=${loc.lat.toFixed(7)} lon=${loc.lon.toFixed(7)} accM=${loc.acc.toFixed(1)} file=${String(out.getAbsolutePath())}`);
    toastMessage(`Saved ${k} for OSM review`);
  } catch(e) { log(`OSM_TRAFFIC_CALMING_ERROR kind=${k} ${String(e)}`); toastMessage('Speed-calming report could not be saved'); }
}

function traceLocationAndSystem(ni, active) {
  if(!Java.available)return;
  try {
    const ActivityThread=Java.use('android.app.ActivityThread'); const app=ActivityThread.currentApplication(); if(!app)return; const ctx=app.getApplicationContext();
    const LM=Java.use('android.location.LocationManager'); const lm=Java.cast(ctx.getSystemService('location'),LM);
    let best=null;
    for(const provider of ['gps','fused','network','passive']){try{const l=lm.getLastKnownLocation(provider);if(!l)continue;const t=Number(l.getTime());if(!best||t>best.t){best={p:provider,t,lat:Number(l.getLatitude()),lon:Number(l.getLongitude()),acc:Number(l.getAccuracy()),speed:l.hasSpeed()?Number(l.getSpeed()):-1,bearing:l.hasBearing()?Number(l.getBearing()):-1,bearingAcc:(()=>{try{return l.hasBearingAccuracy()?Number(l.getBearingAccuracyDegrees()):25;}catch(_){return 25;}})(),alt:l.hasAltitude()?Number(l.getAltitude()):null};}}catch(_){}}
    let ev='',street='',sign='',dist=-1,lane='';
    if(ni){try{street=String(ni.getNextStreetName()||'');}catch(_){}try{sign=String(ni.getSignpostInstruction()||'');}catch(_){}try{const td=ni.getTimeDistanceToNextTurn();if(td)dist=Number(td.getTotalDistance());}catch(_){}try{const td=ni.getNextTurnDetails();if(td&&td.getEvent())ev=String(td.getEvent().toString());}catch(_){}try{const li=inspectNativeLane(ni);lane=li.uid||'';}catch(_){}}
    if(best&&best.speed>=2.0&&best.bearing>=0&&best.acc<=30&&Date.now()-best.t<=10000){
      const ba=Number.isFinite(best.bearingAcc)?best.bearingAcc:25;
      __lastMotionHint={heading:best.bearing,accuracy:Math.max(5,Math.min(60,ba)),at:Date.now()};
      __navEnums.departureHeadingDeg=__lastMotionHint.heading;__navEnums.departureHeadingAccuracyDeg=__lastMotionHint.accuracy;
    }
    const loc=best?` provider=${best.p} lat=${best.lat.toFixed(7)} lon=${best.lon.toFixed(7)} accM=${best.acc.toFixed(1)} speedMps=${best.speed.toFixed(2)} bearing=${best.bearing.toFixed(1)} ageMs=${Math.max(0,Date.now()-best.t)}`:' location=none';
    const now=Date.now();
    const traceKey=`${active?'1':'0'}|${ev}|${lane}|${street}|${sign}|${Number.isFinite(dist)?Math.round(dist/100):'-'}|${best?`${best.p}:${Math.round(best.speed*2)/2}:${Math.round(best.bearing/15)}`:'none'}`;
    const traceInterval=active?3000:15000;
    if(traceKey!==__lastDriveTraceKey||now-__lastDriveTraceAt>=traceInterval){__lastDriveTraceKey=traceKey;__lastDriveTraceAt=now;log(`DRIVE_TRACE nav=${active?'yes':'no'}${loc} turn=${ev||'none'} distM=${Number.isFinite(dist)?Math.round(dist):-1} laneUid=${lane||'none'} street=${JSON.stringify(street).slice(0,120)} sign=${JSON.stringify(sign).slice(0,120)}`);}
    if(now-__lastTraceSystemAt>=30000){__lastTraceSystemAt=now;try{const IntentFilter=Java.use('android.content.IntentFilter');const f=IntentFilter.$new('android.intent.action.BATTERY_CHANGED');const i=ctx.registerReceiver(null,f);if(i){const level=Number(i.getIntExtra('level',-1)),scale=Number(i.getIntExtra('scale',100)),temp=Number(i.getIntExtra('temperature',-1));log(`DRIVE_SYSTEM batteryPct=${scale>0?Math.round(level*100/scale):-1} batteryTempC=${temp>=0?(temp/10).toFixed(1):-1}`);}}catch(_){} }
  } catch(e) { log(`DRIVE_TRACE_ERROR ${String(e)}`); }
}

function findJavaEnum(className, wanted) {
  let found = null;
  try {
    const E = Java.use(className);
    const vals = E.values();
    for (let i=0;i<vals.length;i++) {
      const obj = vals[i];
      const name = String(obj.toString());
      if (name.toLowerCase().includes(String(wanted).toLowerCase())) {
        let value = null;
        try { value = Number(obj.getValue()); } catch (_) {}
        found = {obj, name, value:Number.isFinite(value)?value:null};
        break;
      }
    }
  } catch (_) {}
  return found;
}

function configureMagicLaneTrafficAndEnums() {
  if (!Java.available) return false;
  try {
    Java.perform(() => {
      const all = findJavaEnum('com.magiclane.sdk.routesandnavigation.ETrafficAvoidance','all');
      const fastest = findJavaEnum('com.magiclane.sdk.routesandnavigation.ERouteType','fastest');
      const car = findJavaEnum('com.magiclane.sdk.routesandnavigation.ERouteTransportMode','car');
      const online = findJavaEnum('com.magiclane.sdk.routesandnavigation.ETrafficUsage','online');
      const alternativesNever = findJavaEnum('com.magiclane.sdk.routesandnavigation.ERouteAlternativesSchema','never');
      const magicEarth = findJavaEnum('com.magiclane.sdk.routesandnavigation.ERoutePathAlgorithm','magicearth');
      const externalCh = findJavaEnum('com.magiclane.sdk.routesandnavigation.ERoutePathAlgorithm','externalch');
      __navEnums.trafficAll = all ? all.value : null;
      __navEnums.fastest = fastest ? fastest.value : null;
      __navEnums.car = car ? car.value : null;
      __navEnums.trafficOnline = online ? online.value : null;
      __navEnums.alternativesNever = alternativesNever ? alternativesNever.value : null;
      __navEnums.magicEarth = magicEarth ? magicEarth.value : null;
      __navEnums.externalCh = externalCh ? externalCh.value : null;
      __navEnumsReady = Number.isFinite(__navEnums.trafficAll) && Number.isFinite(__navEnums.fastest) && Number.isFinite(__navEnums.car);
      log(`NAV_ENUMS trafficAll=${__navEnums.trafficAll} fastest=${__navEnums.fastest} car=${__navEnums.car} alternativesNever=${__navEnums.alternativesNever} online=${__navEnums.trafficOnline} ready=${__navEnumsReady?'yes':'no'}`);
      log(`ROUTE_ALGO_ENUMS magicEarth=${magicEarth?`${magicEarth.name}:${magicEarth.value}`:'missing'} externalCh=${externalCh?`${externalCh.name}:${externalCh.value}`:'missing'} experiment=${ROUTE_ALGO_EXPERIMENT_MODE||'stock'}`);

      if (online && online.obj) {
        try {
          const Traffic = Java.use('com.magiclane.sdk.routesandnavigation.Traffic');
          const t = Traffic.$new();
          const prefs = t.getPreferences();
          prefs.setUseTraffic(online.obj);
          __trafficObjectKeepAlive = Java.retain(t);
          log('MAGICLANE_TRAFFIC_ENABLED mode=online source=native-sdk');
        } catch (e) {
          log(`MAGICLANE_TRAFFIC_ENABLE_FAILED ${String(e)}`);
        }
      }
    });
  } catch (e) { log(`NAV_ENUM_INIT_ERROR ${String(e)}`); }
  return __navEnumsReady;
}

function patchRouteRaw(raw) {
  let req;
  try { req = JSON.parse(String(raw)); } catch (_) { return null; }
  const routeBinding=findGoogleBindingInRequest(req);
  if(routeBinding){__activeGoogleDestination=routeBinding;log(`NAV_DESTINATION_BIND landmark=${routeBinding.landmarkId} rich=${routeBinding.richLoaded?'yes':'no'}`);}
  // Initial route may build road-type terrain metadata for conservative narrow-road detection.
  // During active navigation, calculateRoute requests are stripped of terrain-profile work
  // to protect the <1 s reroute target. Internal SDK recalcs that bypass this hook are timed
  // below but cannot be preference-rewritten safely on the 1.9.0 binary.
  const activeNav=navigationStillActive();
  // Preserve terrain metadata specifically when escaping a known narrow/path section so
  // the replacement can still be checked for another narrow-road trap. Traffic-only
  // reroutes skip it for latency.
  const narrowEscape=activeNav&&Date.now()<__narrowHazardUntil;
  __navEnums.enableTerrainProfile=!activeNav||narrowEscape;
  __navEnums.fastReroute=activeNav;
  // User preference for this build: permit Magic Lane's own online route calculation
  // on the initial route when the exact wrapper exposes allowOnlineCalculation.
  // Active reroutes do not force network routing because the <1 s target benefits from
  // local/onboard calculation while Magic Lane's online traffic service remains enabled.
  __navEnums.preferOnlineCalculation=!activeNav&&androidNetworkAvailable();
  const expAll=ROUTE_ALGO_EXPERIMENT_MODE==='externalch-all';
  const expReroute=ROUTE_ALGO_EXPERIMENT_MODE==='externalch-reroute'&&activeNav;
  if((expAll||expReroute)&&Number.isFinite(__navEnums.externalCh)){
    __navEnums.experimentalPathAlgorithmValue=__navEnums.externalCh;
    __navEnums.experimentalPathAlgorithmName='ExternalCh';
  }else{
    __navEnums.experimentalPathAlgorithmValue=null;
    __navEnums.experimentalPathAlgorithmName='';
  }
  const r = patchRouteRequestObject(req, __navEnums);
  if (r.skipped === 'non-car') {
    log('NAV_ROUTE_PREFS_UNCHANGED reason=non-car');
    return null;
  }
  if (!r.changed) {
    const now = Date.now();
    if (now - __lastRouteShapeLogAt > 5000) {
      __lastRouteShapeLogAt = now;
      const keys = req && req.args && typeof req.args === 'object' ? Object.keys(req.args).slice(0,30).join(',') : '';
      log(`NAV_ROUTE_PREFS_UNCHANGED reason=no-known-fields enumsReady=${__navEnumsReady?'yes':'no'} argsKeys=${keys}`);
    }
    if(SIMULATION_TEST_ENABLED&&(expAll||expReroute))log(`ROUTE_ALGO_NOT_APPLIED stage=${activeNav?'reroute':'initial'} requested=ExternalCh reason=no-known-fields`);
    return null;
  }
  const pathChanged=r.fields.some(x=>String(x).replace(/[^a-z0-9]/gi,'').toLowerCase()==='pathalgorithm');
  if(SIMULATION_TEST_ENABLED){
    const requested=(expAll||expReroute)?'ExternalCh':'MagicEarth';
    log(`ROUTE_ALGO_APPLIED stage=${activeNav?'reroute':'initial'} requested=${requested} pathFieldChanged=${pathChanged?'yes':'no'} mode=${ROUTE_ALGO_EXPERIMENT_MODE||'stock'}`);
  }
  log(`NAV_ROUTE_PREFS_PATCHED fields=${r.fields.join(',')} traffic=all route=fastest unpaved=avoid accurateWaypointApproach=yes-if-exposed departureHeading=motion-if-exposed terrainProfile=${__navEnums.enableTerrainProfile?(activeNav?'narrow-reroute-on':'initial-on'):'traffic-reroute-off'} alternatives=${__navEnums.fastReroute?'never-on-reroute':'stock-initial'} onlineCalculation=${__navEnums.preferOnlineCalculation?'initial-if-exposed':'preserve'} pathAlgorithm=${Number.isFinite(__navEnums.experimentalPathAlgorithmValue)?'EXPERIMENT-ExternalCh':'stock'} defaults=preserved`);
  return JSON.stringify(req);
}

function formatDistanceMeters(v) {
  const d = Number(v);
  if (!Number.isFinite(d) || d < 0) return '';
  if (d >= 10000) return `${Math.round(d/1000)} km`;
  if (d >= 1000) return `${(d/1000).toFixed(1)} km`;
  if (d >= 100) return `${Math.round(d/50)*50} m`;
  return `${Math.max(10,Math.round(d/10)*10)} m`;
}

function installForegroundActivityTracker() {
  if (!Java.available || __activityHookKeepAlive) return;
  try {
    Java.perform(() => {
      __navBannerClass = Java.use('com.cairodrive.nav.NavBanner');
      __autocompletePanelClass = Java.use('com.cairodrive.search.AutocompletePanel');
      const Activity = Java.use('android.app.Activity');
      const onResume = Activity.onResume.overload();
      onResume.implementation = function() {
        const ret = onResume.call(this);
        try { __navBannerClass.attach(this); } catch (_) {}
        try { __autocompletePanelClass.attach(this); } catch (_) {}
        return ret;
      };
      __activityHookKeepAlive = {Activity,onResume};
      // If the agent loaded after MainActivity.onResume, attach to the already-live
      // instance once. Java.choose is used only once at initialization, never polled.
      try {
        Java.choose('com.generalmagic.magicearth.MainActivity', {
          onMatch(instance) { try { __navBannerClass.attach(instance); } catch (_) {} try { __autocompletePanelClass.attach(instance); } catch (_) {} return 'stop'; },
          onComplete() {}
        });
      } catch (_) {}
      log('LANE_ASSIST_ACTIVITY_TRACKER_READY');
    });
  } catch (e) { log(`LANE_ASSIST_ACTIVITY_TRACKER_ERROR ${String(e)}`); }
}

function makeRgba(r,g,b,a) {
  const Rgba = Java.use('com.magiclane.sdk.core.Rgba');
  const c = Rgba.$new();
  c.setRed(r); c.setGreen(g); c.setBlue(b); c.setAlpha(a);
  return Java.retain(c);
}

function inspectNativeLane(ni) {
  try {
    const lane = ni.getLaneImage();
    if (!lane) return {lane:null,uid:''};
    try { if (!lane.isValid()) return {lane:null,uid:''}; } catch (_) {}
    let uid='';
    try { uid=String(lane.getUid()); } catch (_) { try { uid=String(lane.uid()); } catch (_) {} }
    return {lane,uid};
  } catch (_) { return {lane:null,uid:''}; }
}

function renderNativeLaneBitmap(lane) {
  try {
    if (!lane) return null;
    if (!__laneColors) {
      __laneColors = {
        background: makeRgba(32,32,32,255),
        active: makeRgba(255,193,7,255),
        inactive: makeRgba(135,135,135,255)
      };
    }
    return lane.asBitmap(720,180,__laneColors.background,__laneColors.active,__laneColors.inactive) || null;
  } catch (e) {
    log(`LANE_IMAGE_ERROR ${String(e)}`);
    return null;
  }
}


function imageUid(img){
  if(!img)return '';
  try{return String(img.getUid());}catch(_){try{return String(img.uid());}catch(__){return '';}}
}
function imageValid(img){try{return !!img && (typeof img.isValid!=='function'||!!img.isValid());}catch(_){return false;}}
function unwrapBitmap(v){
  if(!v)return null;
  try{const cn=String(v.$className||'');if(cn.includes('android.graphics.Bitmap'))return v;}catch(_){}
  for(const m of ['getSecond','component2']){try{const b=v[m]();if(b)return b;}catch(_){} }
  return null;
}
function inspectNativeManeuver(ni){
  // Native priority mirrors Magic Lane's navigation examples: return-to-route
  // guidance when off-route, signpost, road-code shield, realistic turn, then
  // abstract geometry. CairoDrive never invents road geometry or shield data.
  try{const st=ni.getNavigationStatus();if(st&&/WaitingReturnToRoute|ReturnToRoute/i.test(String(st.toString()))){const im=ni.getReturnToRouteIcon();if(imageValid(im))return {image:im,uid:`return:${imageUid(im)}`,kind:'return'};}}catch(_){}
  try{const sd=ni.getSignpostDetails();if(sd){const im=sd.getImage();if(imageValid(im))return {image:im,uid:`sign:${imageUid(im)}`,kind:'signpost'};}}catch(_){}
  try{const roads=roadInfoList(ni,'next');if(roads&&ni.getRoadInfoImage){const im=ni.getRoadInfoImage(roads);if(imageValid(im))return {image:im,uid:`road:${imageUid(im)}`,kind:'roadinfo'};}}catch(_){}
  try{const im=ni.getRealisticNextTurnImage();if(imageValid(im))return {image:im,uid:`real:${imageUid(im)}`,kind:'realistic'};}catch(_){}
  try{const im=ni.getNextTurnImage();if(imageValid(im))return {image:im,uid:`simple:${imageUid(im)}`,kind:'simple'};}catch(_){}
  try{const td=ni.getNextTurnDetails();if(td){const im=td.getAbstractGeometryImage();if(imageValid(im))return {image:im,uid:`turn:${imageUid(im)}`,kind:'turn'};}}catch(_){}
  return {image:null,uid:'',kind:''};
}
function renderNativeManeuverBitmap(info){
  if(!info||!info.image)return null;
  try{
    let r=null;
    if(info.kind==='signpost'||info.kind==='roadinfo'){try{r=info.image.asBitmap(720,220);}catch(_){} }
    if(!r){try{r=info.image.asBitmap(260,220);}catch(_){} }
    if(!r){try{r=info.image.asBitmap();}catch(_){} }
    return unwrapBitmap(r)||r||null;
  }catch(e){log(`MANEUVER_IMAGE_ERROR kind=${info.kind||'unknown'} ${String(e)}`);return null;}
}


function readMagicCoordinate(c){
  if(!c)return null;let lat=NaN,lon=NaN;
  try{lat=Number(c.getLatitude());}catch(_){try{lat=Number(c.latitude.value);}catch(__){}}
  try{lon=Number(c.getLongitude());}catch(_){try{lon=Number(c.longitude.value);}catch(__){}}
  return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{latitude:lat,longitude:lon}:null;
}
function magicRouteCoordinate(route,distanceM){
  try{return readMagicCoordinate(route.getCoordinateOnRoute(Math.max(0,Math.round(distanceM))));}catch(_){try{return readMagicCoordinate(route.getCoordinateOnRoute(Number(distanceM)));}catch(__){return null;}}
}
function collectTrafficRouteSnapshot(route){
  if(!route||!Java.available)return null;
  try{
    const totalTd=route.getTimeDistance(false),remainTd=route.getTimeDistance(true);if(!totalTd||!remainTd)return null;
    const total=Number(totalTd.getTotalDistance()),remain=Number(remainTd.getTotalDistance());if(!Number.isFinite(total)||!Number.isFinite(remain)||remain<800||total<=0)return null;
    const progressed=Math.max(0,total-remain);
    const ActivityThread=Java.use('android.app.ActivityThread'),app=ActivityThread.currentApplication();if(!app)return null;const loc=bestLocalLocation(app.getApplicationContext());
    if(!loc||!Number.isFinite(loc.lat)||!Number.isFinite(loc.lon)||!Number.isFinite(loc.acc)||loc.acc>50||Date.now()-loc.t>120000)return null;
    const destination=magicRouteCoordinate(route,Math.max(0,total-2));if(!destination)return null;
    const step=Math.max(50,Math.ceil(remain/260/10)*10),samples=[];
    for(let d=progressed;d<=total&&samples.length<280;d+=step){const c=magicRouteCoordinate(route,d);if(c)samples.push({...c,routeDistanceM:d,stepM:step});}
    if(samples.length<4)return null;
    for(let i=0;i<samples.length;i++){const a=samples[i],b=samples[Math.min(samples.length-1,i+1)];a.heading=i+1<samples.length?bearingDeg(a,b):(i?Number(samples[i-1].heading):Number(loc.bearing));}
    const vias=[];for(let k=1;k<=8;k++){const d=progressed+remain*(k/9);const c=magicRouteCoordinate(route,d);if(c)vias.push(c);}
    return {origin:{latitude:loc.lat,longitude:loc.lon},destination,samples,vias,total,remain,progressed,accuracyM:loc.acc,destinationSig:`${destination.latitude.toFixed(5)},${destination.longitude.toFixed(5)}`};
  }catch(e){log(`GOOGLE_TRAFFIC_SNAPSHOT_ERROR ${String(e)}`);return null;}
}
function classifyRoutesFailure(status,body){const f=classifyGoogleFailure(status,body);if(status===429)return {...f,cooldownMs:300000};if(status>=500)return {...f,cooldownMs:60000};return f;}
function navigationStillActive(){let active=false;if(!Java.available||!__navServiceKeepAlive)return false;try{Java.perform(()=>{active=routeServiceActive(__navServiceKeepAlive);});}catch(_){}return active;}
async function requestGoogleTrafficAdvice(snapshot,seq,initial=false){
  if(!androidNetworkAvailable()){__trafficAdviceInFlight=false;log('GOOGLE_TRAFFIC_FALLBACK reason=offline');return;}
  migratePrivateState();if(!GOOGLE_ROUTES_API_KEY)GOOGLE_ROUTES_API_KEY=GOOGLE_PLACES_API_KEY;
  if(!GOOGLE_ROUTES_API_KEY||googleRoutesAuthBlocked||Date.now()<googleRoutesBlockedUntil||!resolveIdentity()){__trafficAdviceInFlight=false;log('GOOGLE_TRAFFIC_FALLBACK reason=key-auth-cooldown-or-identity');return;}
  const routingPreference=initial?'TRAFFIC_AWARE_OPTIMAL':'TRAFFIC_AWARE';
  const body=buildTrafficRequest(snapshot.origin,snapshot.destination,{languageCode:'en',routingPreference,viaPoints:snapshot.vias});
  const token=startHttpPost(ROUTES_URL,googleRoutesHeaders(),body,true,initial?8500:6000);if(!token){__trafficAdviceInFlight=false;log('GOOGLE_TRAFFIC_FALLBACK reason=http-helper-unavailable');return;}
  __activeTrafficHttpToken=token;
  googleTrafficRequests++;const t0=Date.now();log(`GOOGLE_TRAFFIC_REQUEST requestNo=${googleTrafficRequests} preference=${routingPreference} remainM=${Math.round(snapshot.remain)} samples=${snapshot.samples.length} vias=${snapshot.vias.length} gpsAccM=${snapshot.accuracyM.toFixed(1)}`);
  const result=await new Promise(resolve=>{const tick=()=>{const r=pollHttp(token);if(!r||!r.done){setTimeout(tick,100);return;}resolve(r);};tick();});
  if(__activeTrafficHttpToken===token)__activeTrafficHttpToken=null;
  __trafficAdviceInFlight=false;if(seq!==__trafficAdviceSeq||!navigationStillActive()){log('GOOGLE_TRAFFIC_FALLBACK reason=stale-or-navigation-ended');return;}
  if(result.cancelled){log('GOOGLE_TRAFFIC_FALLBACK reason=cancelled');return;}
  if(result.error){googleRoutesBlockedUntil=Math.max(googleRoutesBlockedUntil,Date.now()+15000);__networkAvailableAt=0;log(`GOOGLE_TRAFFIC_FALLBACK reason=network error=${String(result.error).slice(0,140)}`);return;}
  if(result.status<200||result.status>=300){const f=classifyRoutesFailure(result.status,result.body);if(f.kind==='auth')googleRoutesAuthBlocked=true;else if(Number.isFinite(f.cooldownMs)&&f.cooldownMs>0)googleRoutesBlockedUntil=Date.now()+f.cooldownMs;log(`GOOGLE_TRAFFIC_FALLBACK reason=http status=${result.status} kind=${f.kind}`);return;}
  try{
    const traffic=parseTrafficRoutesResponse(result.body);googleTrafficSuccess++;
    const match=matchMagicSamplesToTraffic(snapshot.samples,traffic,{maxDistanceM:35,maxHeadingDiffDeg:40,minCoverage:0.65});
    const matchedM=match.normalM+match.slowM+match.jamM,jamRatio=matchedM?match.jamM/matchedM:0,slowRatio=matchedM?match.slowM/matchedM:0;
    __trafficRefreshAfterMs=trafficRefreshIntervalMs(match);
    const delay=Number(traffic.trafficDelaySeconds);
    log(`GOOGLE_TRAFFIC_OK ms=${Date.now()-t0} successNo=${googleTrafficSuccess} preference=${routingPreference} googleDistanceM=${Math.round(traffic.distanceMeters||0)} trafficDelayS=${Number.isFinite(delay)?Math.round(delay):'na'} nextRefreshS=${Math.round(__trafficRefreshAfterMs/1000)}`);
    log(`GOOGLE_TRAFFIC_MATCH coverage=${match.coverage.toFixed(3)} normalM=${Math.round(match.normalM)} slowM=${Math.round(match.slowM)} jamM=${Math.round(match.jamM)} jamRatio=${jamRatio.toFixed(3)} slowRatio=${slowRatio.toFixed(3)} candidateChecks=${match.candidateChecks||0} bruteChecks=${match.totalEdgeChecksBruteForce||0}`);
    if(!match.usable){__trafficSeverityLevel=1;__trafficSeverityUntil=Date.now()+60000;log('GOOGLE_TRAFFIC_FALLBACK reason=low-map-match-confidence');return;}
    const severity=classifyTrafficLevel(match,traffic);
    __trafficSeverityLevel=Math.max(1,Number(severity.level)||1);
    __trafficSeverityUntil=Date.now()+Math.max(90000,__trafficRefreshAfterMs);
    log(`GOOGLE_TRAFFIC_LEVEL level=${__trafficSeverityLevel} reason=${severity.reason} affectedM=${Math.round(severity.affectedM||0)} delayS=${Number.isFinite(Number(severity.delaySeconds))?Math.round(Number(severity.delaySeconds)):'na'} action=${__trafficSeverityLevel>=3?'avoid':__trafficSeverityLevel===2?'native-better-route-decision':'keep'}`);
    if(__trafficSeverityLevel===1){log('GOOGLE_TRAFFIC_KEEP reason=level1-normal-or-minor');return;}
    if(__trafficSeverityLevel===2){
      __routeAssistReason='Moderate traffic ahead • Magic Earth checking alternatives';
      __routeAssistReasonUntil=Date.now()+45000;
      log('GOOGLE_TRAFFIC_KEEP reason=level2-let-native-better-route-decide');
      return;
    }
    const run=match.strongJamRun;if(!run||run.lengthM<120){log('GOOGLE_TRAFFIC_KEEP reason=level3-without-actionable-run');return;}
    const durationEvidence=hasMeaningfulTrafficDelay(traffic,{minSeconds:75,minRatio:0.06});
    const longJamWithoutDuration=(!Number.isFinite(Number(traffic.trafficDelaySeconds))||!Number.isFinite(Number(traffic.staticDurationSeconds)))&&run.lengthM>=300;
    if(!durationEvidence&&!longJamWithoutDuration){log(`GOOGLE_TRAFFIC_KEEP reason=jam-low-or-missing-delay delayS=${Number.isFinite(Number(traffic.trafficDelaySeconds))?Math.round(Number(traffic.trafficDelaySeconds)):'na'} runM=${Math.round(run.lengthM)}`);return;}
    const ahead=run.startRouteDistanceM-snapshot.progressed,remainingAfter=snapshot.total-run.endRouteDistanceM;
    if(ahead<80||ahead>3500||remainingAfter<500){log(`GOOGLE_TRAFFIC_KEEP reason=jam-outside-action-window aheadM=${Math.round(ahead)} afterM=${Math.round(remainingAfter)}`);return;}
    const key=`${Math.round(run.startRouteDistanceM/100)}`;const prior=Number(__trafficAvoidedSections.get(key)||0),now=Date.now();if(now-prior<10*60*1000||now-__lastTrafficRoadblockAt<90000){log('GOOGLE_TRAFFIC_KEEP reason=reroute-hysteresis');return;}
    const length=Math.min(900,Math.max(120,run.lengthM+80));
    if(invokeNavigationRoadBlock(length,ahead,'google-traffic')){
      __trafficAvoidedSections.set(key,now);__lastTrafficRoadblockAt=now;__routeAssistReason='Avoiding Google-detected traffic jam';__routeAssistReasonUntil=now+120000;
      log(`GOOGLE_TRAFFIC_ROADBLOCK routeStartM=${Math.round(run.startRouteDistanceM)} startAheadM=${Math.round(ahead)} lengthM=${Math.round(length)} coverage=${match.coverage.toFixed(3)}`);toastMessage('Heavy traffic ahead — checking a faster Magic Earth route');
    }else log('GOOGLE_TRAFFIC_FALLBACK reason=roadblock-api-unavailable');
  }catch(e){log(`GOOGLE_TRAFFIC_FALLBACK reason=parse-or-match error=${String(e).slice(0,180)}`);}
}
function maybeScheduleGoogleTraffic(route){
  const now=Date.now();if(__trafficAdviceInFlight||googleRoutesAuthBlocked||now<googleRoutesBlockedUntil)return;
  const snapshot=collectTrafficRouteSnapshot(route);if(!snapshot)return;
  const destinationChanged=snapshot.destinationSig!==__trafficDestinationSig;
  if(!destinationChanged&&now-__lastTrafficAdviceAt<__trafficRefreshAfterMs)return;
  if(destinationChanged){__trafficRefreshAfterMs=180000;__trafficAvoidedSections.clear();__trafficSeverityLevel=1;__trafficSeverityUntil=0;__narrowHazardUntil=0;try{__comfortAvoidedSections.clear();}catch(_){}}
  __trafficDestinationSig=snapshot.destinationSig;__lastTrafficAdviceAt=now;__trafficAdviceInFlight=true;const seq=++__trafficAdviceSeq;
  setTimeout(()=>requestGoogleTrafficAdvice(snapshot,seq,destinationChanged),0);
}

let __lastComfortScanAt=0;
let __lastComfortBlockAt=0;
const __comfortAvoidedSections=new Map();
let __roadBlockSignatureLogged=false;
function cancelTrafficForNativeRecompute(source='navigation'){
  if(__activeTrafficHttpToken){
    try{cancelHttp(__activeTrafficHttpToken);}catch(_){}
    __activeTrafficHttpToken=null;
    __trafficAdviceSeq++;
    __trafficAdviceInFlight=false;
    log(`GOOGLE_TRAFFIC_PAUSED reason=route-recompute source=${source}`);
  }
}
function markRouteRecomputeStart(source='unknown'){
  const now=Date.now();
  if(!__routeRecomputeInFlight){
    __routeRecomputeInFlight=true;
    __routeCalculationStartedAt=now;
    __routeCalculationCount++;
    cancelTrafficForNativeRecompute(source);
    log(`ROUTE_RECOMPUTE_STARTED count=${__routeCalculationCount} source=${source} targetMs=${ROUTE_RECOMPUTE_TARGET_MS}`);
  }
}
function markRouteRecomputeDone(source='unknown'){
  if(!__routeRecomputeInFlight&&!__routeCalculationStartedAt)return;
  const now=Date.now();
  const ms=__routeCalculationStartedAt?now-__routeCalculationStartedAt:-1;
  const ok=ms>=0&&ms<ROUTE_RECOMPUTE_TARGET_MS;
  log(`ROUTE_RECOMPUTE_DONE count=${__routeCalculationCount} source=${source} ms=${ms} targetMs=${ROUTE_RECOMPUTE_TARGET_MS} sub1s=${ok?'yes':'no'}`);
  if(__routeRecomputeTriggerAt){
    const e2e=now-__routeRecomputeTriggerAt;
    const bench=__benchmarkPending?` algorithm=${__benchmarkPending.algorithm||'unknown'} token=${__benchmarkPending.token||'none'}`:'';
    log(`ROUTE_RECOMPUTE_E2E reason=${__routeRecomputeTriggerReason||'unknown'} ms=${e2e} targetMs=${ROUTE_RECOMPUTE_TARGET_MS} sub1s=${e2e<ROUTE_RECOMPUTE_TARGET_MS?'yes':'no'}${bench}`);
    __routeRecomputeTriggerAt=0;__routeRecomputeTriggerReason='';
  }
  try{if(__benchmarkPending)logBenchmarkRouteResult(currentCapturedRoute(),'after',source);}catch(_){}
  __routeCalculationStartedAt=0;__routeRecomputeInFlight=false;
}
function noteRouteRecomputeTrigger(reason){
  __routeRecomputeTriggerAt=Date.now();
  __routeRecomputeTriggerReason=String(reason||'unknown');
  markRouteRecomputeStart(`trigger:${__routeRecomputeTriggerReason}`);
}

function invokeNavigationRoadBlock(lengthM,startDistanceM,reason='narrow'){
  if(!__navServiceKeepAlive)return false;
  const length=Math.max(30,Math.min(1500,Math.round(Number(lengthM)||0)));
  const start=Math.max(0,Math.round(Number(startDistanceM)||0));
  try{
    const f=__navServiceKeepAlive.setNavigationRoadBlock;
    const ovs=f&&f.overloads?f.overloads:[];
    for(const ov of ovs){
      const types=(ov.argumentTypes||[]).map(x=>String(x.className||x.name||x));
      try{
        if(types.length>=2 && /int/.test(types[0]) && /int/.test(types[1])){
          const args=[length,start]; while(args.length<types.length)args.push(null);
          ov.call(__navServiceKeepAlive,...args);
          noteRouteRecomputeTrigger(reason);log(`NAV_ROADBLOCK_APPLIED reason=${reason} lengthM=${length} startAheadM=${start} signature=${types.join(',')}`);return true;
        }
      }catch(_){}
    }
    if(!__roadBlockSignatureLogged){__roadBlockSignatureLogged=true;log(`NARROW_ROADBLOCK_UNAVAILABLE overloads=${ovs.map(o=>(o.argumentTypes||[]).map(x=>String(x.className||x.name||x)).join('+')).join('|')||'none'}`);}
  }catch(e){log(`NARROW_ROADBLOCK_ERROR ${String(e)}`);}
  return false;
}
function strongNarrowEvidenceOnRoute(route){
  if(!route)return {known:false,narrow:false,type:'',lengthM:0,startM:NaN};
  try{
    const profile=route.getTerrainProfile(); if(!profile)return {known:false,narrow:false,type:'',lengthM:0,startM:NaN};
    const td=route.getTimeDistance(false); const total=td?Number(td.getTotalDistance()):NaN;
    const sections=profile.getRoadTypeSections(); if(!sections)return {known:true,narrow:false,type:'',lengthM:0,startM:NaN};
    const n=Number(sections.size()); if(!Number.isFinite(n)||n<=0)return {known:true,narrow:false,type:'',lengthM:0,startM:NaN};
    for(let i=0;i<n;i++){
      const sec=sections.get(i); if(!sec)continue;
      const typeObj=sec.getType(); const type=String(typeObj?typeObj.toString():'').toLowerCase();
      if(!(type.includes('singletrack')||/(^|\.)path$/.test(type)))continue;
      const start=Number(sec.getStartDistanceM());
      const next=i+1<n?Number(sections.get(i+1).getStartDistanceM()):total;
      const end=Number.isFinite(next)?next:total, len=Math.max(0,end-start);
      if(!Number.isFinite(start)||len<35)continue;
      if(Number.isFinite(total)&&total-end<300)continue; // destination access can legitimately be path-like.
      return {known:true,narrow:true,type,lengthM:len,startM:start};
    }
    return {known:true,narrow:false,type:'',lengthM:0,startM:NaN};
  }catch(_){return {known:false,narrow:false,type:'',lengthM:0,startM:NaN};}
}

function analyzeUpcomingComfortRoute(route){
  const now=Date.now(); if(!route||now-__lastComfortScanAt<10000||now-__lastComfortBlockAt<120000)return;
  __lastComfortScanAt=now;
  try{
    const profile=route.getTerrainProfile(); if(!profile)return;
    const totalTd=route.getTimeDistance(false), remainTd=route.getTimeDistance(true);
    const total=totalTd?Number(totalTd.getTotalDistance()):NaN, remain=remainTd?Number(remainTd.getTotalDistance()):NaN;
    if(!Number.isFinite(total)||!Number.isFinite(remain)||total<=0)return;
    const progressed=Math.max(0,total-remain);
    const sections=profile.getRoadTypeSections(); if(!sections)return;
    const n=Number(sections.size()); if(!Number.isFinite(n)||n<=0)return;
    for(let i=0;i<n;i++){
      const sec=sections.get(i); if(!sec)continue;
      const typeObj=sec.getType(); const type=String(typeObj?typeObj.toString():'').toLowerCase();
      if(!(type.includes('singletrack')||/(^|\.)path$/.test(type)))continue;
      const start=Number(sec.getStartDistanceM());
      const next=i+1<n?Number(sections.get(i+1).getStartDistanceM()):total;
      const end=Number.isFinite(next)?next:total, len=Math.max(0,end-start), ahead=start-progressed;
      if(!Number.isFinite(start)||ahead<70||ahead>1200||len<35)continue;
      if(total-end<300){log(`NARROW_EVIDENCE_SKIP type=${type} reason=near-destination aheadM=${Math.round(ahead)} lenM=${Math.round(len)}`);continue;}
      const key=`${type}:${Math.round(start/25)}`;
      const prior=Number(__comfortAvoidedSections.get(key)||0); if(now-prior<20*60*1000)continue;
      log(`NARROW_EVIDENCE type=${type} aheadM=${Math.round(ahead)} lenM=${Math.round(len)} confidence=strong action=temporary-roadblock`);
      if(invokeNavigationRoadBlock(Math.min(600,len+30),ahead,'narrow-road')){
        __comfortAvoidedSections.set(key,now);__lastComfortBlockAt=now;__narrowHazardUntil=now+120000;
        toastMessage('Avoiding a very narrow/path-like road — checking another route');
        break;
      }
    }
  }catch(e){log(`NARROW_PROFILE_ERROR ${String(e)}`);}
}

function arrivalStatusForCurrentRoute(route){
  try{
    const b=__activeGoogleDestination;if(!b||!b.place||!b.place.richLoaded||!route)return '';
    const td=route.getTimeDistance(true);if(!td)return '';
    const eta=Number(td.getTotalTime());
    const state=openAtArrivalStatus(b.place,eta,Date.now());
    if(state)log(`ARRIVAL_OPEN_CHECK placeId=${b.placeId.slice(0,60)} etaSec=${Math.round(eta)} state=${state.startsWith('OPEN')?'open':'closed'}`);
    return state;
  }catch(_){return '';}
}



function nextSpeedLimitVariation(ni,currentLimitMps) {
  // Android's guide describes upcoming speed limits but some 1.9.0 Java
  // wrappers do not expose the method in every generated surface. Probe once
  // per instruction object and fail open instead of assuming a newer ABI.
  try{
    if(!ni||typeof ni.getNextSpeedLimitVariation!=='function')return null;
    const next=ni.getNextSpeedLimitVariation(1500);if(!next)return null;
    let distance=NaN,speed=NaN,status='';
    try{distance=Number(next.getDistance());}catch(_){try{distance=Number(next.distance.value);}catch(__){}}
    try{speed=Number(next.getSpeed());}catch(_){try{speed=Number(next.speed.value);}catch(__){}}
    try{const st=next.getStatus();if(st)status=String(st.toString());}catch(_){try{status=String(next.status.value||'');}catch(__){}}
    if(!Number.isFinite(distance)||distance<=0||distance>1500||!Number.isFinite(speed)||speed<=0)return null;
    if(Number.isFinite(currentLimitMps)&&currentLimitMps>0&&Math.abs(speed-currentLimitMps)<0.25)return null;
    const speedKmh=Math.max(1,Math.round(speed*3.6));
    return {distanceM:Math.round(distance),speedMps:speed,speedKmh,status,text:`NEXT ${speedKmh} km/h in ${formatDistanceMeters(distance)}`};
  }catch(_){return null;}
}

function speedAssistForInstruction(ni) {
  if(!ni||!Java.available)return {text:'',over:false,next:null};
  try{
    const limitMps=Number(ni.getCurrentStreetSpeedLimit());
    const next=nextSpeedLimitVariation(ni,limitMps);
    if(!Number.isFinite(limitMps)||limitMps<=0)return {text:next?next.text:'',over:false,next};
    const limitKmh=Math.max(1,Math.round(limitMps*3.6));
    let loc=null;try{const ActivityThread=Java.use('android.app.ActivityThread'),app=ActivityThread.currentApplication();if(app)loc=bestLocalLocation(app.getApplicationContext());}catch(_){}
    const fresh=loc&&Number.isFinite(loc.speed)&&loc.speed>=0&&Date.now()-loc.t<10000&&loc.acc<=40;
    const speedKmh=fresh?Math.max(0,Math.round(loc.speed*3.6)):null;
    // Require ~5.4 km/h above the mapped limit before treating GPS noise as an
    // actual overspeed condition. The legal limit itself is always displayed.
    const over=Number.isFinite(speedKmh)&&loc.speed>limitMps+1.5;
    const current=over?`⚠ SPEED ${speedKmh} > ${limitKmh} km/h`:`LIMIT ${limitKmh} km/h${Number.isFinite(speedKmh)?` • ${speedKmh} km/h`:''}`;
    const text=[current,next&&next.text].filter(Boolean).join(' • ');
    const key=`${limitKmh}:${over?'over':'ok'}:${Number.isFinite(speedKmh)?Math.round(speedKmh/5)*5:'na'}:${next?next.speedKmh+'@'+Math.round(next.distanceM/100)*100:'none'}`;
    if(key!==__lastSpeedAssistLogKey){__lastSpeedAssistLogKey=key;log(`SPEED_ASSIST limitKmh=${limitKmh} speedKmh=${Number.isFinite(speedKmh)?speedKmh:'na'} over=${over?'yes':'no'} next=${next?`${next.speedKmh}@${next.distanceM}m`:'none'} source=MagicLane-NavigationInstruction`);}
    if(over&&!__nativeSpeedAlarmConfigured&&Date.now()-__lastOverSpeedToastAt>30000){__lastOverSpeedToastAt=Date.now();toastMessage(`Speed ${speedKmh} km/h — limit ${limitKmh}`);}
    return {text,over,limitKmh,speedKmh,next};
  }catch(e){return {text:'',over:false,next:null};}
}


function timeDistanceParts(td) {
  if(!td)return {timeS:NaN,distanceM:NaN};
  let timeS=NaN,distanceM=NaN;
  try{timeS=Number(td.getTotalTime());}catch(_){}
  try{distanceM=Number(td.getTotalDistance());}catch(_){}
  return {timeS,distanceM};
}
function formatDurationSeconds(seconds) {
  const s=Number(seconds);if(!Number.isFinite(s)||s<0)return '';
  const mins=Math.max(0,Math.round(s/60));
  if(mins<60)return `${mins} min`;
  const h=Math.floor(mins/60),m=mins%60;return m?`${h}h ${m}m`:`${h}h`;
}
function formatEtaFromSeconds(seconds) {
  const s=Number(seconds);if(!Number.isFinite(s)||s<0)return '';
  try{return new Date(Date.now()+s*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}catch(_){const d=new Date(Date.now()+s*1000);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
}
function routeProgressSummary(ni,route) {
  let td=null;
  try{td=ni&&ni.getRemainingTravelTimeDistance?ni.getRemainingTravelTimeDistance():null;}catch(_){}
  if(!td&&route){try{td=route.getTimeDistance(true);}catch(_){}}
  const p=timeDistanceParts(td);if(!Number.isFinite(p.timeS)&&!Number.isFinite(p.distanceM))return '';
  const pieces=[];const eta=formatEtaFromSeconds(p.timeS),dur=formatDurationSeconds(p.timeS),dist=formatDistanceMeters(p.distanceM);
  if(eta)pieces.push(`ETA ${eta}`);if(dur)pieces.push(dur);if(dist)pieces.push(dist);
  return pieces.join(' • ');
}
function nextWaypointDriveSideText(ni) {
  // Magic Lane 1.8.0+ exposes NavigationInstruction.nextWaypointDriveSide.
  // Treat it as presentation-only QoL: never alter routing based on the side.
  try{
    if(!ni||typeof ni.getNextWaypointDriveSide!=='function')return '';
    const side=ni.getNextWaypointDriveSide();if(!side)return '';
    const raw=String(side.toString?side.toString():side).replace(/^.*\./,'').trim();
    const low=raw.toLowerCase();
    if(low.includes('left'))return 'LEFT SIDE';
    if(low.includes('right'))return 'RIGHT SIDE';
  }catch(_){}
  return '';
}
function nextWaypointSummary(ni,route) {
  // The next-waypoint TimeDistance API existed before the 1.9.0 target.  Keep
  // the banner minimal: show a separate NEXT STOP only for a genuine
  // intermediate waypoint; for the final destination surface only left/right
  // approach when close enough to be actionable.
  if(!ni)return '';
  let nextTd=null,totalTd=null;
  try{if(typeof ni.getRemainingTravelTimeDistanceToNextWaypoint==='function')nextTd=ni.getRemainingTravelTimeDistanceToNextWaypoint();}catch(_){}
  if(!nextTd)return '';
  try{if(typeof ni.getRemainingTravelTimeDistance==='function')totalTd=ni.getRemainingTravelTimeDistance();}catch(_){}
  if(!totalTd&&route){try{totalTd=route.getTimeDistance(true);}catch(_){} }
  const wp=timeDistanceParts(nextTd), total=timeDistanceParts(totalTd), side=nextWaypointDriveSideText(ni);
  if(!Number.isFinite(wp.distanceM)||wp.distanceM<0)return '';
  const intermediate=Number.isFinite(total.distanceM)&&total.distanceM-wp.distanceM>250 && (!Number.isFinite(total.timeS)||!Number.isFinite(wp.timeS)||total.timeS-wp.timeS>45);
  if(intermediate){
    const bits=['NEXT STOP'];const dur=formatDurationSeconds(wp.timeS),dist=formatDistanceMeters(wp.distanceM);
    if(dur)bits.push(dur);if(dist)bits.push(dist);if(side&&wp.distanceM<=1800)bits.push(side);
    return bits.join(' • ');
  }
  if(side&&wp.distanceM<=1800)return `DESTINATION ${side}`;
  return '';
}
function roadInfoList(ni,which='next') {
  try{
    if(which==='current'&&ni.getCurrentRoadInformation)return ni.getCurrentRoadInformation();
    if(which==='nextnext'&&ni.getNextNextRoadInformation)return ni.getNextNextRoadInformation();
    if(ni.getNextRoadInformation)return ni.getNextRoadInformation();
  }catch(_){}
  return null;
}
function roadCodeText(list) {
  if(!list)return '';
  const parts=[];let n=0;try{n=Number(list.size());}catch(_){try{n=Number(list.length);}catch(__){}}
  for(let i=0;i<Math.min(n||0,6);i++){
    let ri=null;try{ri=list.get(i);}catch(_){try{ri=list[i];}catch(__){}}
    if(!ri)continue;let name='';
    for(const m of ['getRoadName','getName','getText']){try{if(typeof ri[m]==='function'){name=String(ri[m]()||'').trim();if(name)break;}}catch(_){}}
    if(name&&!parts.includes(name))parts.push(name);
  }
  return parts.join(' / ');
}
function roundaboutExitNumber(ni) {
  try{const td=ni.getNextTurnDetails();if(td){const n=Number(td.getRoundaboutExitNumber());if(Number.isFinite(n)&&n>0)return Math.trunc(n);}}catch(_){}
  return -1;
}
function nextNextTurnSummary(ni) {
  try{
    if(!ni.hasNextNextTurnInfo())return '';
    let event='',instruction='',distance=NaN,exit=-1;
    try{instruction=String(ni.getNextNextTurnInstruction()||'').trim();}catch(_){}
    try{const td=ni.getTimeDistanceToNextNextTurn();if(td)distance=Number(td.getTotalDistance());}catch(_){}
    try{const turn=ni.getNextNextTurnDetails();if(turn){const ev=turn.getEvent();if(ev)event=String(ev.toString());const n=Number(turn.getRoundaboutExitNumber());if(Number.isFinite(n)&&n>0)exit=Math.trunc(n);}}catch(_){}
    const b=eventToBanner(event,instruction);let title=b.title.replace(/[◀▶▲]/g,'').trim();if(exit>0&&/ROUNDABOUT/.test(title))title=`ROUNDABOUT EXIT ${exit}`;
    const d=formatDistanceMeters(distance);return `THEN: ${title}${d?` IN ${d}`:''}`;
  }catch(_){return '';}
}
function approximateDistanceM(a,b){
  if(!a||!b)return NaN;const r=6371000,toRad=x=>x*Math.PI/180,dLat=toRad(Number(b.latitude)-Number(a.latitude)),dLon=toRad(Number(b.longitude)-Number(a.longitude)),la1=toRad(Number(a.latitude)),la2=toRad(Number(b.latitude));
  const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;return 2*r*Math.asin(Math.min(1,Math.sqrt(h)));
}
function returnToRouteDistance(ni){
  try{
    const c=readMagicCoordinate(ni.getReturnToRoutePosition());if(!c)return NaN;
    const ActivityThread=Java.use('android.app.ActivityThread'),app=ActivityThread.currentApplication();if(!app)return NaN;const loc=bestLocalLocation(app.getApplicationContext());if(!loc)return NaN;
    return approximateDistanceM({latitude:loc.lat,longitude:loc.lon},c);
  }catch(_){return NaN;}
}

function nativeTrafficEventAhead(route) {
  if(!route)return null;
  try{
    const td=route.getTimeDistance(true);if(!td)return null;const remaining=Number(td.getTotalDistance());if(!Number.isFinite(remaining))return null;
    const events=route.getTrafficEvents();if(!events)return null;const n=Number(events.size());if(!Number.isFinite(n)||n<=0)return null;
    let best=null;
    for(let i=0;i<n;i++){
      const ev=events.get(i);if(!ev)continue;
      let delay=0,length=0,distToDest=NaN,desc='',cls='',severity='';
      try{delay=Number(ev.getDelay());}catch(_){} try{length=Math.max(0,Number(ev.getLength()));}catch(_){}
      try{distToDest=Number(ev.getDistanceToDestination());}catch(_){} try{desc=String(ev.getDescription()||'').trim();}catch(_){}
      try{const x=ev.getEventClass();if(x)cls=String(x.toString()).replace(/^.*\./,'').replaceAll('_',' ');}catch(_){}
      try{const x=ev.getEventSeverity();if(x)severity=String(x.toString()).replace(/^.*\./,'').replaceAll('_',' ');}catch(_){}
      if(!Number.isFinite(distToDest)||delay===0)continue;
      const ahead=remaining-distToDest;
      const inside=ahead<0 && length-(distToDest-remaining)>=0;
      if(!inside&&ahead<0)continue;
      const effectiveAhead=inside?0:ahead;if(effectiveAhead>15000)continue;
      if(!best||effectiveAhead<best.ahead||effectiveAhead===best.ahead&&delay>best.delay)best={ahead:effectiveAhead,inside,delay,length,desc,cls,severity};
    }
    if(!best)return null;
    const delayMin=best.delay>0?Math.max(1,Math.round(best.delay/60)):0;
    const where=best.inside?'NOW':formatDistanceMeters(best.ahead);
    const what=best.desc||best.cls||best.severity||'traffic event';
    const text=`TRAFFIC ${delayMin?`+${delayMin} min`:''}${where?` • ${where}`:''}${what?` • ${what}`:''}`.replace(/\s+/g,' ').trim();
    const key=`${Math.round(best.ahead/100)}:${Math.round(best.delay/30)}:${what}`;
    if(key!==__lastNativeTrafficEventKey){__lastNativeTrafficEventKey=key;log(`MAGICLANE_TRAFFIC_EVENT aheadM=${Math.round(best.ahead)} inside=${best.inside?'yes':'no'} delayS=${Math.round(best.delay)} lengthM=${Math.round(best.length)} class=${best.cls||'unknown'} severity=${best.severity||'unknown'} description=${JSON.stringify(best.desc).slice(0,140)}`);}
    return {...best,text};
  }catch(e){return null;}
}

function navigationStatusAssist(ni) {
  if(!ni)return {text:'',attention:false};
  try{
    const obj=ni.getNavigationStatus();if(!obj)return {text:'',attention:false};
    const raw=String(obj.toString()||'').replace(/^.*\./,'');
    const norm=raw.replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ').trim();
    const low=norm.toLowerCase();
    const running=low==='running'||low.includes('navigationstatus running');
    let text=running?'':(
      low.includes('gps')?'WAITING FOR GPS':
      low.includes('return')?'RETURN TO ROUTE':
      low.includes('route')?'RECALCULATING ROUTE':
      norm.toUpperCase()
    );
    if(low.includes('return')){const d=returnToRouteDistance(ni);if(Number.isFinite(d)&&d>=0)text+=` • ${formatDistanceMeters(d)}`;}
    if(raw!==__lastNavigationStatusKey){__lastNavigationStatusKey=raw;log(`NAVIGATION_STATUS status=${raw||'unknown'} attention=${running?'no':'yes'}`);}
    return {text,attention:!running&&!!text,raw};
  }catch(_){return {text:'',attention:false};}
}

function restrictionEnumEntries() {
  if(__restrictionEnumCache)return __restrictionEnumCache;
  const out=[];
  try{
    const E=Java.use('com.magiclane.sdk.routesandnavigation.ERouteRestrictionType');
    let vals=null;try{vals=E.values();}catch(_){}
    if(vals){
      for(let i=0;i<vals.length;i++){
        const e=vals[i];let v=0,n='';
        try{v=Number(e.getValue());}catch(_){try{v=Number(e.value);}catch(__){}}
        try{n=String(e.name());}catch(_){try{n=String(e.toString()).replace(/^.*\./,'');}catch(__){}}
        if(Number.isFinite(v)&&v>0&&n)out.push({value:v,name:n});
      }
    }
  }catch(_){}
  __restrictionEnumCache=out;
  return out;
}
function decodeRestrictionMask(mask) {
  const m=Number(mask)||0;if(!m)return [];
  const names=[];for(const e of restrictionEnumEntries()){if((m&e.value)===e.value)names.push(e.name.replace(/([a-z])([A-Z])/g,'$1 $2'));}
  return names.length?names:[`restriction mask 0x${(m>>>0).toString(16)}`];
}
function restrictionAssist(ni,route) {
  try{
    let activeMask=0;try{activeMask=Number(ni.getCurrentRestrictions())||0;}catch(_){}
    const activeNames=decodeRestrictionMask(activeMask);
    if(activeNames.length){
      const text=`RESTRICTION NOW: ${activeNames.slice(0,3).join(', ')}`;
      if(text!==__lastRestrictionAssistKey){__lastRestrictionAssistKey=text;log(`ROUTE_RESTRICTION active=yes mask=${activeMask} names=${JSON.stringify(activeNames)}`);}
      return {text,attention:true,ahead:0};
    }
    if(!route)return {text:'',attention:false};
    let total=NaN,remain=NaN;
    try{const a=route.getTimeDistance(false),b=route.getTimeDistance(true);if(a)total=Number(a.getTotalDistance());if(b)remain=Number(b.getTotalDistance());}catch(_){}
    if(!Number.isFinite(total)||!Number.isFinite(remain))return {text:'',attention:false};
    const progressed=Math.max(0,total-remain);let sections=null;try{sections=route.getRestrictionSections();}catch(_){}
    if(!sections)return {text:'',attention:false};
    const n=Number(sections.size());let best=null;
    for(let i=0;i<n;i++){
      const sec=sections.get(i);if(!sec)continue;let start=NaN,mask=0;
      try{start=Number(sec.getStartDistanceM());}catch(_){} try{mask=Number(sec.getRestrictions())||0;}catch(_){}
      if(!Number.isFinite(start)||start<=progressed||!mask)continue;
      const ahead=start-progressed;if(ahead>5000)continue;
      if(!best||ahead<best.ahead)best={ahead,mask,names:decodeRestrictionMask(mask)};
    }
    if(!best)return {text:'',attention:false};
    const text=`RESTRICTION ${formatDistanceMeters(best.ahead)}: ${best.names.slice(0,3).join(', ')}`;
    if(text!==__lastRestrictionAssistKey){__lastRestrictionAssistKey=text;log(`ROUTE_RESTRICTION active=no aheadM=${Math.round(best.ahead)} mask=${best.mask} names=${JSON.stringify(best.names)}`);}
    return {text,attention:best.ahead<=1000,ahead:best.ahead};
  }catch(_){return {text:'',attention:false};}
}

function routeWarningsForCurrentRoute(route) {
  if(!route)return '';
  try{
    const warnings=[];
    try{if(route.hasTollRoads())warnings.push('TOLL ROAD');}catch(_){}
    try{if(route.hasFerryConnections())warnings.push('FERRY');}catch(_){}
    try{
      const td=route.getTimeDistance(true);
      if(td){
        const restricted=Number(td.getRestrictedDistance());
        if(Number.isFinite(restricted)&&restricted>25)warnings.push(`RESTRICTED ${formatDistanceMeters(restricted)}`);
      }
    }catch(_){}
    const key=warnings.join('|');
    if(key!==__lastRouteWarningKey){
      __lastRouteWarningKey=key;
      log(`ROUTE_WARNINGS toll=${warnings.includes('TOLL ROAD')?'yes':'no'} ferry=${warnings.includes('FERRY')?'yes':'no'} warnings=${JSON.stringify(warnings)}`);
      if(key){__routeAssistReason=`ROUTE: ${warnings.join(' • ')}`;__routeAssistReasonUntil=Date.now()+120000;}
    }
    return key?`ROUTE: ${warnings.join(' • ')}`:'';
  }catch(_){return '';}
}


function configureNativeAlarmService(service) {
  if(!service)return false;let configured=false;
  try{service.setOverSpeedThreshold(1.39,true);configured=true;}catch(_){}
  try{service.setOverSpeedThreshold(2.78,false);configured=true;}catch(_){}
  try{service.setMonitorWithoutRoute(true);configured=true;}catch(_){}
  if(configured&&!__nativeSpeedAlarmConfigured){__nativeSpeedAlarmConfigured=true;log('NATIVE_SPEED_ALARM_CONFIG cityToleranceKmh=5 nonCityToleranceKmh=10 monitorWithoutRoute=yes duplicateCustomToast=suppressed');}
  return configured;
}
function installNativeAlarmServiceHooks() {
  if(__alarmHooksInstalled||!Java.available)return;__alarmHooksInstalled=true;
  try{Java.perform(()=>{
    try{
      const A=Java.use('com.magiclane.sdk.core.AlarmService');let count=0;
      if(A.produce&&A.produce.overloads){for(const ov of A.produce.overloads){const orig=ov;ov.implementation=function(){const out=orig.call(this,...arguments);try{configureNativeAlarmService(out);}catch(_){}return out;};__alarmHookKeepAlive.push(ov);count++;}}
      try{Java.choose('com.magiclane.sdk.core.AlarmService',{onMatch(instance){try{configureNativeAlarmService(instance);}catch(_){}},onComplete(){}});}catch(_){}
      log(`NATIVE_SPEED_ALARM_HOOK_READY produceOverloads=${count} existingInstances=probed-once`);
    }catch(e){log(`NATIVE_SPEED_ALARM_HOOK_FAILED ${String(e)}`);}
  });}catch(e){log(`NATIVE_SPEED_ALARM_HOOK_FAILED ${String(e)}`);}
}

function objectNativeKey(obj){
  if(!obj)return '';
  try{if(obj.address&&obj.address.value!==undefined)return String(obj.address.value);}catch(_){}
  try{if(obj.$h!==undefined)return String(obj.$h);}catch(_){}
  try{return `${obj.$className||'obj'}:${String(obj)}`;}catch(_){return '';}
}
function isGemSuccess(v){const n=Number(v);if(Number.isFinite(n))return n===0;const s=String(v||'').toLowerCase();return s.includes('noerror')||s.includes('success');}
function cancelCapturedNavigation(cap){
  if(!cap||!cap.service)return false;try{const f=cap.service.cancelNavigation,ovs=f&&f.overloads?f.overloads:[];for(const ov of ovs){const t=(ov.argumentTypes||[]).map(x=>String(x.className||x.name||x));try{if(t.length===1&&/NavigationListener/.test(t[0])){ov.call(cap.service,cap.listener);return true;}if(t.length===0){ov.call(cap.service);return true;}}catch(_){}}}catch(_){}return false;
}
function startCapturedRoute(cap,route){
  if(!cap||!cap.service||!route)return {ok:false,result:'no-session'};
  try{
    const f=cap.service.startNavigationWithRoute,ovs=f&&f.overloads?f.overloads:[];
    for(const ov of ovs){
      const types=(ov.argumentTypes||[]).map(x=>String(x.className||x.name||x));
      if(!types.some(x=>/Route$/.test(x))||!types.some(x=>/NavigationListener/.test(x)))continue;
      const args=[];let supported=true;
      for(const t of types){
        if(/Route$/.test(t))args.push(route);
        else if(/NavigationListener/.test(t))args.push(cap.listener);
        else if(/ProgressListener/.test(t))args.push(cap.progress||null);
        else if(/DataSource/.test(t))args.push(cap.positionSource||null);
        else {supported=false;break;}
      }
      if(!supported)continue;
      try{const rc=ov.call(cap.service,...args);return {ok:isGemSuccess(rc),result:String(rc),signature:types.join(',')};}catch(_){}
    }
  }catch(e){return {ok:false,result:String(e)};}
  return {ok:false,result:'no-compatible-overload'};
}
function scheduleBetterRouteAutoSwitch(route,travelTime,delay,timeGain,listenerObj){
  const gain=Number(timeGain);if(!route||!Number.isFinite(gain)||gain<=0)return;
  const now=Date.now();
  const trafficLevel=now<__trafficSeverityUntil?Math.max(1,__trafficSeverityLevel):1;
  const narrowActive=now<__narrowHazardUntil;
  const candidateNarrow=strongNarrowEvidenceOnRoute(route);
  if(candidateNarrow.narrow){
    __routeAssistReason='Faster route uses a narrow/path-like road • keeping current';
    __routeAssistReasonUntil=now+30000;
    log(`BETTER_ROUTE_KEEP reason=candidate-narrow type=${candidateNarrow.type} lenM=${Math.round(candidateNarrow.lengthM)} timeGainS=${Math.round(gain)}`);
    return;
  }
  // If the current route is being escaped specifically because of strong narrow-road
  // evidence but the candidate has no terrain metadata, never blind auto-switch. The
  // original Magic Earth callback already ran, so stock UI can still offer it to the user.
  if(narrowActive&&!candidateNarrow.known){
    __routeAssistReason=`Faster route available • narrow-road quality unverified • saves ${Math.max(1,Math.round(gain/60))} min`;
    __routeAssistReasonUntil=now+30000;
    log(`BETTER_ROUTE_SUGGEST timeGainS=${Math.round(gain)} trafficLevel=${trafficLevel} narrow=yes candidateNarrow=unknown action=stock-suggestion`);
    return;
  }
  let autoThresholdS=300; // quiet normal-driving default: only auto-switch on a major gain.
  if(trafficLevel>=3)autoThresholdS=120;
  else if(trafficLevel===2&&narrowActive)autoThresholdS=90;
  else if(trafficLevel===2)autoThresholdS=180;
  else if(narrowActive)autoThresholdS=120;
  const suggestThresholdS=(trafficLevel>=2||narrowActive)?60:120;
  if(gain<suggestThresholdS)return;
  const generation=++__betterRouteGeneration;
  const eventKey=`${objectNativeKey(route)}:${Math.round(gain/30)}`;
  if(eventKey===__lastBetterRouteEventKey&&now-__lastBetterRouteEventAt<5000)return;__lastBetterRouteEventKey=eventKey;__lastBetterRouteEventAt=now;
  if(gain<autoThresholdS){
    __routeAssistReason=`Faster Magic Earth route available • saves ${Math.max(1,Math.round(gain/60))} min`;
    __routeAssistReasonUntil=now+30000;
    if(now-__lastBetterRouteSuggestionAt>30000){__lastBetterRouteSuggestionAt=now;log(`BETTER_ROUTE_SUGGEST timeGainS=${Math.round(gain)} trafficLevel=${trafficLevel} narrow=${narrowActive?'yes':'no'} autoThresholdS=${autoThresholdS} action=stock-suggestion`);}
    return; // original Magic Earth callback already ran; let stock UI/user choice own this tier.
  }
  if(now-__betterRouteSwitchAt<180000){log(`BETTER_ROUTE_KEEP reason=cooldown timeGainS=${Math.round(gain)}`);return;}
  const proposed=Java.retain(route);const listener=listenerObj?Java.retain(listenerObj):null;
  log(`BETTER_ROUTE_DETECTED travelTimeS=${Math.round(Number(travelTime)||0)} delayS=${Math.round(Number(delay)||0)} timeGainS=${Math.round(gain)} trafficLevel=${trafficLevel} narrow=${narrowActive?'yes':'no'} autoThresholdS=${autoThresholdS} action=auto-switch-pending`);
  setTimeout(()=>{try{Java.perform(()=>{
    if(generation!==__betterRouteGeneration){log('BETTER_ROUTE_KEEP reason=invalidated-before-switch');return;}
    const cap=__capturedNavigation;if(!cap||!cap.service||!cap.listener){log('BETTER_ROUTE_KEEP reason=no-captured-navigation-session');return;}
    if(listener&&objectNativeKey(cap.listener)!==objectNativeKey(listener)){log('BETTER_ROUTE_KEEP reason=listener-mismatch');return;}
    const active=routeServiceActive(cap.service,cap.listener);
    if(!active){log('BETTER_ROUTE_KEEP reason=navigation-inactive');return;}
    let current=null;try{current=cap.service.getNavigationRoute(cap.listener);}catch(_){try{current=cap.service.getNavigationRoute();}catch(__){}}
    if(current&&objectNativeKey(current)===objectNativeKey(proposed)){log('BETTER_ROUTE_ALREADY_APPLIED source=stock-app');return;}
    const previous=current?Java.retain(current):null;
    if(!cancelCapturedNavigation(cap)){log('BETTER_ROUTE_SWITCH_FAILED reason=cancel-unavailable');return;}
    const r=startCapturedRoute(cap,proposed);
    if(r.ok){__betterRouteSwitchAt=Date.now();__routeAssistReason=`Faster Magic Earth route • saves ${Math.max(1,Math.round(gain/60))} min`;__routeAssistReasonUntil=Date.now()+120000;log(`BETTER_ROUTE_AUTO_SWITCH result=${r.result} signature=${r.signature||''} timeGainS=${Math.round(gain)} trafficLevel=${trafficLevel} narrow=${narrowActive?'yes':'no'}`);toastMessage(`Faster route applied — saves ${Math.max(1,Math.round(gain/60))} min`);}
    else{
      log(`BETTER_ROUTE_SWITCH_FAILED result=${r.result} rollback=${previous?'attempt':'none'}`);
      if(previous){const rb=startCapturedRoute(cap,previous);log(`BETTER_ROUTE_ROLLBACK ok=${rb.ok?'yes':'no'} result=${rb.result}`);}
    }
  });}catch(e){log(`BETTER_ROUTE_SWITCH_ERROR ${String(e)}`);}},40);
}

function wakeNavigationAssist(delayMs=60){
  if(!__navTickFn||__navTickRunning)return;
  try{if(__navPollTimer)clearTimeout(__navPollTimer);}catch(_){}
  __navPollTimer=setTimeout(__navTickFn,Math.max(20,Number(delayMs)||60));
}

function installConcreteBetterRouteHook(listener){
  if(!listener)return;let name='';try{name=String(listener.$className||listener.getClass().getName());}catch(_){return;}if(!name||__hookedNavigationListenerClasses.has(name))return;
  try{
    const L=Java.use(name);let better=0,wake=0;
    const m=L.onBetterRouteDetected;
    if(m&&m.overloads)for(const ov of m.overloads){if((ov.argumentTypes||[]).length!==4)continue;const orig=ov;ov.implementation=function(route,travelTime,delay,timeGain){const ret=orig.call(this,route,travelTime,delay,timeGain);try{scheduleBetterRouteAutoSwitch(route,travelTime,delay,timeGain,this);}catch(_){}wakeNavigationAssist(40);return ret;};better++;}
    for(const methodName of ['onNavigationInstructionUpdated','onDestinationReached','onNavigationStarted']){
      const fn=L[methodName];if(!fn||!fn.overloads)continue;
      for(const ov of fn.overloads){const orig=ov;ov.implementation=function(){const ret=orig.call(this,...arguments);if(methodName==='onNavigationStarted'){const cap=__capturedNavigation;const sim=routeServiceSimulationActive(cap&&cap.service,cap&&cap.listener);log(`NAV_SESSION_STARTED mode=${sim?'simulation':'navigation'} algorithmMode=${ROUTE_ALGO_EXPERIMENT_MODE||'stock'}`);}wakeNavigationAssist(40);return ret;};wake++;}
    }
    // Exact-target fallback timer: 1.9.0 exposes navigation status and onRouteUpdated.
    // WaitingRoute -> route update/running measures driver-visible recompute latency even
    // if the optional route-calculation callbacks are absent from this Java wrapper.
    let statusTiming=0;
    for(const methodName of ['onNotifyStatusChange','onNavigationStatusChanged']){
      const fn=L[methodName];if(!fn||!fn.overloads)continue;
      for(const ov of fn.overloads){const orig=ov;ov.implementation=function(){const args=[...arguments];const ret=orig.call(this,...args);try{const st=String(args[0]||'');if(/WaitingRoute/i.test(st))markRouteRecomputeStart(`status:${st}`);else if(/Running/i.test(st)&&__routeRecomputeInFlight)markRouteRecomputeDone(`status:${st}`);}catch(_){}wakeNavigationAssist(40);return ret;};statusTiming++;wake++;}
    }
    let invalidated=0,recalc=0,updated=0;
    const inv=L.onBetterRouteInvalidated;if(inv&&inv.overloads)for(const ov of inv.overloads){const orig=ov;ov.implementation=function(){const ret=orig.call(this,...arguments);__betterRouteGeneration++;log('BETTER_ROUTE_INVALIDATED pending-switch-cancelled=yes');return ret;};invalidated++;}
    const rs=L.onRouteCalculationStarted;if(rs&&rs.overloads)for(const ov of rs.overloads){const orig=ov;ov.implementation=function(){const ret=orig.call(this,...arguments);markRouteRecomputeStart('callback:onRouteCalculationStarted');return ret;};recalc++;}
    const rc=L.onRouteCalculationCompleted;if(rc&&rc.overloads)for(const ov of rc.overloads){const orig=ov;ov.implementation=function(){const ret=orig.call(this,...arguments);markRouteRecomputeDone('callback:onRouteCalculationCompleted');return ret;};recalc++;}
    const ru=L.onRouteUpdated;if(ru&&ru.overloads)for(const ov of ru.overloads){const orig=ov;ov.implementation=function(){const ret=orig.call(this,...arguments);if(__routeRecomputeInFlight||__routeCalculationStartedAt)markRouteRecomputeDone('callback:onRouteUpdated');try{logBenchmarkRouteResult(currentCapturedRoute(),'after','callback:onRouteUpdated');}catch(_){}log(`ROUTE_UPDATED count=${__routeCalculationCount}`);wakeNavigationAssist(20);return ret;};updated++;}
    if(better||wake||invalidated||recalc||updated||statusTiming){__hookedNavigationListenerClasses.add(name);log(`NAVIGATION_LISTENER_HOOK class=${name} betterRouteOverloads=${better} invalidatedOverloads=${invalidated} recomputeTimingOverloads=${recalc} statusTimingOverloads=${statusTiming} routeUpdatedOverloads=${updated} immediateUiWakeOverloads=${wake}`);}
  }catch(e){log(`BETTER_ROUTE_LISTENER_HOOK_FAILED class=${name} ${String(e)}`);}
}
function captureNavigationSession(service,args){
  try{
    let listener=null,progress=null,positionSource=null;
    for(const a of args||[]){if(!a)continue;let n='';try{n=String(a.$className||a.getClass().getName());}catch(_){}if(/NavigationListener/.test(n))listener=a;else if(/ProgressListener/.test(n))progress=a;else if(/DataSource/.test(n))positionSource=a;}
    if(!listener)return;
    __capturedNavigation={service:Java.retain(service),listener:Java.retain(listener),progress:progress?Java.retain(progress):null,positionSource:positionSource?Java.retain(positionSource):null,at:Date.now()};
    // Use the app's actual NavigationService instance for simulation state, roadblocks
    // and recompute timing instead of relying on a separately-constructed wrapper.
    try{__navServiceKeepAlive=Java.retain(service);}catch(_){}
    installConcreteBetterRouteHook(listener);
    log(`NAV_SESSION_CAPTURED listener=${String(listener.$className||'unknown')} progress=${progress?'yes':'no'} positionSource=${positionSource?'yes':'no'}`);
  }catch(e){log(`NAV_SESSION_CAPTURE_ERROR ${String(e)}`);}
}

function javaObjectClassName(obj){
  if(obj===null||obj===undefined)return '';
  try{return String(obj.$className||obj.getClass().getName()||'');}catch(_){return '';}
}
function findOriginalArg(args,re){
  for(const a of args||[]){const n=javaObjectClassName(a);if(re.test(n))return a;}
  return null;
}
function simulationSpeedMultiplier(service){
  let desired=Number.isFinite(SIMULATION_SPEED_REQUEST)&&SIMULATION_SPEED_REQUEST>0?SIMULATION_SPEED_REQUEST:4.0;
  let min=0.1,max=16;
  try{if(typeof service.getSimulationMinSpeedMultiplier==='function')min=Number(service.getSimulationMinSpeedMultiplier());}catch(_){}
  try{if(typeof service.getSimulationMaxSpeedMultiplier==='function')max=Number(service.getSimulationMaxSpeedMultiplier());}catch(_){}
  if(!Number.isFinite(min)||min<=0)min=0.1;if(!Number.isFinite(max)||max<min)max=Math.max(min,16);
  return Math.max(min,Math.min(max,desired));
}
function blockedJavaReturn(overload){
  let t='';try{t=String(overload.returnType&& (overload.returnType.className||overload.returnType.name)||'');}catch(_){}
  if(/boolean/i.test(t))return false;
  if(/void/i.test(t))return undefined;
  if(/float|double/i.test(t))return 0.0;
  if(/byte|short|int|long/i.test(t))return 1;
  return null;
}
function invokeSimulationEquivalent(service,fromMethod,originalOverload,args){
  if(!SIMULATION_TEST_ENABLED)return {handled:false,result:null};
  const route=findOriginalArg(args,/\.Route$/);
  const waypoints=findOriginalArg(args,/java\.util\.(ArrayList|List)|CoordinatesList|LandmarkList/);
  const listener=findOriginalArg(args,/NavigationListener/);
  const progress=findOriginalArg(args,/ProgressListener/);
  const speed=simulationSpeedMultiplier(service);
  const methods=route?['startSimulationWithRoute','startSimulation']:['startSimulation','startSimulationWithRoute'];
  const attempted=[];
  for(const targetName of methods){
    let f=null;try{f=service[targetName];}catch(_){}if(!f||!f.overloads)continue;
    for(const ov of f.overloads){
      const types=(ov.argumentTypes||[]).map(x=>String(x.className||x.name||x));
      attempted.push(`${targetName}(${types.join(',')})`);
      const mapped=[];let compatible=true;
      for(const t of types){
        if(/\.Route$/.test(t)){if(route)mapped.push(route);else{compatible=false;break;}}
        else if(/java\.util\.(ArrayList|List)/.test(t)){if(waypoints)mapped.push(waypoints);else{compatible=false;break;}}
        else if(/NavigationListener/.test(t)){if(listener)mapped.push(listener);else{compatible=false;break;}}
        else if(/ProgressListener/.test(t))mapped.push(progress||null);
        else if(/float|double/.test(t))mapped.push(speed);
        else {compatible=false;break;}
      }
      if(!compatible)continue;
      try{
        captureNavigationSession(service,args);
        const rc=ov.call(service,...mapped);
        log(`SIMULATION_REWRITE_APPLIED from=${fromMethod} to=${targetName} signature=${types.join(',')} speedMultiplier=${speed.toFixed(2)} result=${String(rc)} algorithmMode=${ROUTE_ALGO_EXPERIMENT_MODE||'stock'}`);
        return {handled:true,result:rc};
      }catch(e){log(`SIMULATION_REWRITE_OVERLOAD_ERROR from=${fromMethod} to=${targetName} signature=${types.join(',')} error=${String(e).slice(0,180)}`);}
    }
  }
  // Test mode is intentionally no-drive. If no simulation overload can be invoked,
  // refuse to fall through to real GPS navigation.
  log(`SIMULATION_REWRITE_BLOCKED from=${fromMethod} reason=no-compatible-overload attempted=${attempted.join('|').slice(0,1000)}`);
  return {handled:true,result:blockedJavaReturn(originalOverload)};
}
function currentCapturedRoute(){
  const cap=__capturedNavigation;const service=(cap&&cap.service)||__navServiceKeepAlive;if(!service)return null;
  try{if(cap&&cap.listener)return service.getNavigationRoute(cap.listener);}catch(_){}
  try{return service.getNavigationRoute(null);}catch(_){}
  try{return service.getNavigationRoute();}catch(_){}
  return null;
}
function routeBenchMetrics(route){
  if(!route)return null;
  let td=null;try{td=route.getTimeDistance(false);}catch(_){}if(!td)return null;
  let distanceM=NaN,etaS=NaN;try{distanceM=Number(td.getTotalDistance());}catch(_){}try{etaS=Number(td.getTotalTime());}catch(_){}
  const narrow=strongNarrowEvidenceOnRoute(route);
  return {distanceM,etaS,narrowKnown:!!narrow.known,narrow:!!narrow.narrow,narrowType:narrow.type||'',narrowLengthM:Number(narrow.lengthM)||0};
}
function logBenchmarkRouteResult(route,phase,source=''){
  if(!SIMULATION_TEST_ENABLED||!__benchmarkPending)return;
  const m=routeBenchMetrics(route);if(!m)return;
  const token=String(__benchmarkPending.token||'');
  log(`ROUTE_BENCH_RESULT token=${token} phase=${phase} algorithm=${__benchmarkPending.algorithm} distanceM=${Number.isFinite(m.distanceM)?Math.round(m.distanceM):-1} etaS=${Number.isFinite(m.etaS)?Math.round(m.etaS):-1} narrowKnown=${m.narrowKnown?'yes':'no'} narrow=${m.narrow?'yes':'no'} narrowType=${m.narrowType||'none'} narrowLenM=${Math.round(m.narrowLengthM)} source=${source||'unknown'}`);
  if(phase==='after')__benchmarkPending=null;
}
function deleteControlFile(path){
  try{const F=Java.use('java.io.File');F.$new(path).delete();}catch(_){try{File.writeAllText(path,'');}catch(__){}}
}
function consumeBenchmarkRoadblockControl(route){
  if(!SIMULATION_TEST_ENABLED||!route)return;
  const now=Date.now();if(now-__lastBenchmarkControlPollAt<200)return;__lastBenchmarkControlPollAt=now;
  const raw=readStagedSecret(BENCHMARK_ROADBLOCK_PATH);if(!raw)return;
  let spec=null;try{spec=JSON.parse(raw);}catch(_){spec={token:raw,startAheadM:500,lengthM:180};}
  const token=String(spec&&spec.token||'').trim();if(!token||token===__benchmarkLastControlToken)return;
  __benchmarkLastControlToken=token;deleteControlFile(BENCHMARK_ROADBLOCK_PATH);
  const startAheadM=Math.max(80,Math.min(2500,Math.round(Number(spec.startAheadM)||500)));
  const lengthM=Math.max(60,Math.min(1200,Math.round(Number(spec.lengthM)||180)));
  const m=routeBenchMetrics(route);
  if(m&&Number.isFinite(m.distanceM)&&m.distanceM<startAheadM+lengthM+250){
    log(`ROUTE_BENCH_TRIGGER_SKIPPED token=${token} reason=route-too-short distanceM=${Math.round(m.distanceM)} startAheadM=${startAheadM} lengthM=${lengthM}`);return;
  }
  __benchmarkPending={token,algorithm:ROUTE_ALGO_EXPERIMENT_MODE==='externalch-reroute'||ROUTE_ALGO_EXPERIMENT_MODE==='externalch-all'?'ExternalCh':'MagicEarth',startedAt:now,startAheadM,lengthM};
  logBenchmarkRouteResult(route,'before','benchmark-control');
  const ok=invokeNavigationRoadBlock(lengthM,startAheadM,`benchmark:${token}`);
  log(`ROUTE_BENCH_TRIGGER token=${token} algorithm=${__benchmarkPending.algorithm} startAheadM=${startAheadM} lengthM=${lengthM} applied=${ok?'yes':'no'} simulation=${routeServiceSimulationActive((__capturedNavigation&&__capturedNavigation.service)||__navServiceKeepAlive,(__capturedNavigation&&__capturedNavigation.listener)||null)?'yes':'no'}`);
  if(!ok)__benchmarkPending=null;
}
function installBetterRouteAutoSwitchHooks(){
  if(__betterRouteHooksInstalled||!Java.available)return;__betterRouteHooksInstalled=true;
  try{Java.perform(()=>{
    try{
      const NS=Java.use('com.magiclane.sdk.routesandnavigation.NavigationService');let count=0;
      for(const methodName of ['startNavigation','startNavigationWithRoute']){
        const m=NS[methodName];if(!m||!m.overloads)continue;
        for(const ov of m.overloads){const orig=ov;ov.implementation=function(){const args=[...arguments];
          if(SIMULATION_TEST_ENABLED){const sim=invokeSimulationEquivalent(this,methodName,orig,args);if(sim.handled)return sim.result;}
          const ret=orig.call(this,...args);try{captureNavigationSession(this,args);}catch(_){}return ret;};count++;}
      }
      // Base-class fallback; concrete listener hooking above is preferred.
      try{const NL=Java.use('com.magiclane.sdk.routesandnavigation.NavigationListener');if(NL.onBetterRouteDetected&&NL.onBetterRouteDetected.overloads)for(const ov of NL.onBetterRouteDetected.overloads){if((ov.argumentTypes||[]).length!==4)continue;ov.implementation=function(route,travelTime,delay,timeGain){const ret=ov.call(this,route,travelTime,delay,timeGain);try{scheduleBetterRouteAutoSwitch(route,travelTime,delay,timeGain,this);}catch(_){}return ret;};}}catch(_){}
      log(`BETTER_ROUTE_AUTO_SWITCH_READY navigationStartHooks=${count} minGainS=300 cooldownS=180 rollback=yes simulationRewrite=${SIMULATION_TEST_ENABLED?'armed':'off'}`);
    }catch(e){log(`BETTER_ROUTE_HOOK_INIT_FAILED ${String(e)}`);}
  });}catch(e){log(`BETTER_ROUTE_HOOK_INIT_FAILED ${String(e)}`);}
}

function startNativeLaneAssist() {
  if (!Java.available || __navPollTimer) return;
  installForegroundActivityTracker();
  installNativeAlarmServiceHooks();
  log('STOCK_ALARMS_RESPECTED mode=unchanged-by-cairodrive');
  installBetterRouteAutoSwitchHooks();
  try {
    Java.perform(() => {
      const NS = Java.use('com.magiclane.sdk.routesandnavigation.NavigationService');
      __navServiceKeepAlive = Java.retain(NS.$new());
      if (!__navBannerClass) __navBannerClass = Java.use('com.cairodrive.nav.NavBanner');
      __laneColors = {
        background: makeRgba(32,32,32,255),
        active: makeRgba(255,193,7,255),
        inactive: makeRgba(135,135,135,255)
      };
      log('LANE_ASSIST_READY source=MagicLane-NavigationInstruction scheduler=event-wake+adaptive-1s-active-3s-idle overlay=compact-supplemental stock-nav-ui=authoritative speedLimit=current+upcoming+native-alarm trafficEvents=yes routeWarnings=toll+ferry+restricted liveRestrictions=yes navStatus=return-to-route+gps+reroute roadShield=yes etaRttRtd=yes roundaboutExit=yes nextWaypointEtaSide=yes betterRouteAutoSwitch=hooked-if-exposed controls=report+media-pause+repeat trace=always-on-local');
    });
  } catch (e) { log(`LANE_ASSIST_INIT_ERROR ${String(e)}`); return; }

  const tick=()=>{
    __navTickRunning=true;
    let nextMs=3000;
    if (!Java.available || !__navServiceKeepAlive || !__navBannerClass){__navTickRunning=false;__navPollTimer=setTimeout(tick,nextMs);return;}
    try {
      Java.perform(() => {
        const active=routeServiceActive(__navServiceKeepAlive);
        consumeDriveControlActions();
        if(!active){
          traceLocationAndSystem(null,false);
          if(__lastNavBannerKey){try{__navBannerClass.hide();}catch(_){}__lastNavBannerKey='';log('LANE_ASSIST_HIDE reason=inactive');}
          return;
        }
        nextMs=1000;
        let ni=null;try{ni=__navServiceKeepAlive.getNavigationInstruction(null);}catch(_){try{ni=__navServiceKeepAlive.getNavigationInstruction();}catch(__){}}
        traceLocationAndSystem(ni,true);
        let route=null;try{route=__navServiceKeepAlive.getNavigationRoute(null);}catch(_){try{route=__navServiceKeepAlive.getNavigationRoute();}catch(__){}}
        if(route)consumeBenchmarkRoadblockControl(route);
        analyzeUpcomingComfortRoute(route);
        maybeScheduleGoogleTraffic(route);
        const nativeTraffic=nativeTrafficEventAhead(route);
        routeWarningsForCurrentRoute(route);
        if(!ni)return;
        const speedAssist=speedAssistForInstruction(ni);
        const navStatus=navigationStatusAssist(ni);
        const restrictions=restrictionAssist(ni,route);
        const waypoint=nextWaypointSummary(ni,route);
        let has=true;try{has=!!ni.hasNextTurnInfo();}catch(_){}
        if(!has&&!waypoint&&!(speedAssist&&(speedAssist.over||speedAssist.next))&&!nativeTraffic&&!(navStatus&&navStatus.attention)&&!(restrictions&&restrictions.attention)){try{__navBannerClass.hide();}catch(_){}__lastNavBannerKey='';return;}

        let instruction='',nextStreet='',signpost='',eventName='',distance=-1;
        try{instruction=String(ni.getNextTurnInstruction()||'').trim();}catch(_){}
        try{nextStreet=String(ni.getNextStreetName()||'').trim();}catch(_){}
        try{signpost=String(ni.getSignpostInstruction()||'').trim();}catch(_){}
        try{const td=ni.getTimeDistanceToNextTurn();if(td)distance=Number(td.getTotalDistance());}catch(_){}
        try{const turn=ni.getNextTurnDetails();if(turn){const ev=turn.getEvent();if(ev)eventName=String(ev.toString());}}catch(_){}
        const roadCode=roadCodeText(roadInfoList(ni,'next'));
        const nextNext=nextNextTurnSummary(ni);
        const progress=routeProgressSummary(ni,route);
        const exitNo=roundaboutExitNumber(ni);

        const b=has?eventToBanner(eventName,instruction):{title:(waypoint&&waypoint.startsWith('NEXT STOP'))?'NEXT STOP':'ARRIVING',importance:2};
        if(exitNo>0&&/ROUNDABOUT/.test(b.title))b.title=`ROUNDABOUT — TAKE EXIT ${exitNo}`;
        const arrival=arrivalStatusForCurrentRoute(route);
        const routeAssistActive=Date.now()<__routeAssistReasonUntil&&!!__routeAssistReason;
        const forceAssist=!!waypoint||!!arrival||routeAssistActive||!!(speedAssist&&(speedAssist.over||(speedAssist.next&&speedAssist.next.distanceM<=500)))||(nativeTraffic&&nativeTraffic.ahead<=5000)||!!(navStatus&&navStatus.attention)||!!(restrictions&&restrictions.attention);
        // KISS default: Magic Earth's own navigation UI owns ordinary turns, lanes,
        // signposts and ETA. CairoDrive only overlays information it uniquely adds.
        if(!FULL_NAV_OVERLAY&&!forceAssist){if(__lastNavBannerKey){try{__navBannerClass.hide();}catch(_){}__lastNavBannerKey='';}return;}
        if(FULL_NAV_OVERLAY&&!shouldShowBanner(distance,b.importance)&&!forceAssist){if(__lastNavBannerKey){try{__navBannerClass.hide();}catch(_){}__lastNavBannerKey='';}return;}
        const dist=formatDistanceMeters(distance);
        let roadLabel=nextStreet||roadCode||signpost;
        if(nextStreet&&roadCode&&!nextStreet.toLowerCase().includes(roadCode.toLowerCase()))roadLabel=`${nextStreet} (${roadCode})`;
        let secondary=[dist,roadLabel,speedAssist&&speedAssist.text||'',progress].filter(Boolean).join('  •  ');
        let tertiary='';
        if(signpost&&signpost!==nextStreet)tertiary=signpost;
        else if(instruction&&instruction.toUpperCase()!==b.title)tertiary=instruction;
        if(nextNext)tertiary=`${tertiary?tertiary+'   •   ':''}${nextNext}`;
        if(waypoint)tertiary=`${waypoint}${tertiary?'   •   '+tertiary:''}`;
        if(nativeTraffic&&nativeTraffic.text)tertiary=`${nativeTraffic.text}${tertiary?'   •   '+tertiary:''}`;
        if(navStatus&&navStatus.text)tertiary=`${navStatus.text}${tertiary?'   •   '+tertiary:''}`;
        if(restrictions&&restrictions.text)tertiary=`${restrictions.text}${tertiary?'   •   '+tertiary:''}`;
        if(arrival)tertiary=`${arrival}${tertiary?'   •   '+tertiary:''}`;
        if(routeAssistActive)tertiary=`${__routeAssistReason}${tertiary?'   •   '+tertiary:''}`;
        const importance=Math.max(b.importance,speedAssist&&speedAssist.over?3:0,nativeTraffic&&nativeTraffic.delay>=180?3:0,navStatus&&navStatus.attention?3:0,restrictions&&restrictions.attention?3:0);
        let title=b.title,laneInfo={lane:null,uid:''},maneuverInfo={kind:'none',uid:''},laneBitmap=null,maneuverBitmap=null;
        if(!FULL_NAV_OVERLAY){
          const alerts=[restrictions&&restrictions.text,navStatus&&navStatus.text,routeAssistActive?__routeAssistReason:'',nativeTraffic&&nativeTraffic.text,waypoint,speedAssist&&speedAssist.text,arrival].filter(Boolean);
          title=String(alerts.shift()||'CAIRODRIVE');
          tertiary=alerts.join('   •   ');
          secondary=[progress,roadLabel].filter(Boolean).join('  •  ');
        }else{
          laneInfo=inspectNativeLane(ni); maneuverInfo=inspectNativeManeuver(ni);
          laneBitmap=renderNativeLaneBitmap(laneInfo.lane); maneuverBitmap=renderNativeManeuverBitmap(maneuverInfo);
        }
        const key=`${title}|${secondary}|${tertiary}|${Math.round(Number(distance)||-1)/50|0}|${laneInfo.uid}|${maneuverInfo.uid}|${importance}`;
        if(key!==__lastNavBannerKey){
          __lastNavBannerKey=key;
          __navBannerClass.show(title,secondary,tertiary,importance,laneBitmap,maneuverBitmap);
          log(`DRIVE_ASSIST_SHOW mode=${FULL_NAV_OVERLAY?'full':'supplemental'} event=${eventName||'unknown'} distance=${Number.isFinite(distance)?Math.round(distance):-1} alert=${JSON.stringify(title).slice(0,140)}`);
        }
      });
    } catch (e) { log(`LANE_ASSIST_TICK_ERROR ${String(e)}`); }
    __navTickRunning=false;
    __navPollTimer=setTimeout(tick,nextMs);
  };
  __navTickFn=tick;
  __navPollTimer=setTimeout(tick,250);
}

let __nativeFilterModule=null;
function nativeLibraryDirs(hintModule) {
  const dirs=[];
  const add=m=>{if(!m||!m.path)return;const p=String(m.path),i=p.lastIndexOf('/');if(i>0){const d=p.slice(0,i);if(!dirs.includes(d))dirs.push(d);}};
  add(hintModule);
  for(const name of ['libGEM.so','libflutter.so','libapp.so']){try{add(Process.findModuleByName(name));}catch(_){}}
  return dirs;
}
function ensureNativeFilterLoaded(hintModule) {
  if(__nativeFilterModule)return __nativeFilterModule;
  const existing=Process.findModuleByName('libcairodrive_filter.so');
  if(existing){__nativeFilterModule=existing;return existing;}
  for(const dir of nativeLibraryDirs(hintModule)) {
    try {
      const m=Module.load(`${dir}/libcairodrive_filter.so`);
      m.getExportByName('cd_native_call_filter');m.getExportByName('cd_set_search_handler');m.getExportByName('cd_set_route_handler');m.getExportByName('cd_set_original');
      __nativeFilterModule=m; return m;
    } catch(_){}
  }
  return null;
}

function installGem(m) {
  if(gem)return;
  gem=m;
  const nativeCallAddr=m.getExportByName('native_call');
  nativeCreate=new NativeFunction(m.getExportByName('native_call_createObject'),'pointer',['pointer','int64']);
  const setPortAddr=m.getExportByName('set_dart_port');
  __setDartPortAddr=setPortAddr;
  const libc=Process.getModuleByName('libc.so');
  libcFree=new NativeFunction(libc.getExportByName('free'),'void',['pointer']);
  libcStrdup=new NativeFunction(libc.getExportByName('strdup'),'pointer',['pointer']);

  try { Interceptor.attach(setPortAddr,{onEnter(args){dartPort=int64(args[0].toString());try{resolveDartPortAndPoster();}catch(_){}}}); }
  catch(e){log(`SET_PORT_HOOK_ERROR ${String(e)}`);}
  resolveDartPortAndPoster();

  const searchHandler=new NativeCallback(function(requestPtr,requestLen){
    try {
      const len=Number(requestLen);
      const raw=requestPtr.readUtf8String(len>0&&len<1024*1024?len:undefined);
      const h=handleGemDispatch(raw);
      if(h&&h.handled)return libcStrdup(Memory.allocUtf8String('{"result":0}'));
    } catch(e){log(`SEARCH_HANDLER_ERROR ${String(e)}`);}
    return nativeCallOriginal(requestPtr,requestLen);
  },'pointer',['pointer','int64']);

  const routeHandler=new NativeCallback(function(requestPtr,requestLen){
    try {
      const len=Number(requestLen);
      const raw=requestPtr.readUtf8String(len>0&&len<1024*1024?len:undefined);
      const rewritten=patchRouteRaw(raw);
      if(rewritten){
        const p=Memory.allocUtf8String(rewritten);
        return nativeCallOriginal(p,utf8Length(rewritten));
      }
    } catch(e){log(`NAV_ROUTE_HANDLER_ERROR ${String(e)}`);}
    return nativeCallOriginal(requestPtr,requestLen);
  },'pointer',['pointer','int64']);

  let armed=false;
  try {
    const fm=ensureNativeFilterLoaded(m);
    if(fm) {
      const filterPtr=fm.getExportByName('cd_native_call_filter');
      const setHandler=new NativeFunction(fm.getExportByName('cd_set_search_handler'),'void',['pointer']);
      const setRouteHandler=new NativeFunction(fm.getExportByName('cd_set_route_handler'),'void',['pointer']);
      const setOriginal=new NativeFunction(fm.getExportByName('cd_set_original'),'void',['pointer']);
      setHandler(searchHandler);
      setRouteHandler(routeHandler);
      const originalPtr=Interceptor.replaceFast(nativeCallAddr,filterPtr);
      nativeCallOriginal=new NativeFunction(originalPtr,'pointer',['pointer','int64']);
      setOriginal(originalPtr);
      replacementKeepAlive={fm,searchHandler,routeHandler,setHandler,setRouteHandler,setOriginal};
      armed=true;
      log('GEM_FILTER_ARMED scope=search+route-preferences');
    }
  } catch(e){log(`GEM_FILTER_ERROR ${String(e)}`);}

  if(!armed) {
    replacementKeepAlive=new NativeCallback(function(requestPtr,requestLen){
      try {
        const len=Number(requestLen),raw=requestPtr.readUtf8String(len>0&&len<1024*1024?len:undefined);
        const h=handleGemDispatch(raw);
        if(h&&h.handled)return libcStrdup(Memory.allocUtf8String('{"result":0}'));
        const rewritten=patchRouteRaw(raw);
        if(rewritten){const p=Memory.allocUtf8String(rewritten);return nativeCallOriginal(p,utf8Length(rewritten));}
      }catch(e){log(`GEM_FALLBACK_ERROR ${String(e)}`);}
      return nativeCallOriginal(requestPtr,requestLen);
    },'pointer',['pointer','int64']);
    const originalPtr=Interceptor.replaceFast(nativeCallAddr,replacementKeepAlive);
    nativeCallOriginal=new NativeFunction(originalPtr,'pointer',['pointer','int64']);
    log('GEM_FILTER_FALLBACK scope=search+route-preferences');
  }
  configureMagicLaneTrafficAndEnums();
  setTimeout(()=>startNativeLaneAssist(),1200);
  log(`CAIRODRIVE_READY places=Google-Places-New-adaptive-details routing=MagicLane traffic=MagicLane-online rerouteTargetMs=1000 overlay=compact-supplemental simulationRewrite=${SIMULATION_TEST_ENABLED?'armed':'off'} routeAlgoMode=${ROUTE_ALGO_EXPERIMENT_MODE||'stock'} trace=first-test`);
}

log(`BOOT agent=${VERSION} scope=places+drive-assist googleKey=${GOOGLE_PLACES_API_KEY?'yes':'no'}`);
setTimeout(()=>{try{installForegroundActivityTracker();}catch(_){}},100);
setTimeout(()=>{migratePrivateState(true);resolveContactInfoTypes();},800);

let tries=0;
const timer=setInterval(()=>{
  tries++;
  try {
    const m=Process.findModuleByName('libGEM.so');
    if(m){clearInterval(timer);setTimeout(()=>{try{installGem(Process.findModuleByName('libGEM.so')||m);}catch(e){log(`INSTALL_GEM_ERROR ${String(e)}`);}},80);}
    else if(tries%50===0)log(`WAIT_GEM tries=${tries}`);
  }catch(e){log(`WAIT_GEM_ERROR ${String(e)}`);}
},100);
