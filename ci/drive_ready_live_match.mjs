import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseTrafficRoutesResponse,
  matchMagicSamplesToTraffic,
  classifyTrafficLevel,
  trafficRefreshIntervalMs,
  bearingDeg,
  haversineMeters
} from '../payload/traffic-core.mjs';

const file=process.argv[2]||'drive-ready-live.json';
const d=JSON.parse(fs.readFileSync(file,'utf8'));
const traffic=parseTrafficRoutesResponse(d.routesResponse);
assert(traffic.points.length>=2);
assert(traffic.edges.length>=1);

// Emulate a second route engine tracking the same corridor rather than feeding
// Google's points back unchanged. A deterministic 2-5 m offset exercises the
// exact distance/heading matcher used by CairoDrive.
let routeDistanceM=0;
const samples=[];
for(let i=0;i<traffic.points.length;i++){
  const p=traffic.points[i];
  const q={
    latitude:p.latitude+(3.5*Math.sin(i*.41))/110540,
    longitude:p.longitude+(4.5*Math.cos(i*.33))/(111320*Math.cos(p.latitude*Math.PI/180))
  };
  if(i>0)routeDistanceM+=haversineMeters(samples.at(-1),q);
  const next=traffic.points[Math.min(traffic.points.length-1,i+1)];
  const stepM=i+1<traffic.points.length?haversineMeters(p,next):(samples.length?Math.max(20,routeDistanceM/samples.length):50);
  samples.push({...q,routeDistanceM,stepM,heading:i+1<traffic.points.length?bearingDeg(p,next):(samples.at(-1)?.heading??0)});
}
const match=matchMagicSamplesToTraffic(samples,traffic);
assert(match.usable);
assert(match.coverage>.90);
const level=classifyTrafficLevel(match,traffic);
const refresh=trafficRefreshIntervalMs(match);
assert(refresh>=120000&&refresh<=300000);

console.log('DRIVE_READY_LIVE_MATCH: PASS');
console.log(`coverage=${match.coverage.toFixed(3)} normalM=${Math.round(match.normalM)} slowM=${Math.round(match.slowM)} jamM=${Math.round(match.jamM)} level=${level.level} refreshMs=${refresh}`);
console.log(`candidateChecks=${match.candidateChecks} bruteChecks=${match.totalEdgeChecksBruteForce}`);
