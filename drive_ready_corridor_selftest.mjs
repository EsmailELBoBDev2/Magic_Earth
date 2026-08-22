import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseTrafficRoutesResponse,
  matchMagicSamplesToTraffic,
  classifyTrafficLevel,
  trafficRefreshIntervalMs,
  bearingDeg
} from './payload/traffic-core.mjs';

const agent=fs.readFileSync('./payload/cairodrive-google-search-only.js','utf8');

// Public Cairo corridor anchors researched for this test:
// El Zawya El Hamra -> Hadayek El Kobba -> Kobri El Kobba -> Al Fangary ->
// Cairo International Stadium -> Al Azhar -> Rabaa/Hisham Barakat ->
// City Stars -> Nasr City.
const waypoints=[
  [30.09629,31.27619],
  [30.0877936111,31.28946918],
  [30.087219,31.294218],
  [30.07546,31.30117],
  [30.069129,31.312311],
  [30.059268,31.313517],
  [30.06751325,31.32496459],
  [30.07326,31.34574],
  [30.06332,31.34933]
];

const RAD=Math.PI/180,R=6371000;
function hav(a,b){
  const p1=a.latitude*RAD,p2=b.latitude*RAD;
  const dp=p2-p1,dl=(b.longitude-a.longitude)*RAD;
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}
function encode(points){
  let lastLat=0,lastLon=0,out='';
  const one=n=>{let v=n<0?~(n<<1):(n<<1),s='';while(v>=0x20){s+=String.fromCharCode((0x20|(v&0x1f))+63);v>>=5;}return s+String.fromCharCode(v+63);};
  for(const p of points){
    const lat=Math.round(p.latitude*1e5),lon=Math.round(p.longitude*1e5);
    out+=one(lat-lastLat)+one(lon-lastLon);lastLat=lat;lastLon=lon;
  }
  return out;
}
function densify(wp,stepM=80){
  const points=[],distance=[];let total=0;
  for(let i=0;i<wp.length-1;i++){
    const a={latitude:wp[i][0],longitude:wp[i][1]},b={latitude:wp[i+1][0],longitude:wp[i+1][1]};
    const seg=hav(a,b),n=Math.max(1,Math.ceil(seg/stepM));
    if(i===0){points.push(a);distance.push(0);}
    for(let j=1;j<=n;j++){
      const t=j/n,p={latitude:a.latitude+(b.latitude-a.latitude)*t,longitude:a.longitude+(b.longitude-a.longitude)*t};
      total+=hav(points.at(-1),p);points.push(p);distance.push(total);
    }
  }
  return {points,distance,total};
}

const magic=densify(waypoints);
assert(magic.total>9000&&magic.total<13000);

// Emulate an independent provider route with small non-identical geometry.
// This specifically exercises CairoDrive's 35 m distance / 40 deg heading gates.
const google=magic.points.map((p,i)=>({
  latitude:p.latitude+(4*Math.sin(i*.37))/110540,
  longitude:p.longitude+(5*Math.cos(i*.29))/(111320*Math.cos(p.latitude*RAD))
}));
const nedge=google.length-1;
const cut=f=>Math.max(1,Math.min(nedge,Math.floor(nedge*f)));
const intervals=[
  {endPolylinePointIndex:cut(.30),speed:'NORMAL'},
  {startPolylinePointIndex:cut(.30),endPolylinePointIndex:cut(.48),speed:'SLOW'},
  {startPolylinePointIndex:cut(.48),endPolylinePointIndex:cut(.68),speed:'TRAFFIC_JAM'},
  {startPolylinePointIndex:cut(.68),endPolylinePointIndex:cut(.84),speed:'SLOW'},
  {startPolylinePointIndex:cut(.84),endPolylinePointIndex:nedge,speed:'NORMAL'}
];

const googleResponse={routes:[{
  duration:'1800s',
  staticDuration:'1200s',
  distanceMeters:Math.round(magic.total),
  polyline:{encodedPolyline:encode(google)},
  travelAdvisory:{speedReadingIntervals:intervals}
}]};
const traffic=parseTrafficRoutesResponse(googleResponse);

const progressed=magic.total*.38,samples=[];
for(let i=0;i<magic.points.length;i++){
  if(magic.distance[i]<progressed)continue;
  const here=magic.points[i],next=magic.points[Math.min(magic.points.length-1,i+1)];
  samples.push({
    ...here,
    routeDistanceM:magic.distance[i],
    stepM:i+1<magic.distance.length?magic.distance[i+1]-magic.distance[i]:80,
    heading:i+1<magic.points.length?bearingDeg(here,next):bearingDeg(magic.points[i-1],here)
  });
}
const match=matchMagicSamplesToTraffic(samples,traffic);
assert(match.usable);
assert(match.coverage>.95);
assert(match.strongJamRun&&match.strongJamRun.lengthM>=180);

