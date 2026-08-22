import assert from 'node:assert/strict';
import fs from 'node:fs';
const agent=fs.readFileSync('payload/cairodrive-google-search-only.js','utf8');
const traffic=fs.readFileSync('payload/traffic-core.mjs','utf8');
const java=fs.readFileSync('payload/helper/com/cairodrive/traffic/GoogleTrafficTileVectorizer.java','utf8');
const c=fs.readFileSync('payload/cairodrive-native-filter.c','utf8');
assert(agent.includes("const VERSION='v24.3-drive-test-ready'"));
assert(agent.includes("const RUNTIME_TUNING='r8-drive-observability'"));
// Exact Magic Lane 1.9.0 wrapper surfaces.
assert(agent.includes('newMagicLaneCoordinate'));
assert(agent.includes("Coordinates.$new();"));
assert(!agent.includes("Coordinates.$new(Number(c.latitude),Number(c.longitude))"));
assert(agent.includes('PathCls.Companion.value.produceWithCoords(list)'));
assert(!agent.includes('CoordinatesList'));
assert(agent.includes('newMagicLaneRgba'));
assert(!agent.includes('Rgba.$new(c[0],c[1],c[2],c[3])'));
// SDK calls and stale traffic application stay on GEM thread.
assert(agent.includes("enqueueTrafficMapJob('route-assist'"));
assert(agent.includes('routeAssistOnGemThread'));
assert(agent.includes('trafficSnapshotStillCurrentOnGemThread'));
assert(agent.includes('jamStartM:Number(run.startRouteDistanceM)'));
assert(agent.includes('const progressed=Math.max(0,total-remain),ahead=Number(p.jamStartM)-progressed'));
// Route rendering keeps 12 m detail but never asks Magic Lane for unbounded points.
assert(agent.includes('NAV_TRAFFIC_RENDER_STEP_M=12'));
assert(agent.includes('NAV_TRAFFIC_RENDER_MAX_POINTS=96'));
assert(agent.includes('span/Math.max(1,NAV_TRAFFIC_RENDER_MAX_POINTS-1)'));
// Search/API economy.
assert(agent.includes('GOOGLE_TYPED_DEBOUNCE_MS=180'));
assert(agent.includes('__googleNegativeQueryCache'));
assert(agent.includes('GOOGLE_EMPTY_CACHE_MS=30000'));
assert(agent.includes('const score=age+acc*250'));
assert(agent.includes('__locationBiasCacheAt<20000'));
assert(agent.includes('loc.accuracy>50||Date.now()-loc.time>30000'));
assert(agent.includes('googleAuthBlocked=true'));
assert(agent.includes('googleRoutesAuthBlocked=true'));
// Traffic matching uses real inter-sample distance and does not charge the final point as a full edge.
assert(traffic.includes('for(let i=0;i<ss.length-1;i++)'));
assert(traffic.includes('matchLengthM:weightM'));
assert(traffic.includes('const w=Math.max(0,Number(m.matchLengthM)||0)'));
// Free Drive economy/lifecycle.
assert(agent.includes('isFollowingPosition()'));
assert(agent.includes('followOnly=yes'));
assert(agent.includes('zoomHysteresis=yes'));
assert(!agent.includes('__navSession&&routeServiceActive(__navSession)'));
assert(java.includes('CACHE_HARD_LIMIT = 48'));
assert(java.includes('CACHE_SOFT_LIMIT = 32'));
assert(java.includes('MAX_POINTS_PER_PATH = 96'));
assert(java.includes('lastAccessMs'));
assert(java.includes('c.disconnect()'));
assert(java.includes('X-Android-Package'));
assert(java.includes('X-Android-Cert'));
assert(java.includes('if(work.size()>256)'));
assert(java.includes('ArrayList<Seg> merged=new ArrayList<Seg>()'));
assert(java.includes('private static int degree(byte[] s,int gw,int gh,int i,int wanted){int x='));
// Keep native fast filter narrow.
assert(!c.includes('searchLandmarkDetails'));
assert(c.includes('find_lit'));
assert(agent.includes('DRIVE_DIAGNOSTICS_READY'));
console.log('v24.3 final deep audit + diagnostics selftest: PASS');
