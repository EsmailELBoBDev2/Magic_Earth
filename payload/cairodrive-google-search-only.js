/*
 * CairoDrive v23 minimal runtime.
 *
 * Stock Magic Earth remains authoritative for map/UI/place cards/Android Auto/
 * voice/navigation. CairoDrive adds only:
 *   1) Google Places typed search -> native Magic Earth result list
 *   2) Google Places category/What's Nearby -> native result list
 *   3) Google Routes traffic advisory -> Magic Lane roadblock/recompute only
 *   4) avoidUnpavedRoads + strong native Path/SingleTrack avoidance
 *
 * No custom overlays, no autocomplete panel, no place-card enrichment,
 * no simulation/A-B hooks, no speed/lane/report UI, no persistent logging,
 * no stock performance/debounce patches.
 */

import Java from 'frida-java-bridge';
import {
  FIELD_MASK, TEXT_SEARCH_URL, NEARBY_SEARCH_URL,
  normalizeQuery, shouldCallGoogle, safeBias,
  buildTextSearchBody, buildNearbySearchBody,
  googleTypesForMagicCategory, magicGenericCategoryName,
  parsePlacesResponse, classifyGoogleFailure, inferLang
} from './search-core.mjs';
import {
  ROUTES_URL, ROUTES_FIELD_MASK, buildTrafficRequest,
  parseTrafficRoutesResponse, matchMagicSamplesToTraffic,
  hasMeaningfulTrafficDelay, trafficRefreshIntervalMs, bearingDeg
} from './traffic-core.mjs';

'use strict';

const TAG='cairodrive';
const VERSION='v24.3-drive-test-ready';
const RUNTIME_TUNING='r8-drive-observability';
const GEM_DART_PORT_OFFSET=__CAIRODRIVE_GEM_DART_PORT_OFFSET__;
const GEM_POST_COBJECT_SLOT_OFFSET=__CAIRODRIVE_GEM_POST_COBJECT_SLOT_OFFSET__;
const CONNECT_TIMEOUT_MS=3500;
const SEARCH_READ_TIMEOUT_MS=3500;
const TRAFFIC_READ_TIMEOUT_MS=6500;
const CATEGORY_CONTEXT_TTL_MS=700;
const SEARCH_POLL_MS=35;
const NEARBY_POLL_MS=40;
const FAST_RETRY_DELAY_MS=250;
const GOOGLE_TYPED_DEBOUNCE_MS=180;
const GOOGLE_EMPTY_CACHE_MS=30000;
const GOOGLE_PARSE_CACHE_MS=10000;
const NAV_INITIAL_ASSIST_MS=400;
const TRAFFIC_POLL_MS=100;
// Fast native-list mask: only data needed to construct a stock Magic Earth row.
// Keeping addressComponents preserves Google's structured street_number.
const FAST_SEARCH_FIELD_MASK=[
  'places.id','places.displayName','places.formattedAddress',
  'places.addressComponents','places.location','places.businessStatus',
  'places.movedPlaceId'
].join(',');
const FAST_SEARCH_MAX_RESULTS=10;

let __androidLogWrite=null,__androidLogTag=null,__JDriveDiagnostics=null,__driveDiagnosticsStarted=false;
function persistDriveLog(s){if(!__driveDiagnosticsStarted||!__JDriveDiagnostics)return;try{Java.perform(()=>__JDriveDiagnostics.write(String(s)));}catch(_){} }
function log(s){
  try{
    if(!__androidLogWrite){
      const m=Process.findModuleByName('liblog.so')||Process.getModuleByName('liblog.so');
      __androidLogWrite=new NativeFunction(m.getExportByName('__android_log_write'),'int',['int','pointer','pointer']);
    }
    if(!__androidLogTag)__androidLogTag=Memory.allocUtf8String(TAG);
    __androidLogWrite(4,__androidLogTag,Memory.allocUtf8String(`[cairodrive-${VERSION}] ${String(s)}`));
    persistDriveLog(s);
  }catch(_){}
}
function ensureDriveDiagnostics(){
  if(__driveDiagnosticsStarted)return true;if(!Java.available)return false;
  try{Java.perform(()=>{const D=Java.use('com.cairodrive.diag.DriveDiagnostics'),AT=Java.use('android.app.ActivityThread'),app=AT.currentApplication();if(!app)return;D.start(app.getApplicationContext(),VERSION);__JDriveDiagnostics=D;__driveDiagnosticsStarted=true;});}catch(_){return false;}return __driveDiagnosticsStarted;
}

function readStagedSecret(path){try{return String(File.readAllText(path)||'').trim();}catch(_){return '';}}
let GOOGLE_PLACES_API_KEY=readStagedSecret('/data/local/tmp/gpk');
let GOOGLE_ROUTES_API_KEY=readStagedSecret('/data/local/tmp/grk');
let __privateStateLoaded=false,__privateStateAttemptedAt=0;
let ANDROID_PACKAGE='com.generalmagic.magicearth',ANDROID_CERT_SHA1='',__identityResolved=false;

function migratePrivateState(force=false){
  const now=Date.now();
  if(!force&&__privateStateLoaded)return true;
  if(!force&&now-__privateStateAttemptedAt<500)return __privateStateLoaded;
  __privateStateAttemptedAt=now;
  const staged=readStagedSecret('/data/local/tmp/gpk');
  const stagedRoutes=readStagedSecret('/data/local/tmp/grk');
  if(staged)GOOGLE_PLACES_API_KEY=staged;
  if(stagedRoutes)GOOGLE_ROUTES_API_KEY=stagedRoutes;
  if(!Java.available)return false;
  try{
    Java.perform(()=>{
      const ActivityThread=Java.use('android.app.ActivityThread');
      const app=ActivityThread.currentApplication();if(!app)return;
      const prefs=app.getSharedPreferences('cairodrive_private',0);
      const saved=String(prefs.getString('google_places_key','')||'').trim();
      const savedRoutes=String(prefs.getString('google_routes_key','')||'').trim();
      const edit=prefs.edit();
      if(staged)edit.putString('google_places_key',staged);
      if(stagedRoutes)edit.putString('google_routes_key',stagedRoutes);
      edit.apply();
      const prevPlaces=GOOGLE_PLACES_API_KEY,prevRoutes=GOOGLE_ROUTES_API_KEY;
      GOOGLE_PLACES_API_KEY=staged||saved||GOOGLE_PLACES_API_KEY;
      GOOGLE_ROUTES_API_KEY=stagedRoutes||savedRoutes||GOOGLE_ROUTES_API_KEY||GOOGLE_PLACES_API_KEY;
      try{if(GOOGLE_PLACES_API_KEY&&GOOGLE_PLACES_API_KEY!==prevPlaces)googleAuthBlocked=false;if(GOOGLE_ROUTES_API_KEY&&GOOGLE_ROUTES_API_KEY!==prevRoutes)googleRoutesAuthBlocked=false;}catch(_){}
      __privateStateLoaded=true;
      log(`KEY_STATE places=${GOOGLE_PLACES_API_KEY?'yes':'no'} routes=${GOOGLE_ROUTES_API_KEY?'yes':'no'} routesKey=${GOOGLE_ROUTES_API_KEY&&GOOGLE_ROUTES_API_KEY===GOOGLE_PLACES_API_KEY?'shared':'separate'} storage=private-prefs`);
    });
  }catch(e){log(`KEY_STATE_ERROR ${String(e)}`);}
  return __privateStateLoaded;
}

function resolveIdentity(){
  if(__identityResolved)return true;
  if(!Java.available)return false;
  try{
    Java.perform(()=>{
      const ActivityThread=Java.use('android.app.ActivityThread');
      const app=ActivityThread.currentApplication();if(!app)return;
      const ctx=app.getApplicationContext(),pm=ctx.getPackageManager(),pkg=String(ctx.getPackageName());
      const Build=Java.use('android.os.Build$VERSION');
      let certBytes;
      if(Build.SDK_INT.value>=28){
        const info=pm.getPackageInfo(pkg,0x08000000),si=info.signingInfo.value;
        const signers=si.hasMultipleSigners()?si.getApkContentsSigners():si.getSigningCertificateHistory();
        certBytes=signers[0].toByteArray();
      }else{
        certBytes=pm.getPackageInfo(pkg,64).signatures.value[0].toByteArray();
      }
      const MessageDigest=Java.use('java.security.MessageDigest');
      const digest=MessageDigest.getInstance('SHA-1').digest(certBytes);
      let hex='';for(let i=0;i<digest.length;i++)hex+=(digest[i]&0xff).toString(16).padStart(2,'0');
      ANDROID_PACKAGE=pkg;ANDROID_CERT_SHA1=hex.toUpperCase();__identityResolved=true;
      log(`IDENTITY_READY package=${ANDROID_PACKAGE} certSha1=${ANDROID_CERT_SHA1}`);
    });
  }catch(e){log(`IDENTITY_ERROR ${String(e)}`);}
  return __identityResolved&&!!ANDROID_CERT_SHA1;
}

let __networkAvailableCache=true,__networkAvailableAt=0;
function androidNetworkAvailable(force=false){
  const now=Date.now();if(!force&&now-__networkAvailableAt<2000)return __networkAvailableCache;
  let available=true;
  if(Java.available){
    try{Java.perform(()=>{
      try{
        const ActivityThread=Java.use('android.app.ActivityThread'),app=ActivityThread.currentApplication();if(!app)return;
        const CM=Java.use('android.net.ConnectivityManager'),svc=app.getApplicationContext().getSystemService('connectivity');
        if(!svc){available=false;return;}
        const cm=Java.cast(svc,CM);
        try{
          const network=cm.getActiveNetwork();if(!network){available=false;return;}
          const caps=cm.getNetworkCapabilities(network);available=!!(caps&&caps.hasCapability(12));
        }catch(_){
          try{const info=cm.getActiveNetworkInfo();available=!!(info&&info.isConnected());}catch(__){available=true;}
        }
      }catch(_){available=true;}
    });}catch(_){available=true;}
  }
  __networkAvailableCache=available;__networkAvailableAt=now;return available;
}

let __locationBiasCache=null,__locationBiasCacheAt=0;
function bestLocalLocation(ctx){
  try{
    const LM=Java.use('android.location.LocationManager'),lm=Java.cast(ctx.getSystemService('location'),LM);
    const now=Date.now();let best=null,bestScore=Infinity;
    for(const provider of ['gps','fused','network','passive']){
      try{
        const l=lm.getLastKnownLocation(provider);if(!l)continue;
        const c={provider,time:Number(l.getTime()),latitude:Number(l.getLatitude()),longitude:Number(l.getLongitude()),accuracy:Number(l.getAccuracy()),bearing:l.hasBearing()?Number(l.getBearing()):NaN,speed:l.hasSpeed()?Number(l.getSpeed()):NaN};
        const age=Math.max(0,now-c.time),acc=Number.isFinite(c.accuracy)?Math.max(0,c.accuracy):1000;if(age>180000)continue;const score=age+acc*250;
        if(score<bestScore){best=c;bestScore=score;}
      }catch(_){}
    }
    return best;
  }catch(_){return null;}
}
function getLocationBias(){
  const now=Date.now();if(__locationBiasCache&&now-__locationBiasCacheAt<20000)return __locationBiasCache;
  let best=null;
  if(Java.available){
    try{Java.perform(()=>{
      const ActivityThread=Java.use('android.app.ActivityThread'),app=ActivityThread.currentApplication();if(!app)return;
      best=bestLocalLocation(app.getApplicationContext());
    });}catch(_){}
  }
  __locationBiasCache=safeBias(best);__locationBiasCacheAt=now;return __locationBiasCache;
}

let __JAsyncHttp=null;
function ensureAsyncHttp(){
  if(__JAsyncHttp)return __JAsyncHttp;
  if(!Java.available)return null;
  try{Java.perform(()=>{__JAsyncHttp=Java.use('com.cairodrive.search.AsyncHttp');});}
  catch(e){log(`HTTP_HELPER_ERROR ${String(e)}`);__JAsyncHttp=null;}
  return __JAsyncHttp;
}
function startHttpPost(url,headers,body,traffic=false,readTimeoutMs=SEARCH_READ_TIMEOUT_MS){
  const H=ensureAsyncHttp();if(!H)return null;let token=null;
  try{Java.perform(()=>{token=String(traffic?H.startTrafficPostJson(String(url),JSON.stringify(headers),JSON.stringify(body),CONNECT_TIMEOUT_MS,readTimeoutMs):H.startPostJson(String(url),JSON.stringify(headers),JSON.stringify(body),CONNECT_TIMEOUT_MS,readTimeoutMs));});}
  catch(e){log(`HTTP_START_ERROR traffic=${traffic?'yes':'no'} ${String(e)}`);}
  return token;
}
function pollHttp(token){
  if(!token||!__JAsyncHttp)return null;let out=null;
  try{Java.perform(()=>{const r=__JAsyncHttp.poll(Number(token));if(r!==null)out=String(r);});}
  catch(e){return {done:true,error:String(e)};}
  if(out===null)return {done:false};
  if(out==='CANCELLED')return {done:true,cancelled:true};
  if(out.startsWith('ERR:'))return {done:true,error:out.slice(4)};
  if(out.startsWith('OK:')){
    const nl=out.indexOf('\n');
    return {done:true,status:Number(out.slice(3,nl<0?undefined:nl)),body:nl<0?'':out.slice(nl+1)};
  }
  return {done:true,error:'bad-helper-response'};
}
function cancelHttp(token){if(!token||!__JAsyncHttp)return;try{Java.perform(()=>__JAsyncHttp.cancel(Number(token)));}catch(_){}}

