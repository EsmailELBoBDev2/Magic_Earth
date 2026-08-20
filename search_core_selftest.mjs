import assert from 'node:assert/strict';
import {
  FIELD_MASK, DETAILS_FIELD_MASK, detailsFieldMaskForType, normalizeQuery, shouldCallGoogle, safeBias, buildTextSearchBody, buildNearbySearchBody, encodeGooglePolyline,
  magicLaneAddressFields, parsePlacesResponse, parsePlaceDetailsResponse, classifyGoogleFailure,
  insideEgyptBounds, buildRichPlaceMetadata, selectBestNavigationPoint, selectPreferredEntrance, openAtArrivalStatus,
  googleTypesForMagicCategory, magicGenericCategoryName, formatDistanceMeters, businessStatusLabel, NEARBY_SEARCH_URL,
  AUTOCOMPLETE_FIELD_MASK, buildAutocompleteBody, parseAutocompleteResponse
} from './payload/search-core.mjs';

assert.equal(FIELD_MASK.includes('*'), false);
assert.equal(FIELD_MASK.includes('places.currentOpeningHours'), false);
assert.equal(FIELD_MASK.includes('places.rating'), false);
assert.equal(DETAILS_FIELD_MASK.includes('currentOpeningHours'), true);
assert.equal(DETAILS_FIELD_MASK.includes('fuelOptions'), false);
assert.equal(detailsFieldMaskForType('gas_station').includes('fuelOptions'), true);
assert.equal(detailsFieldMaskForType('restaurant').includes('dineIn'), true);
assert.equal(detailsFieldMaskForType('medical_clinic').includes('dineIn'), false);
assert.equal(DETAILS_FIELD_MASK.includes('consumerAlert'), true);
assert.equal(DETAILS_FIELD_MASK.includes('regularOpeningHours'), false);
assert.equal(DETAILS_FIELD_MASK.includes('subDestinations'), false);
assert.equal(FIELD_MASK.includes('places.openingDate'), false);
assert.equal(DETAILS_FIELD_MASK.includes('evChargeOptions'), false);
assert.equal(shouldCallGoogle('ab'), false);
assert.equal(shouldCallGoogle('abc'), true);
assert.equal(shouldCallGoogle('KFC!'), true);
assert.equal(normalizeQuery('   American   Veterinary Center   '), 'American Veterinary Center');
assert.equal(Array.from(normalizeQuery('x'.repeat(300))).length, 160);
assert.deepEqual(safeBias({latitude: 999, longitude: 999}), {latitude:30.0444, longitude:31.2357});
const body = buildTextSearchBody('صيدلية', {latitude:30.1, longitude:31.2}, 999999);
assert.equal(body.languageCode, 'ar');
assert.equal(body.pageSize, 20);
assert.equal(body.locationBias.circle.radius, 50000);
assert.equal(insideEgyptBounds(30.0444,31.2357),true);
assert.equal(insideEgyptBounds(25.2048,55.2708),false);