const level=classifyTrafficLevel(match,traffic);
assert.equal(level.level,3);
const ahead=match.strongJamRun.startRouteDistanceM-progressed;
const remainingAfter=magic.total-match.strongJamRun.endRouteDistanceM;
assert(ahead>=100&&ahead<=3500);
assert(remainingAfter>=500);
assert(trafficRefreshIntervalMs(match)>=120000&&trafficRefreshIntervalMs(match)<=300000);

// Spatial-index stress: add 800 irrelevant edges and require a major reduction
// versus brute-force matching. This is the hot algorithmic part of traffic matching.
const noisy={...traffic,edges:[...traffic.edges]};
for(let i=0;i<800;i++){
  const a={latitude:24+i*.001,longitude:25};
  const b={latitude:24+i*.0011,longitude:25.001};
  noisy.edges.push({a,b,lengthM:hav(a,b),bearing:bearingDeg(a,b),speed:'NORMAL'});
}
const stress=matchMagicSamplesToTraffic(samples,noisy);
assert(stress.usable);
assert(stress.candidateChecks<stress.totalEdgeChecksBruteForce/5);

// Conservative narrow-road gates mirror the production conditions.
function narrowGate({type,lengthM,aheadM,remainingAfterM}){
  const t=String(type||'').toLowerCase();
  return (t.includes('singletrack')||/(^|\.)path$/.test(t)) &&
    lengthM>=35 && aheadM>=60 && aheadM<=5000 && remainingAfterM>=300;
}
assert(narrowGate({type:'SingleTrack',lengthM:180,aheadM:900,remainingAfterM:2500}));
assert(!narrowGate({type:'Path',lengthM:20,aheadM:900,remainingAfterM:2500}));
assert(!narrowGate({type:'Path',lengthM:180,aheadM:40,remainingAfterM:2500}));
assert(!narrowGate({type:'Residential',lengthM:400,aheadM:900,remainingAfterM:2500}));

// Drive-ready source contracts.
assert(agent.includes("const VERSION='v24.3-drive-test-ready'"));
assert(agent.includes('FAST_SEARCH_MAX_RESULTS=10'));
assert(agent.includes('FAST_SEARCH_FIELD_MASK'));
assert(agent.includes('ADDRESS_INJECT streetNumber='));
assert(agent.includes('NATIVE_SEARCH_FALLBACK_DEFERRED'));
assert(agent.includes('noNativeReentry=yes'));
assert(!agent.includes('replayStockSearch('));
assert(agent.includes('burstMax=4'));
assert(agent.includes("'startSimulation'"));
assert(agent.includes("'startSimulationWithRoute'"));
assert(agent.includes("mode:simulation?'simulation':'live'"));
assert(agent.includes('GOOGLE_TRAFFIC_REQUEST mode='));
assert(agent.includes('MAGICLANE_TRAFFIC_POLICY owner=stock forceEnable=no'));
assert(!agent.includes('Traffic.$new()'));
assert(agent.includes('TRAFFIC_MAP_MAX_PATHS=16'));
assert(agent.includes('TRAFFIC_MAP_MAX_POINTS_PER_PATH=96'));
assert(agent.includes('renderer=MagicLane-native'));
assert(!agent.includes('onDrawFrameCustom'));
assert(!agent.includes('isNavigationActive(null)'));
assert(!agent.includes('getNavigationRoute(null)'));

const http=fs.readFileSync('./payload/helper/com/cairodrive/search/AsyncHttp.java','utf8');
assert(http.includes('PLACES_EXECUTOR = Executors.newSingleThreadExecutor()'));
assert(http.includes('TRAFFIC_EXECUTOR = Executors.newSingleThreadExecutor()'));
assert(http.includes('MAX_RESPONSE_BYTES'));
assert(http.includes('cancel(long id)'));

console.log('drive-ready Cairo corridor selftest: PASS');
console.log(`corridorKm=${(magic.total/1000).toFixed(2)} coverage=${(match.coverage*100).toFixed(1)} jamM=${Math.round(match.jamM)} level=${level.level}`);
console.log(`jamAheadM=${Math.round(ahead)} remainingAfterM=${Math.round(remainingAfter)} candidateChecks=${stress.candidateChecks}/${stress.totalEdgeChecksBruteForce}`);
console.log('address-display/safe-fallback/simulation-hooks/narrow-gates/performance-contract=PASS');
