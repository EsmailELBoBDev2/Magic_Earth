import assert from 'node:assert/strict';
import {patchRouteRequestObject,eventToBanner,shouldShowBanner} from './payload/nav-core.mjs';
const enums={trafficAll:3,fastest:1,car:0,alternativesNever:2,departureHeadingDeg:91,departureHeadingAccuracyDeg:12,enableTerrainProfile:true,fastReroute:false};
let x={class:'RoutingService',method:'calculateRoute',args:{transportMode:0,prefs:{avoidTraffic:0,avoidUnpavedRoads:false,routeType:0,resultDetails:0,pathAlgorithm:0,truckProfile:{width:175},alternativesSchema:0,alternativeRoutesBalancedSorting:false,accurateTrackMatch:false,allowOnlineCalculation:false,automaticTimestamp:false,accurateWaypointsApproach:false,maximumDistanceConstraint:false,avoidTurnAroundInstruction:false,buildTerrainProfile:false,departureHeading:{heading:-1,accuracy:0}}}};
let r=patchRouteRequestObject(x,enums); assert.equal(r.changed,true); assert.equal(x.args.prefs.avoidTraffic,3); assert.equal(x.args.prefs.avoidUnpavedRoads,true); assert.equal(x.args.prefs.routeType,1); assert.equal(x.args.prefs.accurateWaypointsApproach,true); assert.equal(x.args.prefs.buildTerrainProfile,true); assert.equal(x.args.prefs.departureHeading.heading,91); assert.equal(x.args.prefs.departureHeading.accuracy,12);
// KISS: do not rewrite defaults/preferences that CairoDrive has no reason to own.
assert.equal(x.args.prefs.truckProfile.width,175); assert.equal(x.args.prefs.alternativesSchema,0); assert.equal(x.args.prefs.alternativeRoutesBalancedSorting,false); assert.equal(x.args.prefs.resultDetails,0); assert.equal(x.args.prefs.pathAlgorithm,0); assert.equal(x.args.prefs.accurateTrackMatch,false); assert.equal(x.args.prefs.allowOnlineCalculation,false); assert.equal(x.args.prefs.automaticTimestamp,false); assert.equal(x.args.prefs.maximumDistanceConstraint,false); assert.equal(x.args.prefs.avoidTurnAroundInstruction,false);

let online=structuredClone(x); online.args.prefs.allowOnlineCalculation=false; patchRouteRequestObject(online,{...enums,preferOnlineCalculation:true}); assert.equal(online.args.prefs.allowOnlineCalculation,true);
let rerouteOnline=structuredClone(x); rerouteOnline.args.prefs.allowOnlineCalculation=false; patchRouteRequestObject(rerouteOnline,{...enums,preferOnlineCalculation:false,enableTerrainProfile:false,fastReroute:true}); assert.equal(rerouteOnline.args.prefs.allowOnlineCalculation,false);
// Active-navigation fast-reroute mode strips terrain profile and asks for no alternative fan-out.
let y=structuredClone(x); y.args.prefs.buildTerrainProfile=true; y.args.prefs.alternativesSchema=0; patchRouteRequestObject(y,{...enums,enableTerrainProfile:false,fastReroute:true}); assert.equal(y.args.prefs.buildTerrainProfile,false); assert.equal(y.args.prefs.alternativesSchema,2);

// Dormant route-algorithm A/B mode: production leaves pathAlgorithm untouched;
// explicit experiment may request the target-supported ExternalCh enum.
let exp=structuredClone(x); exp.args.prefs.pathAlgorithm=0; patchRouteRequestObject(exp,{...enums,experimentalPathAlgorithmValue:1,experimentalPathAlgorithmName:'ExternalCh'}); assert.equal(exp.args.prefs.pathAlgorithm,1);

let scalar={class:'RoutingService',method:'calculateRoute',args:{transportMode:0,prefs:{departureHeading:-1,departureHeadingAccuracy:0}}}; patchRouteRequestObject(scalar,enums); assert.equal(scalar.args.prefs.departureHeading,91); assert.equal(scalar.args.prefs.departureHeadingAccuracy,12);
let bike={class:'RoutingService',method:'calculateRoute',args:{transportMode:2,prefs:{avoidTraffic:0}}}; assert.equal(patchRouteRequestObject(bike,enums).skipped,'non-car');
assert.equal(eventToBanner('TurnRight','').title.includes('RIGHT'),true); assert.equal(shouldShowBanner(500,2),true); assert.equal(shouldShowBanner(800,2),false);
console.log('nav-core selftest: PASS');