assert.equal(NEARBY_SEARCH_URL,'https://places.googleapis.com/v1/places:searchNearby');
assert.equal(magicGenericCategoryName(1000),'Gas Stations');
assert.deepEqual(googleTypesForMagicCategory(1000),['gas_station']);
assert.ok(googleTypesForMagicCategory(1002).includes('restaurant'));
assert.ok(googleTypesForMagicCategory(1004).includes('veterinary_care'));
assert.ok(googleTypesForMagicCategory(1005).includes('store')); // broad Shopping must not miss specialist stores
assert.ok(googleTypesForMagicCategory(1007).includes('airport'));
assert.ok(googleTypesForMagicCategory(1001).includes('park_and_ride'));
assert.deepEqual(googleTypesForMagicCategory(1019),[]); // no fake hydrant mapping
assert.deepEqual(googleTypesForMagicCategory(55555,'Parking Garage'),['parking_garage']);
assert.deepEqual(googleTypesForMagicCategory(55555,'Mystery emergency structure'),[]);
const nb=buildNearbySearchBody(googleTypesForMagicCategory(1002),{latitude:30.0444,longitude:31.2357},25000,'en',{routingSummaries:true});
assert.equal(nb.rankPreference,'DISTANCE');
assert.equal(nb.maxResultCount,20);
assert.equal(nb.locationRestriction.circle.radius,25000);
assert.ok(nb.includedTypes.includes('cafe'));
assert.equal(nb.routingParameters.origin.latitude,30.0444);
assert.equal(nb.routingParameters.travelMode,'DRIVE');
assert.equal(nb.routingParameters.routingPreference,'TRAFFIC_AWARE');
const nbCasual=buildNearbySearchBody(googleTypesForMagicCategory(1002),{latitude:30.0444,longitude:31.2357},25000,'en');
assert.equal('routingParameters' in nbCasual,false);
assert.equal(formatDistanceMeters(450),'450 m');
assert.equal(formatDistanceMeters(1250),'1.3 km');
assert.equal(businessStatusLabel({businessStatus:'CLOSED_TEMPORARILY'}),'TEMPORARILY CLOSED ⚠');
assert.match(businessStatusLabel({businessStatus:'CLOSED_PERMANENTLY',movedPlaceId:'new-id'}),/MOVED/);

assert.equal(AUTOCOMPLETE_FIELD_MASK.includes('*'), false);
const acBody=buildAutocompleteBody('امريكان فيت',{latitude:30.1,longitude:31.3},'session-123',20000);
assert.equal(acBody.sessionToken,'session-123');
assert.equal(acBody.languageCode,'ar');
assert.deepEqual(acBody.includedRegionCodes,['EG']);
assert.equal(acBody.locationBias.circle.radius,20000);
const preds=parseAutocompleteResponse({suggestions:[
  {placePrediction:{placeId:'p1',text:{text:'American Veterinary Center, Cairo'},structuredFormat:{mainText:{text:'American Veterinary Center'},secondaryText:{text:'Cairo'}},types:['veterinary_care'],distanceMeters:1200}},
  {queryPrediction:{text:{text:'not a place'}}}
]});
assert.equal(preds.length,1); assert.equal(preds[0].placeId,'p1'); assert.equal(preds[0].mainText,'American Veterinary Center'); assert.equal(preds[0].distanceMeters,1200);

const fields = magicLaneAddressFields([
  {types:['street_number'], longText:'63'},
  {types:['route'], longText:'Sayed Darwish St'},
  {types:['locality'], longText:'Cairo'},
  {types:['country'], longText:'Egypt', shortText:'EG'}
], '63 Sayed Darwish St, Cairo, Egypt');
assert.equal(fields[5], 'Sayed Darwish St');
assert.equal(fields[6], '63');
assert.equal(fields[9], 'Cairo');
assert.equal(fields[14], 'EG');

const parsed = parsePlacesResponse({places:[
  {id:'A',displayName:{text:'Clinic'},formattedAddress:'A',addressComponents:[{types:['country'],shortText:'EG'}],location:{latitude:30,longitude:31},businessStatus:'OPERATIONAL'},
  {id:'A',displayName:{text:'Clinic'},formattedAddress:'A',location:{latitude:30,longitude:31}},
  {id:'B',displayName:{text:'Closed'},location:{latitude:30,longitude:31},businessStatus:'CLOSED_PERMANENTLY'},
  {id:'C',displayName:{text:'No coordinate'}},
  {id:'D',displayName:{text:'Dubai'},addressComponents:[{types:['country'],shortText:'AE'}],location:{latitude:25.2,longitude:55.3}}
]});
assert.equal(parsed.length, 1);
assert.equal(parsed[0].placeId, 'A');
assert.equal(parsed[0].richLoaded,false);
assert.ok(parsed[0].extraInfoLines.some(x=>x.includes('Google Maps')));
const movedParsed=parsePlacesResponse({places:[
  {id:'old',movedPlaceId:'new',businessStatus:'CLOSED_PERMANENTLY',displayName:{text:'Moved Clinic'},addressComponents:[{types:['country'],shortText:'EG'}],location:{latitude:30,longitude:31}},
  {id:'dead',businessStatus:'CLOSED_PERMANENTLY',displayName:{text:'Dead Shop'},addressComponents:[{types:['country'],shortText:'EG'}],location:{latitude:30.1,longitude:31.1}}
]});
assert.equal(movedParsed.length,1);assert.equal(movedParsed[0].placeId,'new');assert.match(movedParsed[0].description,/MOVED/);