let googleBlockedUntil=0,googleAuthBlocked=false,googleRoutesBlockedUntil=0,googleRoutesAuthBlocked=false;
let googleRequests=0,googleSuccess=0,googleCancelled=0;
function markPlacesNetworkFailure(){googleBlockedUntil=Math.max(googleBlockedUntil,Date.now()+4000);__networkAvailableAt=0;}
function googleHeaders(fieldMask=FIELD_MASK){
  return {'Content-Type':'application/json','X-Goog-Api-Key':GOOGLE_PLACES_API_KEY,'X-Goog-FieldMask':fieldMask,'X-Android-Package':ANDROID_PACKAGE,'X-Android-Cert':ANDROID_CERT_SHA1};
}
function googleRoutesHeaders(){
  return {'Content-Type':'application/json','X-Goog-Api-Key':GOOGLE_ROUTES_API_KEY||GOOGLE_PLACES_API_KEY,'X-Goog-FieldMask':ROUTES_FIELD_MASK,'X-Android-Package':ANDROID_PACKAGE,'X-Android-Cert':ANDROID_CERT_SHA1};
}
function googleAvailableBeforeIntercept(){
  migratePrivateState();
  if(!GOOGLE_PLACES_API_KEY)return {ok:false,reason:'missing-key'};
  if(googleAuthBlocked)return {ok:false,reason:'auth-blocked'};
  if(Date.now()<googleBlockedUntil)return {ok:false,reason:'cooldown'};
  if(!androidNetworkAvailable())return {ok:false,reason:'offline'};
  if(!resolveIdentity())return {ok:false,reason:'identity-not-ready'};
  return {ok:true,reason:''};
}

let searchGeneration=0;
const __googleNegativeQueryCache=new Map();
function googleNegativeKey(q){return normalizeQuery(q).toLocaleLowerCase();}
function pruneGoogleNegativeCache(){const now=Date.now();for(const [k,v] of __googleNegativeQueryCache)if(!v||Number(v.until)<=now)__googleNegativeQueryCache.delete(k);while(__googleNegativeQueryCache.size>64)__googleNegativeQueryCache.delete(__googleNegativeQueryCache.keys().next().value);}
function cacheGoogleNegativeQuery(q,reason){const ms=reason==='empty'?GOOGLE_EMPTY_CACHE_MS:(reason==='parse'?GOOGLE_PARSE_CACHE_MS:0);if(ms<=0)return;pruneGoogleNegativeCache();__googleNegativeQueryCache.set(googleNegativeKey(q),{until:Date.now()+ms,reason});}
function googleNegativeCached(q){pruneGoogleNegativeCache();const v=__googleNegativeQueryCache.get(googleNegativeKey(q));return v&&Number(v.until)>Date.now()?v:null;}
async function googleTextSearch(query,bias,generation,radiusMeters=50000){
  const q=normalizeQuery(query);if(!shouldCallGoogle(q))return {ok:false,places:[],reason:'short-query'};
  if(!androidNetworkAvailable())return {ok:false,places:[],reason:'offline'};
  migratePrivateState();if(!GOOGLE_PLACES_API_KEY||!resolveIdentity()||googleAuthBlocked||Date.now()<googleBlockedUntil)return {ok:false,places:[],reason:'google-blocked'};
  const body=buildTextSearchBody(q,bias||getLocationBias(),radiusMeters,{});
  body.pageSize=Math.min(FAST_SEARCH_MAX_RESULTS,Math.max(1,Number(body.pageSize)||FAST_SEARCH_MAX_RESULTS));
  const token=startHttpPost(TEXT_SEARCH_URL,googleHeaders(FAST_SEARCH_FIELD_MASK),body,false,SEARCH_READ_TIMEOUT_MS);
  if(!token)return {ok:false,places:[],reason:'http-helper-unavailable'};
  googleRequests++;const t0=Date.now();log(`GOOGLE_REQUEST endpoint=text qlen=${Array.from(q).length} lang=${inferLang(q)} requestNo=${googleRequests}`);
  return await new Promise(resolve=>{
    const tick=()=>{
      if(generation!==searchGeneration){cancelHttp(token);googleCancelled++;resolve({ok:false,places:[],reason:'stale',suppressFallback:true});return;}
      const r=pollHttp(token);if(!r||!r.done){setTimeout(tick,SEARCH_POLL_MS);return;}
      if(r.cancelled){resolve({ok:false,places:[],reason:'cancelled',suppressFallback:true});return;}
      if(r.error){__networkAvailableAt=0;log(`GOOGLE_NETWORK_ERROR ${String(r.error).slice(0,180)}`);resolve({ok:false,places:[],reason:'network'});return;}
      if(r.status<200||r.status>=300){
        const f=classifyGoogleFailure(r.status,r.body);
        if(f.kind==='auth'){googleAuthBlocked=true;googleBlockedUntil=Math.max(googleBlockedUntil,Date.now()+60000);}
        else if(Number.isFinite(f.cooldownMs)&&f.cooldownMs>0)googleBlockedUntil=Date.now()+f.cooldownMs;
        log(`GOOGLE_HTTP status=${r.status} kind=${f.kind} code=${f.code||'none'}`);resolve({ok:false,places:[],reason:`http-${r.status}`});return;
      }
      try{const places=parsePlacesResponse(r.body);
        if(!places.length){log(`GOOGLE_EMPTY qlen=${Array.from(q).length}`);resolve({ok:false,places:[],reason:'empty'});return;}
        googleSuccess++;log(`GOOGLE_OK results=${places.length} ms=${Date.now()-t0} successNo=${googleSuccess}`);resolve({ok:true,places});}
      catch(e){log(`GOOGLE_PARSE_ERROR ${String(e)}`);resolve({ok:false,places:[],reason:'parse'});}
    };tick();
  });
}

async function googleNearbySearch(categoryId,categoryName,bias,generation,radiusMeters=25000,typesOverride=null){
  const types=Array.isArray(typesOverride)&&typesOverride.length?[...new Set(typesOverride)]:googleTypesForMagicCategory(categoryId,categoryName);
  if(!types.length)return {ok:false,places:[],reason:'unmapped-category'};
  if(!androidNetworkAvailable())return {ok:false,places:[],reason:'offline'};
  migratePrivateState();if(!GOOGLE_PLACES_API_KEY||!resolveIdentity()||googleAuthBlocked||Date.now()<googleBlockedUntil)return {ok:false,places:[],reason:'google-blocked'};
  const body=buildNearbySearchBody(types,bias||getLocationBias(),radiusMeters,inferLang(categoryName||''),{routingSummaries:false});
  body.maxResultCount=Math.min(FAST_SEARCH_MAX_RESULTS,Math.max(1,Number(body.maxResultCount)||FAST_SEARCH_MAX_RESULTS));
  const token=startHttpPost(NEARBY_SEARCH_URL,googleHeaders(FAST_SEARCH_FIELD_MASK),body,false,SEARCH_READ_TIMEOUT_MS);
  if(!token)return {ok:false,places:[],reason:'http-helper-unavailable'};
  googleRequests++;const t0=Date.now();log(`GOOGLE_NEARBY_REQUEST categoryId=${categoryId} types=${types.join(',')} requestNo=${googleRequests}`);
  return await new Promise(resolve=>{
    const tick=()=>{
      if(generation!==searchGeneration){cancelHttp(token);googleCancelled++;resolve({ok:false,places:[],reason:'stale',suppressFallback:true});return;}
      const r=pollHttp(token);if(!r||!r.done){setTimeout(tick,NEARBY_POLL_MS);return;}
      if(r.cancelled){resolve({ok:false,places:[],reason:'cancelled',suppressFallback:true});return;}
      if(r.error){__networkAvailableAt=0;log(`GOOGLE_NEARBY_NETWORK_ERROR ${String(r.error).slice(0,160)}`);resolve({ok:false,places:[],reason:'network'});return;}
      if(r.status<200||r.status>=300){
        const f=classifyGoogleFailure(r.status,r.body);
        if(f.kind==='auth'){googleAuthBlocked=true;googleBlockedUntil=Math.max(googleBlockedUntil,Date.now()+60000);}
        else if(Number.isFinite(f.cooldownMs)&&f.cooldownMs>0)googleBlockedUntil=Date.now()+f.cooldownMs;
        log(`GOOGLE_NEARBY_HTTP status=${r.status} kind=${f.kind}`);resolve({ok:false,places:[],reason:`http-${r.status}`});return;
      }
      try{const places=parsePlacesResponse(r.body);
        if(!places.length){log(`GOOGLE_NEARBY_EMPTY categoryId=${categoryId}`);resolve({ok:false,places:[],reason:'empty'});return;}
        googleSuccess++;log(`GOOGLE_NEARBY_OK categoryId=${categoryId} results=${places.length} ms=${Date.now()-t0}`);resolve({ok:true,places});}
      catch(e){log(`GOOGLE_NEARBY_PARSE_ERROR ${String(e)}`);resolve({ok:false,places:[],reason:'parse'});}
    };tick();
  });
}

