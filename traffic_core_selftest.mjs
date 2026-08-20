import assert from 'node:assert/strict';
import {ROUTES_FIELD_MASK,buildTrafficRequest,decodePolyline,headingDiff,parseTrafficRoutesResponse,matchMagicSamplesToTraffic,hasMeaningfulTrafficDelay,classifyTrafficLevel,trafficRefreshIntervalMs} from './payload/traffic-core.mjs';
const req=buildTrafficRequest({latitude:30.04,longitude:31.23},{latitude:30.05,longitude:31.25});
assert.equal(req.travelMode,'DRIVE'); assert.equal(req.routingPreference,'TRAFFIC_AWARE'); assert.deepEqual(req.extraComputations,['TRAFFIC_ON_POLYLINE']); assert(ROUTES_FIELD_MASK.includes('routes.staticDuration'));
const optimal=buildTrafficRequest({latitude:30.04,longitude:31.23},{latitude:30.05,longitude:31.25},{routingPreference:'TRAFFIC_AWARE_OPTIMAL'});assert.equal(optimal.routingPreference,'TRAFFIC_AWARE_OPTIMAL');
assert.equal(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@').length,3); assert.equal(headingDiff(355,5),10);
// tiny encoded polyline generated from known Google example; enough to verify interval expansion and matching.
const body={routes:[{duration:'100s',staticDuration:'80s',distanceMeters:500,polyline:{encodedPolyline:'}boeF~zbjVAg@EmB`GWHlD'},travelAdvisory:{speedReadingIntervals:[{endPolylinePointIndex:1,speed:'NORMAL'},{startPolylinePointIndex:1,endPolylinePointIndex:2,speed:'TRAFFIC_JAM'},{startPolylinePointIndex:2,endPolylinePointIndex:4,speed:'SLOW'}]}}]};
const t=parseTrafficRoutesResponse(body); assert(t.edges.length>=2); assert(t.edges.some(e=>e.speed==='TRAFFIC_JAM')); assert.equal(t.trafficDelaySeconds,20); assert.equal(hasMeaningfulTrafficDelay(t,{minSeconds:15,minRatio:0.5}),true); assert.equal(hasMeaningfulTrafficDelay(t,{minSeconds:30,minRatio:0.5}),false);
const samples=t.edges.map((e,i)=>({latitude:e.a.latitude,longitude:e.a.longitude,heading:e.bearing,routeDistanceM:i*50,stepM:50}));
const m=matchMagicSamplesToTraffic(samples,t,{maxDistanceM:50,maxHeadingDiffDeg:50,minCoverage:0.5});assert(m.coverage>0.5);assert(m.jamM>0);assert.equal(trafficRefreshIntervalMs(m),120000);
assert.equal(trafficRefreshIntervalMs({usable:true,normalM:900,slowM:50,jamM:0,strongJamRun:null}),300000);

const level1=classifyTrafficLevel({usable:true,normalM:900,slowM:50,jamM:0,strongJamRun:null},{trafficDelaySeconds:30,staticDurationSeconds:600}); assert.equal(level1.level,1);
const level2=classifyTrafficLevel({usable:true,normalM:600,slowM:500,jamM:0,strongJamRun:null},{trafficDelaySeconds:150,staticDurationSeconds:900}); assert.equal(level2.level,2);
const level3=classifyTrafficLevel({usable:true,normalM:600,slowM:0,jamM:180,strongJamRun:{lengthM:180}},{trafficDelaySeconds:90,staticDurationSeconds:600}); assert.equal(level3.level,3);

const noisy={...t,edges:[...t.edges]};for(let i=0;i<800;i++)noisy.edges.push({a:{latitude:24+i*0.001,longitude:25},b:{latitude:24+i*0.0011,longitude:25.001},bearing:90,speed:'NORMAL'});const mi=matchMagicSamplesToTraffic(samples,noisy,{maxDistanceM:50,maxHeadingDiffDeg:50,minCoverage:0.5});assert(mi.usable);assert(mi.candidateChecks < mi.totalEdgeChecksBruteForce/5);
console.log('traffic-core selftest: PASS');