const nav=selectBestNavigationPoint([
  {location:{latitude:30.001,longitude:31.001},travelModes:['DRIVE'],usages:['PARKING']},
  {location:{latitude:30.002,longitude:31.002},travelModes:['DRIVE'],usages:['DROPOFF'],displayName:{text:'Main Gate'}}
]);
assert.equal(nav.latitude,30.002);
assert.equal(nav.displayName,'Main Gate');

const entrance=selectPreferredEntrance([
  {location:{latitude:30.01,longitude:31.01},tags:['TAG_UNSPECIFIED']},
  {location:{latitude:30.02,longitude:31.02},tags:['PREFERRED']}
]);
assert.equal(entrance.latitude,30.02);
assert.equal(selectPreferredEntrance([
  {location:{latitude:30.02,longitude:31.02},tags:['PREFERRED']},
  {location:{latitude:30.03,longitude:31.03},tags:['PREFERRED']}
]),null);

const richBody={
  id:'A',displayName:{text:'Restaurant'},formattedAddress:'Cairo',
  addressComponents:[{types:['country'],shortText:'EG'}],location:{latitude:30,longitude:31},
  primaryTypeDisplayName:{text:'Restaurant'},
  currentOpeningHours:{openNow:true,periods:[{open:{day:4,hour:10,minute:0},close:{day:4,hour:23,minute:0}}],weekdayDescriptions:['Thursday: 10:00 AM – 11:00 PM']},
  rating:4.6,userRatingCount:123,
  internationalPhoneNumber:'+20 2 1234 5678',websiteUri:'https://example.com',
  parkingOptions:{freeParkingLot:true},paymentOptions:{acceptsCreditCards:true,acceptsNfc:true},
  dineIn:true,takeout:true,goodForGroups:true,utcOffsetMinutes:180,
  navigationPoints:[{location:{latitude:30.0002,longitude:31.0003},travelModes:['DRIVE'],usages:['DROPOFF'],displayName:{text:'Vehicle entrance'}}],
  attributions:[{providerDisplayName:{text:'Provider X'},providerUri:'https://example.invalid'}],
  consumerAlert:{overview:'Suspicious review activity detected'}
};
const rich=parsePlaceDetailsResponse(richBody,{placeId:'A'});
assert.equal(rich.richLoaded,true);
assert.equal(rich.latitude,30.0002);
assert.match(rich.description,/Restaurant/);
assert.match(rich.description,/4\.6/);
assert.ok(rich.extraInfoLines.some(x=>x.includes('Parking')));
assert.ok(rich.extraInfoLines.some(x=>x.includes('Payments')));
assert.ok(rich.extraInfoLines.some(x=>x.includes('Attribution')));
assert.ok(rich.extraInfoLines.some(x=>x.includes('consumer alert')));
assert.match(rich.description,/Suspicious review activity/);

const entranceOnly=parsePlaceDetailsResponse({
  id:'E',displayName:{text:'Mall'},formattedAddress:'Cairo',
  addressComponents:[{types:['country'],shortText:'EG'}],location:{latitude:30,longitude:31},
  entrances:[{location:{latitude:30.0007,longitude:31.0008},tags:['PREFERRED']}]
},{placeId:'E'});
assert.equal(entranceOnly.arrivalPointKind,'preferred-entrance');
assert.equal(entranceOnly.latitude,30.0007);
assert.ok(entranceOnly.extraInfoLines.some(x=>x.includes('Preferred entrance')));