function utf8Length(s){
  let n=0;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c<0x80)n++;else if(c<0x800)n+=2;else if(c>=0xd800&&c<=0xdbff&&i+1<s.length&&s.charCodeAt(i+1)>=0xdc00&&s.charCodeAt(i+1)<=0xdfff){n+=4;i++;}else n+=3;}return n;
}
function extractIntegerText(raw,key){const re=new RegExp('"'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"\\s*:\\s*(-?\\d+)');const m=re.exec(raw);return m?m[1]:null;}
function extractResultId(raw){const m=/"result"\s*:\s*(-?\d+)/.exec(raw);return m?m[1]:null;}

let gem=null,nativeCallOriginal=null,nativeCreate=null,libcFree=null,libcStrdup=null,dartPort=null,postCObject=null,replacementKeepAlive=null;
function callGemRaw(raw,createObject){
  const p=Memory.allocUtf8String(raw),fn=createObject?nativeCreate:nativeCallOriginal,rp=fn(p,utf8Length(raw));
  if(rp.isNull())throw new Error('libGEM returned NULL');
  const text=rp.readUtf8String();try{libcFree(rp);}catch(_){}return text;
}
function callGemObject(id,className,method,argsJson,dependencyId=-1){
  return callGemRaw('{"id":'+id+',"class":'+JSON.stringify(className)+',"method":'+JSON.stringify(method)+',"args":'+argsJson+',"dependencyId":'+dependencyId+'}',false);
}
function resolveMagicLaneCategoryName(categoryId){
  const n=Number(categoryId);if(!Number.isFinite(n))return '';
  for(const method of ['getCategory','getGenericCategory']){
    try{
      const resp=callGemRaw('{"id":0,"class":"GenericCategories","method":'+JSON.stringify(method)+',"args":'+Math.trunc(n)+',"dependencyId":-1}',false);
      const objId=extractResultId(resp);if(!objId)continue;
      const d=JSON.parse(String(callGemObject(objId,'LandmarkCategory','getName','{}')));
      const name=d&&typeof d.result==='string'?d.result.trim():'';
      if(name)return name;
    }catch(_){}
  }
  return magicGenericCategoryName(n);
}
function createLandmark(place){
  const createResp=callGemRaw('{"class":"Landmark"}',true),id=extractResultId(createResp);
  if(!id)throw new Error(`Landmark create failed: ${createResp}`);
  const call=(method,argsJson)=>callGemObject(id,'Landmark',method,argsJson,-1);
  call('setName',JSON.stringify(String(place.name||'Google place')));
  if(Array.isArray(place.addressFields)){
    const fields=place.addressFields.slice();
    const street=String(fields[5]||'').replace(/\s+/g,' ').trim();
    const number=String(fields[6]||'').trim();
    if(number&&street&&street!==number&&!street.startsWith(number+' '))fields[5]=`${number} ${street}`;
    // Never parse or invent a number. If Google did not provide structured
    // street_number, use Google's own formatted address as the stock display line.
    else if(!number&&String(place.formattedAddress||'').trim())fields[5]=String(place.formattedAddress).trim();
    call('setAddress',JSON.stringify({fields}));
    log(`ADDRESS_INJECT streetNumber=${number?'yes':'no'} stockDisplay=${String(fields[5]||'').slice(0,100)}`);
  }
  call('setCoordinates',JSON.stringify({latitude:Number(place.latitude),longitude:Number(place.longitude)}));
  call('setImageFromIconId','108006');
  return id;
}
function pushLandmark(listId,landmarkId){callGemRaw('{"id":'+listId+',"class":"LandmarkList","method":"push_back","args":'+landmarkId+',"dependencyId":-1}',false);}
function resolveDartPortAndPoster(){
  if(!gem)return false;
  try{
    if(!dartPort){const p=gem.base.add(GEM_DART_PORT_OFFSET).readS64();if(p.toString()!=='0')dartPort=p;}
    if(!postCObject){
      const slot=gem.base.add(GEM_POST_COBJECT_SLOT_OFFSET).readPointer();
      if(!slot.isNull()){const fp=slot.readPointer();if(!fp.isNull())postCObject=new NativeFunction(fp,'bool',['int64','pointer']);}
    }
  }catch(e){log(`DART_PORT_ERROR ${String(e)}`);}
  return !!dartPort&&!!postCObject;
}
function postCompleteEvent(listenerIdText){
  if(!resolveDartPortAndPoster())throw new Error('Dart ReceivePort/PostCObject not ready');
  const event=JSON.stringify({eventName:String(listenerIdText),arguments:{eventType:'completeEvent',errCode:0,hint:''}});
  const str=Memory.allocUtf8String(event),obj=Memory.alloc(16);obj.writeS32(5);obj.add(4).writeU32(0);obj.add(8).writePointer(str);
  return postCObject(int64(dartPort.toString()),obj);
}
function finishEmpty(listenerId){try{postCompleteEvent(listenerId);}catch(e){log(`COMPLETE_ERROR ${String(e)}`);}}
function finishWithSafeStockFallback(listenerId,reason){
  // Async Google completion occurs after the intercepted native call returned.
  // Re-entering libGEM native_call here caused the observed 0x0 access violation.
  // Finish this request, cool Google briefly, and let the NEXT request pass
  // synchronously through the untouched stock Magic Earth call path.
  const why=String(reason||'google-failure');
  // Do not make Google appear to disappear for 15 seconds after one transient
  // DNS/empty/parse miss. Longer auth/quota cooldowns already set above win.
  const localCooldown=why==='empty'?500:(why==='network'?2000:(why==='parse'?1000:3000));
  googleBlockedUntil=Math.max(googleBlockedUntil,Date.now()+localCooldown);
  log(`NATIVE_SEARCH_FALLBACK_DEFERRED reason=${why} cooldownMs=${localCooldown} nextSearch=stock noNativeReentry=yes`);
  finishEmpty(listenerId);
}
function injectPlacesAndComplete(places,listId,listenerId,generation,kind){
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
}

const pendingCategoryByThread=new Map();
function biasFromSearchArgs(args){
  if(!args||typeof args!=='object')return null;
  for(const k of ['referenceCoordinates','referencePosition','position','coordinates']){
    const v=args[k];if(!v||typeof v!=='object')continue;
    const b=safeBias({latitude:Number(v.latitude),longitude:Number(v.longitude)},null);if(b)return b;
  }
  return null;
}
function deliverTypedSearch(query,listId,listenerId,generation,bias,originalRaw){
  setTimeout(async()=>{
    await new Promise(r=>setTimeout(r,GOOGLE_TYPED_DEBOUNCE_MS));
    if(generation!==searchGeneration){finishEmpty(listenerId);return;}
    let out=await googleTextSearch(query,bias,generation,50000);
    if(generation!==searchGeneration){finishEmpty(listenerId);return;}
    if(out&&!out.ok&&!out.suppressFallback&&['network'].includes(String(out.reason||''))){
      log(`GOOGLE_RETRY endpoint=text reason=${out.reason}`);
      await new Promise(r=>setTimeout(r,FAST_RETRY_DELAY_MS));
      if(generation!==searchGeneration){finishEmpty(listenerId);return;}
      out=await googleTextSearch(query,bias,generation,50000);
    }
    if(out&&out.ok){__googleNegativeQueryCache.delete(googleNegativeKey(query));injectPlacesAndComplete(out.places,listId,listenerId,generation,'typed');return;}
    if(out&&!out.suppressFallback)cacheGoogleNegativeQuery(query,String(out.reason||''));
    if(!(out&&out.suppressFallback)){finishWithSafeStockFallback(listenerId,out&&out.reason||'google-failure');return;}
    finishEmpty(listenerId);
  },0);
}
function deliverCategorySearch(name,categoryId,types,listId,listenerId,generation,bias,originalRaw){
  setTimeout(async()=>{
    let out=await googleNearbySearch(categoryId,name,bias,generation,25000,types);
    if(generation!==searchGeneration){finishEmpty(listenerId);return;}
    if(out&&!out.ok&&!out.suppressFallback&&['network'].includes(String(out.reason||''))){
      log(`GOOGLE_RETRY endpoint=nearby reason=${out.reason}`);
      await new Promise(r=>setTimeout(r,FAST_RETRY_DELAY_MS));
      if(generation!==searchGeneration){finishEmpty(listenerId);return;}
      out=await googleNearbySearch(categoryId,name,bias,generation,25000,types);
    }
    if(out&&out.ok){injectPlacesAndComplete(out.places,listId,listenerId,generation,'category');return;}
    if(!(out&&out.suppressFallback)){finishWithSafeStockFallback(listenerId,out&&out.reason||'nearby-failure');return;}
    finishEmpty(listenerId);
  },0);
}

function handleGemDispatch(raw){
  let req;try{req=JSON.parse(raw);}catch(_){return null;}
  if(!req||!req.class||!req.method)return null;

  if(req.class==='LandmarkStoreCollection'&&req.method==='addStoreCategoryId'&&req.args){
    const categoryId=Number(req.args.categoryId),storeId=Number(req.args.storeId);
    if(Number.isFinite(categoryId)){
      const tid=Process.getCurrentThreadId(),now=Date.now();
      for(const [k,v] of pendingCategoryByThread)if(!v||now-Number(v.at)>CATEGORY_CONTEXT_TTL_MS*4)pendingCategoryByThread.delete(k);
      if(pendingCategoryByThread.size>32){const first=pendingCategoryByThread.keys().next();if(!first.done)pendingCategoryByThread.delete(first.value);}
      const prev=pendingCategoryByThread.get(tid);
      const categories=prev&&now-prev.at<=CATEGORY_CONTEXT_TTL_MS&&Array.isArray(prev.categories)?prev.categories.slice():[];
      categories.push({categoryId,storeId});pendingCategoryByThread.set(tid,{categories,at:now});
    }
    return null;
  }

  if(req.class==='SearchService'&&req.method==='search'&&req.args){
    const query=normalizeQuery(typeof req.args.textFilter==='string'?req.args.textFilter:'');
    const neg=googleNegativeCached(query);if(neg){log(`SEARCH_FORWARD reason=google-negative-cache kind=${neg.reason}`);return null;}
    const availability=googleAvailableBeforeIntercept();
    if(!availability.ok||!shouldCallGoogle(query))return null;
    const listId=extractIntegerText(raw,'results'),listenerId=extractIntegerText(raw,'listener');
    if(!listId||!listenerId){log('SEARCH_FORWARD reason=ids-not-parsed');return null;}
    searchGeneration++;const gen=searchGeneration,bias=biasFromSearchArgs(req.args)||getLocationBias();
    log(`SEARCH_INTERCEPT kind=typed qlen=${Array.from(query).length} gen=${gen}`);
    deliverTypedSearch(query,listId,listenerId,gen,bias,raw);
    return {handled:true};
  }

  if(req.class==='SearchService'&&req.method==='searchAroundPosition'&&req.args){
    const tid=Process.getCurrentThreadId(),ctx=pendingCategoryByThread.get(tid);
    if(!ctx||Date.now()-ctx.at>CATEGORY_CONTEXT_TTL_MS){if(ctx)pendingCategoryByThread.delete(tid);return null;}
    pendingCategoryByThread.delete(tid);
    if(!Array.isArray(ctx.categories)||!ctx.categories.length)return null;
    const availability=googleAvailableBeforeIntercept();if(!availability.ok)return null;
    const listId=extractIntegerText(raw,'results'),listenerId=extractIntegerText(raw,'listener');
    const pos=req.args.position||{},bias=safeBias({latitude:Number(pos.latitude),longitude:Number(pos.longitude)});
    if(!listId||!listenerId){log('CATEGORY_FORWARD reason=ids-not-parsed');return null;}
    const resolved=ctx.categories.map(cat=>{const name=resolveMagicLaneCategoryName(cat.categoryId);return {...cat,name,types:googleTypesForMagicCategory(cat.categoryId,name)};});
    if(resolved.length>1&&resolved.some(x=>!x.types.length)){log(`CATEGORY_FORWARD reason=multi-category-unmapped count=${resolved.length}`);return null;}
    const types=[...new Set(resolved.flatMap(x=>x.types))].slice(0,50);
    const name=resolved.map(x=>x.name).filter(Boolean).join(' / ')||magicGenericCategoryName(resolved[0].categoryId);
    if(!name||!types.length)return null;
    const categoryId=resolved.length===1?resolved[0].categoryId:resolved.map(x=>x.categoryId).join(',');
    searchGeneration++;const gen=searchGeneration;
    log(`SEARCH_INTERCEPT kind=category categoryId=${categoryId} mappedTypes=${types.length} gen=${gen}`);
    deliverCategorySearch(name,categoryId,types,listId,listenerId,gen,bias,raw);
    return {handled:true};
  }
  return null;
}

/* Only two route-request fields are touched:
 * - avoidUnpavedRoads: requested feature.
 * - buildTerrainProfile: required to inspect native Path/SingleTrack sections.
 * Everything else (route type, traffic avoidance policy, alternatives, heading,
 * online calculation, path algorithm, waypoint approach) remains stock.
 */
// Magic Lane's published transport-mode ID is stable: Car=0, Lorry=1,
// Pedestrian=2, Bicycle=3, Public=4, SharedVehicles=5. Using the numeric ID
// avoids a generated-wrapper enum lookup on startup and fixes carEnum=unknown.
const __carTransportValue=0;
function normKey(k){return String(k||'').replace(/[^a-z0-9]/gi,'').toLowerCase();}
function inspectTransportMode(root){
  let found=null;const seen=new Set();
  const walk=(v,d)=>{if(found!==null||d>8||v===null||typeof v!=='object'||seen.has(v))return;seen.add(v);if(Array.isArray(v)){for(const x of v)walk(x,d+1);return;}for(const [k,val] of Object.entries(v)){if(normKey(k)==='transportmode'){found=val;return;}walk(val,d+1);}};
  walk(root,0);
  if(found===null)return {present:false,isCar:true};
  if(typeof found==='number'&&Number.isFinite(__carTransportValue))return {present:true,isCar:found===__carTransportValue};
  const s=String(found).toLowerCase();if(s.includes('car'))return {present:true,isCar:true};
  if(Number.isFinite(__carTransportValue)&&/^-?\d+$/.test(s))return {present:true,isCar:Number(s)===__carTransportValue};
  return {present:true,isCar:false};
}
function patchMinimalRouteRaw(raw){
  let req;try{req=JSON.parse(String(raw));}catch(_){return null;}
  if(String(req.class||'')!=='RoutingService'||!/calculateRoute/i.test(String(req.method||'')))return null;
  const transport=inspectTransportMode(req.args||{});if(transport.present&&!transport.isCar)return null;
  const fields=[],seen=new Set();
  const walk=(v,d)=>{
    if(d>10||v===null||typeof v!=='object'||seen.has(v))return;seen.add(v);
    if(Array.isArray(v)){for(const x of v)walk(x,d+1);return;}
    for(const k of Object.keys(v)){
      const nk=normKey(k);
      if(nk==='avoidunpavedroads'&&v[k]!==true){v[k]=true;fields.push(k);}
      else if(nk==='buildterrainprofile'&&v[k]!==true){v[k]=true;fields.push(k);}
      if(v[k]&&typeof v[k]==='object')walk(v[k],d+1);
    }
  };
  walk(req.args||{},0);
  if(!fields.length)return null;
  log(`ROUTE_MINIMAL_PREFS fields=${[...new Set(fields)].join(',')} stockElsewhere=yes`);
  return JSON.stringify(req);
}

function findJavaEnum(className,wanted){
  try{
    const E=Java.use(className),vals=E.values();
    for(let i=0;i<vals.length;i++){
      const obj=vals[i],name=String(obj.toString());
      if(name.toLowerCase().includes(String(wanted).toLowerCase())){
        let value=null;try{value=Number(obj.getValue());}catch(_){}
        return {obj,name,value:Number.isFinite(value)?value:null};
      }
    }
  }catch(_){}
  return null;
}
function configureNativeTraffic(){
  // Stock Magic Earth owns its native traffic preference. Google advisory is
  // independent. No Java enum/object creation belongs on the startup hot path.
  log('MAGICLANE_TRAFFIC_POLICY owner=stock forceEnable=no googleTrafficIndependent=yes carEnum=known-id-0');
}

let __navSession=null,__navGeneration=0,__routeAssistTimer=null,__trafficInFlight=false,__trafficRequestToken=null,__trafficRefreshMs=180000,__lastTrafficRoadblockAt=0;
let __roadBlockBindings=null;
const __narrowAvoided=new Map();

/*
 * Near-native traffic visualization.
 *
 * PERFORMANCE CONTRACT:
 * - Magic Lane renders the paths; CairoDrive never draws per frame.
 * - No pan/zoom listener, no custom Android overlay, no UI polling loop.
 * - The real GemSurfaceView/MapView created by stock Magic Earth is reused.
 * - Traffic refresh remains the normal low-frequency advisory refresh (about
 *   2-5 minutes); map work occurs only when the traffic model materially changes.
 * - Adjacent equal traffic states are merged before rendering.
 * - Geometry is Douglas-Peucker simplified with a route-length-aware tolerance,
 *   then guarded by a hard point ceiling only as a last resort.
 * - The renderer reuses unchanged native Path objects and replaces only changed
 *   segments instead of rebuilding the whole traffic layer.
 * - Only CairoDrive-owned Path objects are removed; stock paths are never clear()'d.
 */
const TRAFFIC_MAP_MAX_PATHS=16;
const TRAFFIC_MAP_MAX_POINTS_PER_PATH=96;
const TRAFFIC_MAP_DISCOVERY_COOLDOWN_MS=5000;
const TRAFFIC_MAP_BOUNDARY_BUCKET_M=25;
let __trafficMapSurface=null,__trafficMapDiscoveryBusy=false,__trafficMapLastDiscoveryAt=0;
let __trafficMapTaskClass=null;
const __trafficMapJobs=[];
let __trafficMapEntries=[]; // [{key,path,speed}]
let __trafficMapFingerprint='';
let __trafficMapPending=null;

function trafficSeverity(speed){const s=String(speed||'NORMAL');return s==='TRAFFIC_JAM'?2:s==='SLOW'?1:0;}
function trafficSpeedFromSeverity(v){return Number(v)>=2?'TRAFFIC_JAM':Number(v)>=1?'SLOW':'NORMAL';}
function trafficColor(speed){
  if(String(speed)==='TRAFFIC_JAM')return [220,45,45,225];
  if(String(speed)==='SLOW')return [245,183,0,220];
  return [35,178,88,205];
}
function trafficCoordValid(p){return !!(p&&Number.isFinite(Number(p.latitude))&&Number.isFinite(Number(p.longitude)));}
function trafficPointDistanceM(a,b){
  const lat0=(Number(a.latitude)+Number(b.latitude))*0.5*Math.PI/180;
  const x=(Number(b.longitude)-Number(a.longitude))*111320*Math.cos(lat0);
  const y=(Number(b.latitude)-Number(a.latitude))*110540;
  return Math.hypot(x,y);
}
function trafficPointToSegmentDistanceM(p,a,b){
  const lat0=Number(p.latitude)*Math.PI/180,kx=111320*Math.cos(lat0),ky=110540;
  const px=Number(p.longitude)*kx,py=Number(p.latitude)*ky;
  const ax=Number(a.longitude)*kx,ay=Number(a.latitude)*ky;
  const bx=Number(b.longitude)*kx,by=Number(b.latitude)*ky;
  const vx=bx-ax,vy=by-ay,wx=px-ax,wy=py-ay,den=vx*vx+vy*vy;
  let t=den>0?(wx*vx+wy*vy)/den:0;t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(ax+t*vx),py-(ay+t*vy));
}
function trafficSimplifyToleranceM(lengthM){
  const l=Math.max(0,Number(lengthM)||0);
  if(l>=10000)return 8;
  if(l>=5000)return 6;
  if(l>=2000)return 4.5;
  return 3;
}
function simplifyTrafficCoordinates(coords,lengthM,maxPoints=TRAFFIC_MAP_MAX_POINTS_PER_PATH){
  let a=(Array.isArray(coords)?coords:[]).filter(trafficCoordValid);
  if(a.length<=2)return a;
  // Remove essentially duplicate samples before DP.
  const dedup=[a[0]];
  for(let i=1;i<a.length;i++){
    if(i===a.length-1||trafficPointDistanceM(dedup[dedup.length-1],a[i])>=2)dedup.push(a[i]);
  }
  a=dedup;if(a.length<=2)return a;
  const keep=new Uint8Array(a.length);keep[0]=1;keep[a.length-1]=1;
  const epsilon=trafficSimplifyToleranceM(lengthM),stack=[[0,a.length-1]];
  while(stack.length){
    const [lo,hi]=stack.pop();let best=-1,bestD=epsilon;
    for(let i=lo+1;i<hi;i++){
      const d=trafficPointToSegmentDistanceM(a[i],a[lo],a[hi]);
      if(d>bestD){bestD=d;best=i;}
    }
    if(best>lo&&best<hi){keep[best]=1;stack.push([lo,best],[best,hi]);}
  }
  let out=[];for(let i=0;i<a.length;i++)if(keep[i])out.push(a[i]);
  // Hard guard only. Even sampling is applied after geometric simplification,
  // so this should be rare and cannot create unbounded JNI/native geometry work.
  if(out.length>maxPoints){
    const capped=[out[0]],last=out.length-1,slots=maxPoints-2;
    for(let i=1;i<=slots;i++)capped.push(out[Math.round(i*last/(slots+1))]);
    capped.push(out[last]);out=capped;
  }
  return out;
}
function trafficGeometryHash(coords){
  // FNV-1a over ~1 m quantized coordinates. This detects actual route-shape
  // changes while avoiding churn from insignificant floating-point noise.
  let h=2166136261>>>0;
  for(const p of coords||[]){
    const a=Math.round(Number(p.latitude)*1e5),b=Math.round(Number(p.longitude)*1e5);
    for(const v of [a,b]){
      let x=v|0;
      for(let i=0;i<4;i++){h^=(x>>>(i*8))&255;h=Math.imul(h,16777619)>>>0;}
    }
  }
  return h.toString(16).padStart(8,'0');
}
function trafficSegmentKey(seg){
  const q=v=>Math.round(Number(v||0)/TRAFFIC_MAP_BOUNDARY_BUCKET_M);
  return `${String(seg.speed)}:${q(seg.startM)}:${q(seg.endM)}:${trafficGeometryHash(seg.coords)}`;
}
function mergeAdjacentTrafficSegments(segs){
  const out=[];
  for(const x of segs||[]){
    const p=out[out.length-1];
    if(p&&p.speed===x.speed&&Number(x.startM)-Number(p.endM)<=90){
      p.endM=x.endM;p.lengthM=Number(p.lengthM||0)+Number(x.lengthM||0);
      const tail=x.coords||[];if(tail.length){
        const last=p.coords[p.coords.length-1],first=tail[0];
        p.coords.push(...(last&&first&&Number(last.routeDistanceM)===Number(first.routeDistanceM)?tail.slice(1):tail));
      }
    }else out.push({...x,coords:[...(x.coords||[])]});
  }
  return out;
}
function budgetTrafficSegments(out){
  if(out.length<=TRAFFIC_MAP_MAX_PATHS)return out;
  const start=out[0].startM,end=out[out.length-1].endM;
  const span=Math.max(300,(end-start)/TRAFFIC_MAP_MAX_PATHS),bins=[];
  for(let bs=start;bs<end;bs+=span){
    const be=Math.min(end,bs+span),parts=out.filter(x=>x.endM>bs&&x.startM<be);if(!parts.length)continue;
    const w=[0,0,0],coords=[];
    for(const x of parts){
      const overlap=Math.max(0,Math.min(be,x.endM)-Math.max(bs,x.startM));
      w[trafficSeverity(x.speed)]+=overlap;coords.push(...x.coords);
    }
    const total=w[0]+w[1]+w[2];let sev=0;
    if(total>0&&w[2]/total>=0.25)sev=2;
    else if(total>0&&(w[1]+w[2])/total>=0.35)sev=1;
    const dedup=[];
    for(const c of coords.sort((a,b)=>Number(a.routeDistanceM)-Number(b.routeDistanceM))){
      const last=dedup[dedup.length-1];
      if(!last||Number(c.routeDistanceM)!==Number(last.routeDistanceM))dedup.push(c);
    }
    if(dedup.length>=2)bins.push({speed:trafficSpeedFromSeverity(sev),startM:bs,endM:be,lengthM:be-bs,coords:dedup});
  }
  return mergeAdjacentTrafficSegments(bins).slice(0,TRAFFIC_MAP_MAX_PATHS);
}
function buildTrafficMapSegments(match){
  const rows=(match&&Array.isArray(match.matched)?match.matched:[])
    .filter(p=>trafficCoordValid(p)&&Number.isFinite(Number(p.routeDistanceM)))
    .sort((a,b)=>Number(a.routeDistanceM)-Number(b.routeDistanceM));
  if(rows.length<2)return [];
  const edgeStates=[];
  for(let i=0;i<rows.length-1;i++){
    const a=rows[i],b=rows[i+1],gap=Number(b.routeDistanceM)-Number(a.routeDistanceM);
    if(!(gap>0)||gap>Math.max(450,Number(a.stepM||80)*3.5)){edgeStates.push(null);continue;}
    edgeStates.push({speed:String(a.speed||'NORMAL'),a,b,lengthM:gap});
  }
  // Smooth a tiny A/B/A island: usually one noisy map-match sample, not a real
  // traffic transition worth another native object.
  for(let i=1;i<edgeStates.length-1;i++){
    const p=edgeStates[i-1],c=edgeStates[i],n=edgeStates[i+1];
    if(p&&c&&n&&p.speed===n.speed&&c.speed!==p.speed&&c.lengthM<=Math.max(160,Number(c.a.stepM||80)*1.6))c.speed=p.speed;
  }
  const segs=[];let cur=null;
  for(const e of edgeStates){
    if(!e){cur=null;continue;}
    if(!cur||cur.speed!==e.speed||Number(e.a.routeDistanceM)-cur.endM>Math.max(450,Number(e.a.stepM||80)*3.5)){
      cur={speed:e.speed,startM:Number(e.a.routeDistanceM),endM:Number(e.b.routeDistanceM),lengthM:e.lengthM,coords:[e.a,e.b]};segs.push(cur);
    }else{
      cur.endM=Number(e.b.routeDistanceM);cur.lengthM+=e.lengthM;cur.coords.push(e.b);
    }
  }
  let out=mergeAdjacentTrafficSegments(segs.filter(x=>x.coords.length>=2&&x.lengthM>=40));
  out=budgetTrafficSegments(out);
  for(const x of out){
    x.coords=simplifyTrafficCoordinates(x.coords,x.lengthM);
    x.key=trafficSegmentKey(x);
  }
  return out.filter(x=>x.coords.length>=2);
}
function trafficMapFingerprint(segments){return (segments||[]).map(x=>x.key||trafficSegmentKey(x)).join('|');}
function releaseTrafficMapSurface(){try{if(__trafficMapSurface&&__trafficMapSurface.$dispose)__trafficMapSurface.$dispose();}catch(_){}__trafficMapSurface=null;}
function discoverTrafficMapSurface(reason='traffic'){
  if(!Java.available||__trafficMapSurface||__trafficMapDiscoveryBusy)return !!__trafficMapSurface;
  const now=Date.now();if(now-__trafficMapLastDiscoveryAt<TRAFFIC_MAP_DISCOVERY_COOLDOWN_MS)return false;
  __trafficMapLastDiscoveryAt=now;__trafficMapDiscoveryBusy=true;
  try{Java.perform(()=>{
    try{
      Java.use('com.magiclane.sdk.core.GemSurfaceView');
      Java.choose('com.magiclane.sdk.core.GemSurfaceView',{
        onMatch(instance){
          if(!__trafficMapSurface){__trafficMapSurface=Java.retain(instance);log(`TRAFFIC_MAP_SURFACE_CAPTURED reason=${reason}`);return 'stop';}
        },
        onComplete(){
          __trafficMapDiscoveryBusy=false;
          if(!__trafficMapSurface){log('TRAFFIC_MAP_SURFACE_MISSING failOpen=yes');return;}
          const pending=__trafficMapPending;if(pending){__trafficMapPending=null;enqueueTrafficMapJob('render',pending);}
        }
      });
    }catch(e){__trafficMapDiscoveryBusy=false;log(`TRAFFIC_MAP_SURFACE_ERROR ${String(e)}`);}
  });}catch(e){__trafficMapDiscoveryBusy=false;log(`TRAFFIC_MAP_SURFACE_ERROR ${String(e)}`);}
  return !!__trafficMapSurface;
}
function ensureTrafficMapTaskClass(){
  if(__trafficMapTaskClass)return __trafficMapTaskClass;
  const Function0=Java.use('kotlin.jvm.functions.Function0');
  const name=`com.cairodrive.runtime.TrafficMapTask${Process.id}`;
  __trafficMapTaskClass=Java.registerClass({
    name,implements:[Function0],
    methods:{invoke(){
      const job=__trafficMapJobs.shift();if(!job)return null;
      try{if(job.kind==='clear')clearTrafficMapPathsOnGemThread(job.reason);else if(job.kind==='render')renderTrafficMapPathsOnGemThread(job.payload);else if(job.kind==='route-assist')routeAssistOnGemThread(job.payload);else if(job.kind==='roadblock')applyTrafficRoadblockOnGemThread(job.payload);}catch(e){log(`TRAFFIC_MAP_GEM_ERROR ${String(e)}`);}
      return null;
    }}
  });
  return __trafficMapTaskClass;
}
function postTrafficMapJobToGemThread(){
  try{Java.perform(()=>{
    const Task=ensureTrafficMapTaskClass(),task=Task.$new();let posted=false;
    for(const clsName of ['com.magiclane.sdk.util.GemCall','com.magiclane.sdk.util.SdkCall']){
      try{
        const G=Java.use(clsName);
        try{if(G.execute){G.execute(task);posted=true;break;}}catch(_){}
        try{if(G.INSTANCE&&G.INSTANCE.value&&G.INSTANCE.value.execute){G.INSTANCE.value.execute(task);posted=true;break;}}catch(_){}
      }catch(_){}
    }
    if(!posted){__trafficMapJobs.shift();log('TRAFFIC_MAP_GEM_POST_FAILED failOpen=yes');}
  });}catch(e){__trafficMapJobs.shift();log(`TRAFFIC_MAP_GEM_POST_FAILED ${String(e)}`);}
}
function enqueueTrafficMapJob(kind,payloadOrReason){
  if(!Java.available)return false;
  if(kind==='render'&&!__trafficMapSurface){__trafficMapPending=payloadOrReason;discoverTrafficMapSurface('first-render');return false;}
  const job=kind==='clear'?{kind,reason:String(payloadOrReason||'')}:{kind,payload:payloadOrReason};
  for(let i=__trafficMapJobs.length-1;i>=0;i--){const k=__trafficMapJobs[i].kind;if((kind==='render'&&k==='render')||(kind==='route-assist'&&k==='route-assist')||(kind==='clear'&&k==='render'))__trafficMapJobs.splice(i,1);}
  if(__trafficMapJobs.length>=8)__trafficMapJobs.shift();__trafficMapJobs.push(job);postTrafficMapJobToGemThread();return true;
}
function getRealTrafficPathCollection(){
  if(!__trafficMapSurface)return null;
  try{
    const mapView=__trafficMapSurface.getMapView();if(!mapView)return null;
    const prefs=mapView.getPreferences();if(!prefs)return null;
    try{const p=prefs.getPaths();if(p)return p;}catch(_){}
    try{const p=prefs.paths.value;if(p)return p;}catch(_){}
  }catch(e){log(`TRAFFIC_MAP_COLLECTION_ERROR ${String(e)}`);}
  return null;
}
function disposeTrafficMapEntry(collection,entry){
  if(!entry)return;
  try{if(collection&&entry.path)collection.remove(entry.path);}catch(_){}
  try{if(entry.path&&entry.path.$dispose)entry.path.$dispose();}catch(_){}
}
function clearTrafficMapPathsOnGemThread(reason='refresh'){
  const collection=getRealTrafficPathCollection();
  for(const e of __trafficMapEntries)disposeTrafficMapEntry(collection,e);
  __trafficMapEntries=[];__trafficMapFingerprint='';
  if(reason!=='refresh')log(`TRAFFIC_MAP_CLEARED reason=${reason}`);
}
let __trafficStyleCache=new Map();
function newMagicLaneCoordinate(latitude,longitude){
  const Coordinates=Java.use('com.magiclane.sdk.places.Coordinates'),c=Coordinates.$new();
  c.setLatitude(Number(latitude));c.setLongitude(Number(longitude));return c;
}
function createTrafficNativePath(segment,index){
  const ArrayList=Java.use('java.util.ArrayList'),PathCls=Java.use('com.magiclane.sdk.core.Path'),list=ArrayList.$new();
  for(const c of segment.coords||[])list.add(newMagicLaneCoordinate(c.latitude,c.longitude));
  let path=null;try{path=PathCls.Companion.value.produceWithCoords(list);}catch(e){log(`TRAFFIC_MAP_PATH_CREATE_FAILED ${String(e)}`);}
  if(!path)return null;
  const name=`__cairodrive_traffic_${__navGeneration}_${index}_${String(segment.speed).toLowerCase()}`;
  try{path.setName(name);}catch(_){try{path.name.value=name;}catch(__){}}return path;
}
function newMagicLaneRgba(values){
  const Rgba=Java.use('com.magiclane.sdk.core.Rgba'),v=values||[0,0,0,255],x=Rgba.$new();
  x.setRed(Math.max(0,Math.min(255,Math.round(Number(v[0])||0))));x.setGreen(Math.max(0,Math.min(255,Math.round(Number(v[1])||0))));
  x.setBlue(Math.max(0,Math.min(255,Math.round(Number(v[2])||0))));x.setAlpha(Math.max(0,Math.min(255,Math.round(Number(v[3])||0))));return x;
}
function trafficNativeStyle(speed){
  const key=String(speed||'NORMAL');let x=__trafficStyleCache.get(key);if(x)return x;const c=trafficColor(key);
  const fill=Java.retain(newMagicLaneRgba(c));
  const border=Java.retain(newMagicLaneRgba([Math.max(0,c[0]-35),Math.max(0,c[1]-35),Math.max(0,c[2]-35),Math.min(235,c[3]+10)]));
  x={fill,border};__trafficStyleCache.set(key,x);return x;
}
function addTrafficNativePath(collection,path,speed){
  const style=trafficNativeStyle(speed);try{collection.add(path,style.border,style.fill,0.30,1.55);return true;}catch(e){log(`TRAFFIC_MAP_ADD_ERROR ${String(e)}`);return false;}
}
function trafficSnapshotStillCurrentOnGemThread(route,snapshot){
  if(!route||!snapshot)return false;try{const td=route.getTimeDistance(false),total=td?Number(td.getTotalDistance()):NaN;if(!Number.isFinite(total)||Math.abs(total-Number(snapshot.total))>Math.max(180,Math.abs(Number(snapshot.total)||0)*0.02))return false;const d=magicRouteCoordinate(route,Math.max(0,total-2));return !!(d&&snapshot.destination&&trafficPointDistanceM(d,snapshot.destination)<=100);}catch(_){return false;}
}
function renderTrafficMapPathsOnGemThread(payload){
  if(!payload||!Array.isArray(payload.segments))return;
  const collection=getRealTrafficPathCollection();if(!collection){releaseTrafficMapSurface();log('TRAFFIC_MAP_RENDER_SKIPPED reason=no-real-map-collection');return;}
  let segments=payload.segments;
  if(payload.snapshot&&__navSession&&Number(payload.generation)===Number(__navSession.generation)){
    const route=currentRoute(__navSession);if(!trafficSnapshotStillCurrentOnGemThread(route,payload.snapshot)){log('TRAFFIC_MAP_STALE_ROUTE_DROP');scheduleRouteAssist(500);return;}segments=densifyTrafficSegmentsOnMagicRoute(segments,route);
  }
  const effectiveFingerprint=trafficMapFingerprint(segments);if(effectiveFingerprint===__trafficMapFingerprint)return;

  // Simple snapshot replacement is intentional. Traffic refreshes only every
  // ~2-5 minutes, so retaining/reconciling individual native Path wrappers adds
  // lifecycle risk for negligible performance benefit. Never clear() the stock
  // collection: remove only CairoDrive-owned paths.
  let removed=0;
  for(const e of __trafficMapEntries){disposeTrafficMapEntry(collection,e);removed++;}
  __trafficMapEntries=[];
  __trafficMapFingerprint='';

  const next=[];let created=0,failed=0;
  for(let i=0;i<segments.length&&i<TRAFFIC_MAP_MAX_PATHS;i++){
    const seg=segments[i],key=seg.key||trafficSegmentKey(seg);
    const path=createTrafficNativePath(seg,i);
    if(!path){failed++;continue;}
    if(addTrafficNativePath(collection,path,seg.speed)){
      next.push({key,path:Java.retain(path),speed:seg.speed});created++;
    }else{
      try{if(path.$dispose)path.$dispose();}catch(_){}
      failed++;
    }
  }
  __trafficMapEntries=next;
  if(next.length>0)__trafficMapFingerprint=effectiveFingerprint;
  log(`TRAFFIC_MAP_RENDERED paths=${next.length} created=${created} removed=${removed} failed=${failed} maxPaths=${TRAFFIC_MAP_MAX_PATHS} maxPoints=${TRAFFIC_MAP_MAX_POINTS_PER_PATH} renderer=MagicLane-native replaceSnapshot=yes differential=no simplified=yes refreshDriven=yes`);
}
function updateTrafficMapVisualization(match,snapshot){
  if(!match||!match.usable){if(__trafficMapEntries.length||__trafficMapFingerprint)enqueueTrafficMapJob('clear','unusable-traffic-match');return;}
  const segments=buildTrafficMapSegments(match);if(!segments.length){if(__trafficMapEntries.length||__trafficMapFingerprint)enqueueTrafficMapJob('clear','empty-traffic-segments');return;}
  const payload={segments,snapshot:snapshot?{total:snapshot.total,destination:snapshot.destination}:null,generation:__navGeneration};
  if(!__trafficMapSurface){__trafficMapPending=payload;discoverTrafficMapSurface('traffic-update');return;}enqueueTrafficMapJob('render',payload);
}

function javaObjectClassName(obj){if(obj===null||obj===undefined)return '';try{return String(obj.$className||obj.getClass().getName()||'');}catch(_){return '';}}
function routeServiceActive(cap){
  if(!cap||!cap.service||!cap.listener)return false;
  try{if(typeof cap.service.isNavigationActive==='function'&&cap.service.isNavigationActive(cap.listener))return true;}catch(e){log(`NAV_ACTIVE_PROBE_ERROR ${String(e)}`);}
  try{if(typeof cap.service.isSimulationActive==='function'&&cap.service.isSimulationActive(cap.listener))return true;}catch(_){}
  return false;
}
function currentRoute(cap){
  if(!cap||!cap.service||!cap.listener)return null;
  try{return cap.service.getNavigationRoute(cap.listener);}catch(e){log(`NAV_ROUTE_READ_ERROR ${String(e)}`);return null;}
}
function scheduleRouteAssist(delayMs=2000){
  try{if(__routeAssistTimer)clearTimeout(__routeAssistTimer);}catch(_){}
  __routeAssistTimer=setTimeout(routeAssistTick,Math.max(250,Number(delayMs)||2000));
}
function initialAssistRetryDelay(ageMs){
  const age=Math.max(0,Number(ageMs)||0);
  if(age<1200)return 400;
  if(age<4000)return 700;
  return 1500;
}
function releaseNavigationSession(reason='replace'){
  if(__trafficRequestToken){try{cancelHttp(__trafficRequestToken);}catch(_){}__trafficRequestToken=null;}__trafficInFlight=false;
  const old=__navSession;if(!old)return;
  try{if(old.listener&&old.listener.$dispose)old.listener.$dispose();}catch(_){}
  try{if(old.service&&old.service.$dispose)old.service.$dispose();}catch(_){}
  __navSession=null;log(`NAV_SESSION_RELEASED reason=${reason}`);
}
function captureNavigationSession(service,args){
  let listener=null;
  for(const a of args||[]){if(!a)continue;const n=javaObjectClassName(a);if(/NavigationListener/.test(n)){listener=a;break;}}
  if(!listener)return;
  if(__navSession)releaseNavigationSession('replaced');
  __navGeneration++;
  __navSession={service:Java.retain(service),listener:Java.retain(listener),at:Date.now(),generation:__navGeneration};
  try{if(__freeTrafficEntries.length)postFreeTrafficJob({kind:'clear',reason:'navigation-start'});}catch(_){}
  try{cancelFreeTrafficVectorization();}catch(_){}__trafficRefreshMs=180000;__trafficInFlight=false;__trafficRequestToken=null;__roadBlockBindings=null;__lastTrafficRoadblockAt=0;__narrowAvoided.clear();
  log(`NAV_SESSION_CAPTURED listener=${javaObjectClassName(listener)} minimalAssist=traffic+narrow firstAssistMs=${NAV_INITIAL_ASSIST_MS}`);
  scheduleRouteAssist(NAV_INITIAL_ASSIST_MS);
}
function installNavigationCaptureHooks(){
  if(!Java.available)return;
  try{Java.perform(()=>{
    const NS=Java.use('com.magiclane.sdk.routesandnavigation.NavigationService');let count=0;
    for(const methodName of ['startNavigation','startNavigationWithRoute','startSimulation','startSimulationWithRoute']){
      const m=NS[methodName];if(!m||!m.overloads)continue;
      for(const ov of m.overloads){
        const orig=ov;
        ov.implementation=function(){
          const args=[...arguments],ret=orig.call(this,...args);
          try{captureNavigationSession(this,args);}catch(e){log(`NAV_SESSION_CAPTURE_ERROR ${String(e)}`);}
          return ret;
        };
        count++;
      }
    }
    log(`NAV_CAPTURE_READY startHooks=${count} overlays=none polling=low-frequency`);
  });}catch(e){log(`NAV_CAPTURE_INIT_ERROR ${String(e)}`);}
}

function objectNativeKey(obj){
  if(!obj)return '';
  try{if(obj.address&&obj.address.value!==undefined)return String(obj.address.value);}catch(_){}
  try{if(obj.$h!==undefined)return String(obj.$h);}catch(_){}
  try{return `${obj.$className||'obj'}:${String(obj)}`;}catch(_){return '';}
}
function resolveRoadBlockBindings(cap){
  if(__roadBlockBindings)return __roadBlockBindings;
  const out=[];
  try{
    const f=cap&&cap.service&&cap.service.setNavigationRoadBlock,ovs=f&&f.overloads?f.overloads:[];
    for(const ov of ovs){
      const types=(ov.argumentTypes||[]).map(x=>String(x.className||x.name||x));
      if(types.filter(t=>/\bint\b/.test(t)).length>=2)out.push({ov,types});
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
        if(/\bint\b/.test(t))mapped.push(intIndex++===0?length:start);
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
}

function applyTrafficRoadblockOnGemThread(p){
  const cap=__navSession;if(!p||!cap||Number(p.generation)!==Number(cap.generation)||!routeServiceActive(cap))return;
  const route=currentRoute(cap);if(!trafficSnapshotStillCurrentOnGemThread(route,p.snapshot)){log('GOOGLE_TRAFFIC_ROADBLOCK_STALE_DROP');scheduleRouteAssist(500);return;}
  try{const totalTd=route.getTimeDistance(false),remainTd=route.getTimeDistance(true),total=totalTd?Number(totalTd.getTotalDistance()):NaN,remain=remainTd?Number(remainTd.getTotalDistance()):NaN;if(!Number.isFinite(total)||!Number.isFinite(remain))return;const progressed=Math.max(0,total-remain),ahead=Number(p.jamStartM)-progressed,remainingAfter=total-Number(p.jamEndM),now=Date.now();if(ahead<100||ahead>3500||remainingAfter<500||now-__lastTrafficRoadblockAt<120000)return;if(invokeNavigationRoadBlock(p.length,ahead,'traffic'))__lastTrafficRoadblockAt=now;}catch(e){log(`GOOGLE_TRAFFIC_ROADBLOCK_APPLY_ERROR ${String(e)}`);}
}

function strongNarrowEvidence(route){
  if(!route)return null;
  try{
    const profile=route.getTerrainProfile();if(!profile)return null;
    const totalTd=route.getTimeDistance(false),remainTd=route.getTimeDistance(true);
    const total=totalTd?Number(totalTd.getTotalDistance()):NaN,remain=remainTd?Number(remainTd.getTotalDistance()):NaN;
    if(!Number.isFinite(total)||!Number.isFinite(remain)||total<=0)return null;
    const progressed=Math.max(0,total-remain),sections=profile.getRoadTypeSections();if(!sections)return null;
    const n=Number(sections.size());
    for(let i=0;i<n;i++){
      const sec=sections.get(i);if(!sec)continue;
      const type=String(sec.getType()?sec.getType().toString():'').toLowerCase();
      if(!(type.includes('singletrack')||/(^|\.)path$/.test(type)))continue;
      const start=Number(sec.getStartDistanceM()),next=i+1<n?Number(sections.get(i+1).getStartDistanceM()):total,end=Number.isFinite(next)?next:total;
      const len=Math.max(0,end-start),ahead=start-progressed;
      if(!Number.isFinite(start)||len<35||ahead<60||ahead>5000)continue;
      if(total-end<300)continue;
      return {type,lengthM:len,aheadM:ahead,startM:start,total,remain};
    }
  }catch(e){log(`NARROW_PROFILE_ERROR ${String(e)}`);}
  return null;
}
function maybeAvoidNarrow(route){
  const e=strongNarrowEvidence(route);if(!e)return;
  const key=`${e.type}:${Math.round(e.startM/25)}`,now=Date.now(),prior=Number(__narrowAvoided.get(key)||0);
  if(now-prior<20*60*1000)return;
  log(`NARROW_EVIDENCE type=${e.type} aheadM=${Math.round(e.aheadM)} lenM=${Math.round(e.lengthM)} confidence=strong`);
  if(invokeNavigationRoadBlock(Math.min(700,e.lengthM+40),e.aheadM,'narrow'))__narrowAvoided.set(key,now);
}

function readMagicCoordinate(c){
  if(!c)return null;let lat=NaN,lon=NaN;
  try{lat=Number(c.getLatitude());}catch(_){try{lat=Number(c.latitude.value);}catch(__){}}
  try{lon=Number(c.getLongitude());}catch(_){try{lon=Number(c.longitude.value);}catch(__){}}
  return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{latitude:lat,longitude:lon}:null;
}
function magicRouteCoordinate(route,distanceM){
  try{return readMagicCoordinate(route.getCoordinateOnRoute(Math.max(0,Math.round(distanceM))));}
  catch(_){try{return readMagicCoordinate(route.getCoordinateOnRoute(Number(distanceM)));}catch(__){return null;}}
}
function collectTrafficRouteSnapshot(route,cap){
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
    if(!loc||!Number.isFinite(loc.latitude)||!Number.isFinite(loc.longitude)||!Number.isFinite(loc.accuracy)||loc.accuracy>50||Date.now()-loc.time>30000)return null;
    const destination=magicRouteCoordinate(route,Math.max(0,total-2));if(!destination)return null;
    const step=Math.max(80,Math.ceil(remain/140/20)*20),samples=[];
    for(let d=progressed;d<=total&&samples.length<160;d+=step){const c=magicRouteCoordinate(route,d);if(c)samples.push({...c,routeDistanceM:d,stepM:step});}
    if(samples.length<4)return null;
    for(let i=0;i<samples.length;i++){
      const a=samples[i],b=samples[Math.min(samples.length-1,i+1)];
      a.heading=i+1<samples.length?bearingDeg(a,b):(i?Number(samples[i-1].heading):Number(loc.bearing));
    }
    const vias=[];for(let k=1;k<=6;k++){const c=magicRouteCoordinate(route,progressed+remain*(k/7));if(c)vias.push(c);}
    return {origin:{latitude:loc.latitude,longitude:loc.longitude},destination,samples,vias,total,remain,progressed,accuracyM:loc.accuracy,mode:simulation?'simulation':'live'};
  }catch(e){log(`GOOGLE_TRAFFIC_SNAPSHOT_ERROR ${String(e)}`);return null;}
}
async function requestGoogleTrafficAdvice(snapshot,generation){
  if(__trafficInFlight)return;
  if(!androidNetworkAvailable())return;
  migratePrivateState();if(!GOOGLE_ROUTES_API_KEY)GOOGLE_ROUTES_API_KEY=GOOGLE_PLACES_API_KEY;
  if(!GOOGLE_ROUTES_API_KEY||googleRoutesAuthBlocked||Date.now()<googleRoutesBlockedUntil||!resolveIdentity())return;
  __trafficInFlight=true;
  const body=buildTrafficRequest(snapshot.origin,snapshot.destination,{languageCode:'en',routingPreference:'TRAFFIC_AWARE',viaPoints:snapshot.vias});
  const token=startHttpPost(ROUTES_URL,googleRoutesHeaders(),body,true,TRAFFIC_READ_TIMEOUT_MS);
  if(!token){__trafficInFlight=false;return;}__trafficRequestToken=token;
  const t0=Date.now();log(`GOOGLE_TRAFFIC_REQUEST mode=${snapshot.mode||'live'} remainM=${Math.round(snapshot.remain)} samples=${snapshot.samples.length}`);
  const result=await new Promise(resolve=>{const tick=()=>{const r=pollHttp(token);if(!r||!r.done){setTimeout(tick,TRAFFIC_POLL_MS);return;}resolve(r);};tick();});
  __trafficInFlight=false;if(__trafficRequestToken===token)__trafficRequestToken=null;
  if(generation!==__navGeneration||!__navSession)return;
  if(result.cancelled)return;
  if(result.error){googleRoutesBlockedUntil=Date.now()+60000;log(`GOOGLE_TRAFFIC_NETWORK_ERROR ${String(result.error).slice(0,160)}`);return;}
  if(result.status<200||result.status>=300){
    const f=classifyGoogleFailure(result.status,result.body);
    if(f.kind==='auth'){googleRoutesAuthBlocked=true;googleRoutesBlockedUntil=Date.now()+60000;}else googleRoutesBlockedUntil=Date.now()+(Number.isFinite(f.cooldownMs)&&f.cooldownMs>0?f.cooldownMs:60000);
    log(`GOOGLE_TRAFFIC_HTTP status=${result.status} kind=${f.kind}`);return;
  }
  try{
    const traffic=parseTrafficRoutesResponse(result.body),match=matchMagicSamplesToTraffic(snapshot.samples,traffic);
    __trafficRefreshMs=Math.max(120000,trafficRefreshIntervalMs(match));
    updateTrafficMapVisualization(match,snapshot);
    const run=match&&match.strongJamRun;
    log(`GOOGLE_TRAFFIC_OK ms=${Date.now()-t0} coverage=${Number(match.coverage||0).toFixed(3)} jamM=${Math.round(Number(match.jamM)||0)} delayS=${Number.isFinite(traffic.trafficDelaySeconds)?Math.round(traffic.trafficDelaySeconds):-1}`);
    if(!match.usable||!run||Number(run.lengthM)<180||!hasMeaningfulTrafficDelay(traffic))return;
    const length=Math.min(900,Math.max(120,run.lengthM+80));
    enqueueTrafficMapJob('roadblock',{length,jamStartM:Number(run.startRouteDistanceM),jamEndM:Number(run.endRouteDistanceM),generation,snapshot:{total:snapshot.total,destination:snapshot.destination}});
  }catch(e){log(`GOOGLE_TRAFFIC_PARSE_ERROR ${String(e)}`);}
}
function routeAssistOnGemThread(p){
  const cap=__navSession;if(!cap||!p||Number(p.generation)!==Number(cap.generation))return;const age=Math.max(0,Date.now()-cap.at);
  if(!routeServiceActive(cap)){if(age<20000){scheduleRouteAssist(initialAssistRetryDelay(age));return;}releaseNavigationSession('ended');__trafficMapPending=null;__roadBlockBindings=null;enqueueTrafficMapJob('clear','navigation-ended');return;}
  const route=currentRoute(cap);if(!route){scheduleRouteAssist(initialAssistRetryDelay(age));return;}maybeAvoidNarrow(route);const snap=collectTrafficRouteSnapshot(route,cap);
  if(snap){setTimeout(()=>requestGoogleTrafficAdvice(snap,cap.generation),0);scheduleRouteAssist(__trafficRefreshMs);return;}
  if(age<8000){scheduleRouteAssist(initialAssistRetryDelay(age));return;}scheduleRouteAssist(Math.min(__trafficRefreshMs,15000));
}
function routeAssistTick(){__routeAssistTimer=null;const cap=__navSession;if(!cap)return;enqueueTrafficMapJob('route-assist',{generation:cap.generation});}

const NAV_TRAFFIC_RENDER_STEP_M=12;
const NAV_TRAFFIC_RENDER_MAX_POINTS=96;
function simplifyDenseTrafficCoordinates(coords,epsilon=1.0,maxPoints=TRAFFIC_MAP_MAX_POINTS_PER_PATH){
  const a=(Array.isArray(coords)?coords:[]).filter(trafficCoordValid);if(a.length<=2)return a;const keep=new Uint8Array(a.length);keep[0]=1;keep[a.length-1]=1;const stack=[[0,a.length-1]];
  while(stack.length){const [lo,hi]=stack.pop();let best=-1,bestD=epsilon;for(let i=lo+1;i<hi;i++){const d=trafficPointToSegmentDistanceM(a[i],a[lo],a[hi]);if(d>bestD){bestD=d;best=i;}}if(best>lo&&best<hi){keep[best]=1;stack.push([lo,best],[best,hi]);}}
  let out=[];for(let i=0;i<a.length;i++)if(keep[i])out.push(a[i]);if(out.length>maxPoints){const c=[out[0]],last=out.length-1,slots=maxPoints-2;for(let i=1;i<=slots;i++)c.push(out[Math.round(i*last/(slots+1))]);c.push(out[last]);out=c;}return out;
}
function densifyTrafficSegmentsOnMagicRoute(segments,route){if(!route)return segments||[];const out=[];for(const s of segments||[]){const start=Number(s.startM),end=Number(s.endM);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){out.push(s);continue;}const span=end-start,step=Math.max(NAV_TRAFFIC_RENDER_STEP_M,span/Math.max(1,NAV_TRAFFIC_RENDER_MAX_POINTS-1)),coords=[];for(let d=start;d<end;d+=step){const c=magicRouteCoordinate(route,d);if(c)coords.push({...c,routeDistanceM:d});}const tail=magicRouteCoordinate(route,end);if(tail)coords.push({...tail,routeDistanceM:end});if(coords.length>=2)out.push({...s,coords:simplifyDenseTrafficCoordinates(coords,1.0,NAV_TRAFFIC_RENDER_MAX_POINTS),key:null});else out.push(s);}for(const s of out)s.key=trafficSegmentKey(s);return out;}

/* v24.3 Free Drive traffic: nearby Google traffic -> sparse Magic Lane native Paths.
 * No frame hook. Raster work stays on one Java worker. Only SLOW/JAM is rendered.
 */
const FREE_TRAFFIC_CHECK_MS=4000;
const FREE_TRAFFIC_MOVING_REFRESH_MS=75000;
const FREE_TRAFFIC_SLOW_REFRESH_MS=120000;
const FREE_TRAFFIC_TRANSIENT_RETRY_MS=15000;
const FREE_TRAFFIC_SESSION_RETRY_MS=5000;
const FREE_TRAFFIC_MAX_PATHS=36;
let __googleMapTilesKey='',__googleMapTilesKeyLoaded=false,__JTrafficVectorizer=null;
let __freeTrafficTimer=null,__freeTrafficBusy=false,__freeTrafficToken=null,__freeTrafficStartedAt=0,__freeTrafficRetryAt=0;
let __freeTrafficWindowKey='',__freeTrafficFingerprint='',__freeTrafficEntries=[],__freeTrafficTaskClass=null;
let __freeTrafficFollowing=false,__freeTrafficFollowCheckedAt=0,__freeTrafficZoom=16;
const __freeTrafficJobs=[];

function loadGoogleMapTilesKey(force=false){
  if(__googleMapTilesKeyLoaded&&!force)return !!__googleMapTilesKey;if(!Java.available)return false;
  try{Java.perform(()=>{const AT=Java.use('android.app.ActivityThread'),app=AT.currentApplication();if(!app)return;const prefs=app.getSharedPreferences('cairodrive_private',0);const staged=readStagedSecret('/data/local/tmp/gtk'),saved=String(prefs.getString('google_map_tiles_key','')||'').trim();if(staged)prefs.edit().putString('google_map_tiles_key',staged).apply();if(staged&&staged!==__googleMapTilesKey)__freeTrafficRetryAt=0;__googleMapTilesKey=staged||saved;__googleMapTilesKeyLoaded=true;log(`GOOGLE_TILE_KEY_STATE present=${__googleMapTilesKey?'yes':'no'} storage=private-prefs`);});}catch(e){log(`GOOGLE_TILE_KEY_ERROR ${String(e)}`);}return !!__googleMapTilesKey;
}
function ensureTrafficVectorizer(){if(__JTrafficVectorizer)return __JTrafficVectorizer;if(!Java.available)return null;try{Java.perform(()=>{__JTrafficVectorizer=Java.use('com.cairodrive.traffic.GoogleTrafficTileVectorizer');});}catch(e){log(`FREE_TRAFFIC_HELPER_ERROR ${String(e)}`);__JTrafficVectorizer=null;}return __JTrafficVectorizer;}
function freeTrafficAppForeground(){let fg=true;if(!Java.available)return true;try{Java.perform(()=>{const Info=Java.use('android.app.ActivityManager$RunningAppProcessInfo'),AM=Java.use('android.app.ActivityManager'),i=Info.$new();AM.getMyMemoryState(i);fg=Number(i.importance.value)<=200;});}catch(_){fg=true;}return fg;}
function freeTrafficLocation(){let loc=null;try{Java.perform(()=>{const AT=Java.use('android.app.ActivityThread'),app=AT.currentApplication();if(app)loc=bestLocalLocation(app.getApplicationContext());});}catch(_){}if(!loc||!Number.isFinite(loc.latitude)||!Number.isFinite(loc.longitude)||Number(loc.accuracy)>75||Date.now()-Number(loc.time)>30000)return null;return loc;}
function freeTrafficSelectZoom(speed){const s=Number(speed);if(__freeTrafficZoom===16&&Number.isFinite(s)&&s>=24)__freeTrafficZoom=15;else if(__freeTrafficZoom===15&&(!Number.isFinite(s)||s<=19))__freeTrafficZoom=16;return __freeTrafficZoom;}
function freeTrafficWindowKey(loc,z){const n=2**z,lat=Math.max(-85.05112878,Math.min(85.05112878,Number(loc.latitude))),lon=((Number(loc.longitude)+180)%360+360)%360-180,r=lat*Math.PI/180,x=Math.max(0,Math.min(n-1,Math.floor((lon+180)/360*n))),merc=Math.log(Math.tan(r)+1/Math.cos(r)),y=Math.max(0,Math.min(n-1,Math.floor((1-merc/Math.PI)/2*n))),speed=Number(loc&&loc.speed),bearing=Number(loc&&loc.bearing),moving=Number.isFinite(speed)&&speed>=4&&Number.isFinite(bearing),sector=moving?Math.floor((((bearing%360)+360)%360+45)%360/90):4;return `${z}/${x}/${y}/${sector}`;}
function startFreeTrafficVectorization(loc,z){const H=ensureTrafficVectorizer();if(!H||!resolveIdentity())return null;let token=null;try{Java.perform(()=>{token=String(H.start(String(__googleMapTilesKey),String(ANDROID_PACKAGE),String(ANDROID_CERT_SHA1),Number(loc.latitude),Number(loc.longitude),Number.isFinite(Number(loc.bearing))?Number(loc.bearing):NaN,Number.isFinite(Number(loc.speed))?Number(loc.speed):0,Number(z),CONNECT_TIMEOUT_MS,6500));});}catch(e){log(`FREE_TRAFFIC_START_ERROR ${String(e)}`);}return token;}
function pollFreeTrafficVectorization(token){if(!token||!__JTrafficVectorizer)return null;let out=null;try{Java.perform(()=>{const r=__JTrafficVectorizer.poll(Number(token));if(r!==null)out=String(r);});}catch(e){return {done:true,error:String(e)};}if(out===null)return {done:false};if(out==='CANCELLED')return {done:true,cancelled:true};if(out.startsWith('ERR:'))return {done:true,error:out.slice(4)};if(out.startsWith('OK:'))return {done:true,body:out.slice(3)};return {done:true,error:'bad-vectorizer-response'};}
function cancelFreeTrafficVectorization(){if(!__freeTrafficToken||!__JTrafficVectorizer)return;try{Java.perform(()=>__JTrafficVectorizer.cancel(Number(__freeTrafficToken)));}catch(_){}__freeTrafficToken=null;}
function releaseFreeTrafficEntries(collection){for(const e of __freeTrafficEntries){try{if(collection&&e.path)collection.remove(e.path);}catch(_){}try{if(e.path&&e.path.$dispose)e.path.$dispose();}catch(_){}}__freeTrafficEntries=[];__freeTrafficFingerprint='';}
function clearFreeTrafficOnGemThread(reason='clear'){const c=getRealTrafficPathCollection();releaseFreeTrafficEntries(c);if(reason!=='refresh')log(`FREE_TRAFFIC_CLEARED reason=${reason}`);}
function freeMagicCoordinate(lat,lon){const C=Java.use('com.magiclane.sdk.places.Coordinates'),o=C.$new();o.setLatitude(Number(lat));o.setLongitude(Number(lon));return o;}
function createFreeTrafficPath(segment,index){const ArrayList=Java.use('java.util.ArrayList'),PathCls=Java.use('com.magiclane.sdk.core.Path'),list=ArrayList.$new();for(const c of segment.coords||[])list.add(freeMagicCoordinate(c.latitude,c.longitude));let path=null;try{path=PathCls.Companion.value.produceWithCoords(list);}catch(e){log(`FREE_TRAFFIC_PATH_CREATE_ERROR ${String(e)}`);}if(path)try{path.setName(`__cairodrive_free_traffic_${index}_${String(segment.speed).toLowerCase()}`);}catch(_){}return path;}
function renderFreeTrafficOnGemThread(payload){if(!payload||!Array.isArray(payload.segments))return;const c=getRealTrafficPathCollection();if(!c)return;if(payload.fingerprint===__freeTrafficFingerprint)return;releaseFreeTrafficEntries(c);const next=[];let failed=0;for(let i=0;i<payload.segments.length&&i<FREE_TRAFFIC_MAX_PATHS;i++){const s=payload.segments[i],p=createFreeTrafficPath(s,i);if(!p){failed++;continue;}if(addTrafficNativePath(c,p,s.speed))next.push({path:Java.retain(p)});else{try{if(p.$dispose)p.$dispose();}catch(_){}failed++;}}__freeTrafficEntries=next;if(next.length)__freeTrafficFingerprint=payload.fingerprint;log(`FREE_TRAFFIC_RENDERED paths=${next.length} failed=${failed} renderer=MagicLane-native source=Google-layerTraffic-raster-vector`);}
function probeFreeTrafficFollowOnGemThread(){try{const mv=__trafficMapSurface&&__trafficMapSurface.getMapView?__trafficMapSurface.getMapView():null;__freeTrafficFollowing=!!(mv&&mv.isFollowingPosition());}catch(_){__freeTrafficFollowing=false;}__freeTrafficFollowCheckedAt=Date.now();}
function ensureFreeTrafficTaskClass(){if(__freeTrafficTaskClass)return __freeTrafficTaskClass;const Function0=Java.use('kotlin.jvm.functions.Function0');__freeTrafficTaskClass=Java.registerClass({name:`com.cairodrive.runtime.FreeTrafficTask${Process.id}`,implements:[Function0],methods:{invoke(){const j=__freeTrafficJobs.shift();if(!j)return null;try{if(j.kind==='render')renderFreeTrafficOnGemThread(j.payload);else if(j.kind==='probe')probeFreeTrafficFollowOnGemThread();else clearFreeTrafficOnGemThread(j.reason);}catch(e){log(`FREE_TRAFFIC_GEM_ERROR ${String(e)}`);}return null;}}});return __freeTrafficTaskClass;}
function postFreeTrafficJob(job){if(!Java.available)return false;__freeTrafficJobs.splice(0,__freeTrafficJobs.length);__freeTrafficJobs.push(job);try{Java.perform(()=>{const Task=ensureFreeTrafficTaskClass(),task=Task.$new();let posted=false;for(const cls of ['com.magiclane.sdk.util.GemCall','com.magiclane.sdk.util.SdkCall'])try{const G=Java.use(cls);if(G.execute){G.execute(task);posted=true;break;}}catch(_){}if(!posted){__freeTrafficJobs.splice(0,__freeTrafficJobs.length);log('FREE_TRAFFIC_GEM_POST_FAILED failOpen=yes');}});return true;}catch(_){__freeTrafficJobs.splice(0,__freeTrafficJobs.length);return false;}}
function parseFreeTrafficResult(body){const d=JSON.parse(String(body||'{}')),out=[];for(const s of Array.isArray(d.segments)?d.segments:[]){const coords=[];for(const q of Array.isArray(s.coords)?s.coords:[]){if(!Array.isArray(q)||q.length<2)continue;const lat=Number(q[0]),lon=Number(q[1]);if(Number.isFinite(lat)&&Number.isFinite(lon))coords.push({latitude:lat,longitude:lon});}if(coords.length>=2)out.push({speed:String(s.speed)==='TRAFFIC_JAM'?'TRAFFIC_JAM':'SLOW',lengthM:Number(s.lengthM)||0,coords});}return {segments:out,z:Number(d.z),tileCount:Number(d.tileCount)||0,fetched:Number(d.fetched)||0,cached:Number(d.cached)||0};}
function freeTrafficFingerprint(segs){return (segs||[]).map(s=>`${s.speed}:${trafficGeometryHash(s.coords)}`).join('|');}
function freeTrafficRetryDelay(error){const s=String(error||'').toLowerCase();if(s.includes('forbidden'))return 300000;if(s.includes('quota')||s.includes('provider cooldown'))return 180000;if(s.includes('session invalid'))return FREE_TRAFFIC_SESSION_RETRY_MS;return FREE_TRAFFIC_TRANSIENT_RETRY_MS;}
async function freeTrafficTick(){if(__freeTrafficBusy)return;__freeTrafficBusy=true;try{const now=Date.now();if(__navSession){cancelFreeTrafficVectorization();if(__freeTrafficEntries.length)postFreeTrafficJob({kind:'clear',reason:'navigation-active'});return;}if(!freeTrafficAppForeground()||!androidNetworkAvailable()||!loadGoogleMapTilesKey()||now<__freeTrafficRetryAt)return;if(!__trafficMapSurface){discoverTrafficMapSurface('free-drive');return;}if(now-__freeTrafficFollowCheckedAt>5000){postFreeTrafficJob({kind:'probe'});return;}if(!__freeTrafficFollowing){if(__freeTrafficEntries.length)postFreeTrafficJob({kind:'clear',reason:'not-following-position'});return;}const loc=freeTrafficLocation();if(!loc)return;const speed=Number(loc.speed),z=freeTrafficSelectZoom(speed),wk=freeTrafficWindowKey(loc,z),refresh=Number.isFinite(speed)&&speed>=4?FREE_TRAFFIC_MOVING_REFRESH_MS:FREE_TRAFFIC_SLOW_REFRESH_MS;if(__freeTrafficToken)return;if(wk===__freeTrafficWindowKey&&now-__freeTrafficStartedAt<refresh)return;__freeTrafficWindowKey=wk;__freeTrafficStartedAt=now;const token=startFreeTrafficVectorization(loc,z);if(!token){__freeTrafficRetryAt=Date.now()+FREE_TRAFFIC_TRANSIENT_RETRY_MS;return;}__freeTrafficToken=token;const result=await new Promise(resolve=>{const tick=()=>{const r=pollFreeTrafficVectorization(token);if(!r||!r.done){setTimeout(tick,150);return;}resolve(r);};tick();});if(__freeTrafficToken===token)__freeTrafficToken=null;if(__navSession)return;if(result.cancelled)return;if(result.error){const delay=freeTrafficRetryDelay(result.error);__freeTrafficRetryAt=Date.now()+delay;__freeTrafficStartedAt=0;log(`FREE_TRAFFIC_ERROR retryMs=${delay} ${String(result.error).slice(0,160)}`);return;}__freeTrafficRetryAt=0;const parsed=parseFreeTrafficResult(result.body),fp=freeTrafficFingerprint(parsed.segments);if(fp===__freeTrafficFingerprint)return;if(!parsed.segments.length){if(__freeTrafficEntries.length)postFreeTrafficJob({kind:'clear',reason:'no-congestion'});return;}postFreeTrafficJob({kind:'render',payload:{segments:parsed.segments.slice(0,FREE_TRAFFIC_MAX_PATHS),fingerprint:fp}});log(`FREE_TRAFFIC_UPDATE segments=${parsed.segments.length} tiles=${parsed.tileCount} fetched=${parsed.fetched} cached=${parsed.cached} z=${parsed.z}`);}catch(e){__freeTrafficRetryAt=Date.now()+FREE_TRAFFIC_TRANSIENT_RETRY_MS;log(`FREE_TRAFFIC_TICK_ERROR ${String(e)}`);}finally{__freeTrafficBusy=false;}}
function startFreeDriveTraffic(){if(__freeTrafficTimer)return;loadGoogleMapTilesKey(true);ensureTrafficVectorizer();__freeTrafficTimer=setInterval(()=>{freeTrafficTick();},FREE_TRAFFIC_CHECK_MS);setTimeout(()=>freeTrafficTick(),1200);log(`FREE_TRAFFIC_READY source=Google-layerTraffic-raster-vector maxPaths=${FREE_TRAFFIC_MAX_PATHS} nearbyWindow=6-moving/9-slow nativePaths=yes followOnly=yes zoomHysteresis=yes`);}
let __nativeFilterModule=null;
function nativeLibraryDirs(hintModule){
  const dirs=[],add=m=>{if(!m||!m.path)return;const p=String(m.path),i=p.lastIndexOf('/');if(i>0){const d=p.slice(0,i);if(!dirs.includes(d))dirs.push(d);}};
  add(hintModule);for(const name of ['libGEM.so','libflutter.so','libapp.so']){try{add(Process.findModuleByName(name));}catch(_){}}
  return dirs;
}
function ensureNativeFilterLoaded(hintModule){
  if(__nativeFilterModule)return __nativeFilterModule;
  const existing=Process.findModuleByName('libcairodrive_filter.so');if(existing){__nativeFilterModule=existing;return existing;}
  for(const dir of nativeLibraryDirs(hintModule)){
    try{
      const m=Module.load(`${dir}/libcairodrive_filter.so`);
      m.getExportByName('cd_native_call_filter');m.getExportByName('cd_set_search_handler');m.getExportByName('cd_set_route_handler');m.getExportByName('cd_set_original');
      __nativeFilterModule=m;return m;
    }catch(_){}
  }
  return null;
}

function installGem(m){
  if(gem)return;gem=m;
  const nativeCallAddr=m.getExportByName('native_call');
  nativeCreate=new NativeFunction(m.getExportByName('native_call_createObject'),'pointer',['pointer','int64']);
  const setPortAddr=m.getExportByName('set_dart_port'),libc=Process.getModuleByName('libc.so');
  libcFree=new NativeFunction(libc.getExportByName('free'),'void',['pointer']);
  libcStrdup=new NativeFunction(libc.getExportByName('strdup'),'pointer',['pointer']);
  try{Interceptor.attach(setPortAddr,{onEnter(args){dartPort=int64(args[0].toString());try{resolveDartPortAndPoster();}catch(_){}}});}catch(e){log(`SET_PORT_HOOK_ERROR ${String(e)}`);}
  resolveDartPortAndPoster();

  const searchHandler=new NativeCallback(function(requestPtr,requestLen){
    try{
      const len=Number(requestLen),raw=requestPtr.readUtf8String(len>0&&len<1024*1024?len:undefined),h=handleGemDispatch(raw);
      if(h&&h.handled)return libcStrdup(Memory.allocUtf8String('{"result":0}'));
    }catch(e){log(`SEARCH_HANDLER_ERROR ${String(e)}`);}
    return nativeCallOriginal(requestPtr,requestLen);
  },'pointer',['pointer','int64']);

  const routeHandler=new NativeCallback(function(requestPtr,requestLen){
    try{
      const len=Number(requestLen),raw=requestPtr.readUtf8String(len>0&&len<1024*1024?len:undefined),rewritten=patchMinimalRouteRaw(raw);
      if(rewritten){const p=Memory.allocUtf8String(rewritten);return nativeCallOriginal(p,utf8Length(rewritten));}
    }catch(e){log(`ROUTE_HANDLER_ERROR ${String(e)}`);}
    return nativeCallOriginal(requestPtr,requestLen);
  },'pointer',['pointer','int64']);

  let armed=false;
  try{
    const fm=ensureNativeFilterLoaded(m);
    if(fm){
      const filterPtr=fm.getExportByName('cd_native_call_filter');
      const setHandler=new NativeFunction(fm.getExportByName('cd_set_search_handler'),'void',['pointer']);
      const setRouteHandler=new NativeFunction(fm.getExportByName('cd_set_route_handler'),'void',['pointer']);
      const setOriginal=new NativeFunction(fm.getExportByName('cd_set_original'),'void',['pointer']);
      setHandler(searchHandler);setRouteHandler(routeHandler);
      const originalPtr=Interceptor.replaceFast(nativeCallAddr,filterPtr);
      nativeCallOriginal=new NativeFunction(originalPtr,'pointer',['pointer','int64']);setOriginal(originalPtr);
      replacementKeepAlive={fm,searchHandler,routeHandler,setHandler,setRouteHandler,setOriginal};armed=true;
      log('GEM_FILTER_ARMED scope=google-places+minimal-route-fields');
    }
  }catch(e){log(`GEM_FILTER_ERROR ${String(e)}`);}

  if(!armed){
    replacementKeepAlive=new NativeCallback(function(requestPtr,requestLen){
      try{
        const len=Number(requestLen),raw=requestPtr.readUtf8String(len>0&&len<1024*1024?len:undefined),h=handleGemDispatch(raw);
        if(h&&h.handled)return libcStrdup(Memory.allocUtf8String('{"result":0}'));
        const rewritten=patchMinimalRouteRaw(raw);
        if(rewritten){const p=Memory.allocUtf8String(rewritten);return nativeCallOriginal(p,utf8Length(rewritten));}
      }catch(e){log(`GEM_FALLBACK_ERROR ${String(e)}`);}
      return nativeCallOriginal(requestPtr,requestLen);
    },'pointer',['pointer','int64']);
    const originalPtr=Interceptor.replaceFast(nativeCallAddr,replacementKeepAlive);
    nativeCallOriginal=new NativeFunction(originalPtr,'pointer',['pointer','int64']);
    log('GEM_FILTER_FALLBACK scope=google-places+minimal-route-fields');
  }

  // This is now log-only and cheap; keep it immediate.
  configureNativeTraffic();
  // Java wrapper hook installation is unnecessary for the launch/search hot
  // path. Install it after the stock UI has had time to render.
  setTimeout(()=>{try{installNavigationCaptureHooks();log('DEFERRED_NAV_HOOKS_READY');}catch(e){log(`DEFERRED_NAV_HOOKS_ERROR ${String(e)}`);}},900);
  setTimeout(()=>{try{startFreeDriveTraffic();}catch(e){log(`FREE_TRAFFIC_START_ERROR ${String(e)}`);}},1500);
  log(`CAIRODRIVE_READY scope=google-places+google-route-traffic+google-free-drive-raster-vector+native-traffic-paths+narrow-road stockUI=yes stockNavigation=yes stockInternals=untouched driveReady=r2 hotfix=${RUNTIME_TUNING} startupFast=yes sdkThreadSafe=yes`);
}

log(`BOOT agent=${VERSION} scope=minimal googleKey=${GOOGLE_PLACES_API_KEY?'yes':'no'}`);
// Prewarm only search-critical state after the first launch burst. Search no
// longer pays prefs/cert/helper setup when the user first opens the search box.
setTimeout(()=>{try{ensureDriveDiagnostics();migratePrivateState(true);resolveIdentity();ensureAsyncHttp();androidNetworkAvailable(true);log('DRIVE_DIAGNOSTICS_READY rotation=daily retentionDays=3 metricsEverySec=30 asyncFileIO=yes');}catch(e){log(`SEARCH_WARMUP_ERROR ${String(e)}`);}},300);

let tries=0;
const timer=setInterval(()=>{
  tries++;
  try{
    const m=Process.findModuleByName('libGEM.so');
    if(m){clearInterval(timer);setTimeout(()=>{try{installGem(Process.findModuleByName('libGEM.so')||m);}catch(e){log(`INSTALL_GEM_ERROR ${String(e)}`);}},10);}
    else if(tries%200===0)log(`WAIT_GEM tries=${tries}`);
  }catch(e){log(`WAIT_GEM_ERROR ${String(e)}`);}
},50);