// Thursday 20 Aug 2026 17:00 UTC = 20:00 Cairo at UTC+3; +1h remains open, +4h closes.
const thursday1700=Date.UTC(2026,7,20,17,0,0);
assert.equal(openAtArrivalStatus(rich,3600,thursday1700),'OPEN WHEN YOU ARRIVE ✓');
assert.equal(openAtArrivalStatus(rich,4*3600,thursday1700),'LIKELY CLOSED AT ARRIVAL ⚠');

assert.equal(classifyGoogleFailure(403,'{"error":{"status":"PERMISSION_DENIED","message":"bad restriction"}}').kind,'auth');
assert.equal(classifyGoogleFailure(429,'{"error":{"status":"RESOURCE_EXHAUSTED"}}').cooldownMs,60000);
assert.equal(classifyGoogleFailure(503,'').cooldownMs,15000);
assert.equal(classifyGoogleFailure(400,'').cooldownMs,5000);

const ep=encodeGooglePolyline([{latitude:38.5,longitude:-120.2},{latitude:40.7,longitude:-120.95},{latitude:43.252,longitude:-126.453}]); assert.equal(ep,'_p~iF~ps|U_ulLnnqC_mqNvxq`@');
const sar=buildTextSearchBody('gas station',{latitude:30.04,longitude:31.23},25000,{searchAlongRouteEncoded:ep,routingOrigin:{latitude:30.04,longitude:31.23}}); assert.equal(sar.searchAlongRouteParameters.polyline.encodedPolyline,ep); assert.equal(!!sar.locationBias,false); assert.equal(sar.routingParameters.origin.latitude,30.04); assert.equal(sar.routingParameters.travelMode,'DRIVE'); assert.equal(sar.routingParameters.routingPreference,'TRAFFIC_AWARE');

const sarParsed=parsePlacesResponse(JSON.stringify({places:[
  {id:'p1',displayName:{text:'Fuel farther'},formattedAddress:'Cairo, Egypt',addressComponents:[{longText:'Egypt',shortText:'EG',types:['country']}],location:{latitude:30.05,longitude:31.24}},
  {id:'p2',displayName:{text:'Fuel lower detour'},formattedAddress:'Cairo, Egypt',addressComponents:[{longText:'Egypt',shortText:'EG',types:['country']}],location:{latitude:30.06,longitude:31.25}}
],routingSummaries:[
  {legs:[{duration:'420s',distanceMeters:3500},{duration:'900s',distanceMeters:12000}]},
  {legs:[{duration:'500s',distanceMeters:4000},{duration:'700s',distanceMeters:10000}]}
]}));
assert.equal(sarParsed.length,2);assert.equal(sarParsed[0].placeId,'p2');assert.equal(sarParsed[0].routingSummary.toPlaceDurationSeconds,500);assert.equal(sarParsed[1].routingSummary.toPlaceDurationSeconds,420);assert.match(sarParsed[1].description,/Along route: 7 min .*to stop.*15 min .*onward/);

const nearbyParsed=parsePlacesResponse({places:[
  {id:'n1',displayName:{text:'Closer by road'},formattedAddress:'Cairo, Egypt',addressComponents:[{shortText:'EG',types:['country']}],location:{latitude:30.05,longitude:31.24}},
  {id:'n2',displayName:{text:'Faster by road'},formattedAddress:'Cairo, Egypt',addressComponents:[{shortText:'EG',types:['country']}],location:{latitude:30.06,longitude:31.25}}
],routingSummaries:[
  {legs:[{duration:'600s',distanceMeters:4000}]},
  {legs:[{duration:'300s',distanceMeters:5500}]}
]});
assert.equal(nearbyParsed[0].placeId,'n2');
assert.match(nearbyParsed[0].description,/Drive: 5 min .*5\.5 km/);

console.log('search-core selftest: PASS');
