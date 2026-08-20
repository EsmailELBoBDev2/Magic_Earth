export const SEARCH_FIELD_MASK = [
  // Search results stay deliberately lean. Rich/expensive visit-planning data is
  // fetched only for the one Google landmark the user actually selects.
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.businessStatus',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.plusCode',
  'places.pureServiceAreaBusiness',
  'places.movedPlaceId',
  'places.attributions'
].join(',');

// Selected-place Details is adaptive. The base mask contains navigation/contact
// data useful for almost every destination; Enterprise+Atmosphere lifestyle data
// is requested only when the selected Google primaryType can actually use it.
export const DETAILS_BASE_FIELDS = [
  'id','displayName','formattedAddress','addressComponents','location','businessStatus',
  'primaryType','primaryTypeDisplayName','plusCode','openingDate','pureServiceAreaBusiness',
  'currentOpeningHours','nationalPhoneNumber','internationalPhoneNumber','websiteUri',
  'rating','userRatingCount','accessibilityOptions','utcOffsetMinutes',
  'navigationPoints','entrances','attributions','movedPlaceId','consumerAlert'
];
const DETAILS_FOOD_FIELDS = [
  'currentSecondaryOpeningHours','priceLevel','priceRange','parkingOptions','paymentOptions',
  'reservable','delivery','takeout','dineIn','curbsidePickup','outdoorSeating','restroom',
  'goodForChildren','goodForGroups','allowsDogs','liveMusic','servesBreakfast','servesLunch',
  'servesDinner','servesCoffee','servesDessert','servesVegetarianFood'
];
const DETAILS_FUEL_FIELDS = ['fuelOptions','parkingOptions','paymentOptions','restroom'];
const DETAILS_PARKING_FIELDS = ['parkingOptions','paymentOptions'];
const DETAILS_LODGING_FIELDS = ['priceLevel','priceRange','parkingOptions','paymentOptions','allowsDogs'];
export function detailsFieldMaskForType(primaryType='') {
  const t=String(primaryType||'').toLowerCase();
  const out=[...DETAILS_BASE_FIELDS];
  if(/restaurant|cafe|coffee|bakery|bar|food|meal|dessert|ice_cream/.test(t)) out.push(...DETAILS_FOOD_FIELDS);
  else if(/gas_station|petrol|fuel/.test(t)) out.push(...DETAILS_FUEL_FIELDS);
  else if(/parking/.test(t)) out.push(...DETAILS_PARKING_FIELDS);
  else if(/hotel|hostel|motel|lodging|guest_house|bed_and_breakfast/.test(t)) out.push(...DETAILS_LODGING_FIELDS);
  return [...new Set(out)].join(',');
}
// Compatibility export: callers without a type hint receive the lean universal mask.
export const DETAILS_FIELD_MASK = detailsFieldMaskForType('');

// Compatibility export used by older builder/verifier code. It intentionally
// points at the lean search mask, not the rich Details mask.
export const FIELD_MASK = SEARCH_FIELD_MASK;

export const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
export const NEARBY_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';

// Magic Lane's stable generic category IDs. Only categories with a real Google
// Table-A equivalent use Nearby Search; ambiguous categories deliberately fall
// back to Text Search instead of inventing a semantically wrong mapping.
export const MAGIC_GENERIC_CATEGORY_NAMES = Object.freeze({
  1000:'Gas Stations',1001:'Parking',1002:'Food and Drink',1003:'Accommodation',
  1004:'Medical Services',1005:'Shopping',1006:'Car Services',1007:'Public Transport',
  1008:'Wikipedia',1009:'Education',1010:'Entertainment',1011:'Public Services',
  1012:'Geographical Area',1013:'Business',1014:'Sightseeing',1015:'Religious Places',
  1016:'Roadside',1017:'Sports',1018:'Points of Interest',1019:'Hydrants',
  1020:'Emergency Services Support',1021:'Civil Emergency Infrastructure',
  1022:'Charging Stations',1023:'Bicycle Charging Stations',1024:'Bicycle Parking'
});

export const MAGIC_GENERIC_CATEGORY_TYPES = Object.freeze({
  1000:['gas_station'],
  1001:['parking','parking_garage','parking_lot','park_and_ride','truck_stop','rv_park'],
  1002:['restaurant','cafe','coffee_shop','bakery','fast_food_restaurant','bar'],
  1003:['hotel','lodging','hostel','motel','guest_house','resort_hotel','bed_and_breakfast','inn','campground','camping_cabin','cottage','extended_stay_hotel','farmstay','private_guest_room','rv_park'],
  1004:['hospital','general_hospital','medical_center','medical_clinic','doctor','pharmacy','drugstore','dentist','dental_clinic','medical_lab','veterinary_care','chiropractor','physiotherapist'],
  1005:['store','shopping_mall','market','supermarket','grocery_store','food_store','convenience_store','department_store','clothing_store','electronics_store','book_store','hardware_store','home_goods_store','home_improvement_store','furniture_store','shoe_store','sporting_goods_store','pet_store','jewelry_store','gift_shop','bicycle_store'],
  1006:['car_repair','car_wash','tire_shop','car_dealer','car_rental','auto_parts_store'],
  1007:['transit_station','transit_stop','transit_depot','train_station','bus_station','bus_stop','subway_station','light_rail_station','tram_stop','taxi_stand','taxi_service','ferry_terminal','ferry_service','airport','international_airport','park_and_ride'],
  1009:['educational_institution','academic_department','research_institute','library','preschool','primary_school','school','secondary_school','university'],
  1010:['movie_theater','amusement_center','amusement_park','bowling_alley','night_club','aquarium','zoo','event_venue','concert_hall','performing_arts_theater','community_center','cultural_center','convention_center'],
  1011:['government_office','local_government_office','city_hall','courthouse','post_office','police','fire_station','embassy'],
  1013:['business_center','corporate_office','coworking_space'],
  1014:['tourist_attraction','museum','cultural_landmark','historical_place','historical_landmark','monument','art_gallery','scenic_spot','observation_deck','castle','fountain','sculpture','botanical_garden','park','national_park'],
  1015:['church','mosque','synagogue','hindu_temple','buddhist_temple'],
  1016:['rest_stop','truck_stop','gas_station','parking','park_and_ride','toll_station'],
  1017:['sports_activity_location','gym','fitness_center','sports_club','sports_complex','stadium','arena','swimming_pool','athletic_field','golf_course','playground','tennis_court','ice_skating_rink','race_course'],
  1022:['electric_vehicle_charging_station'],
  1023:['ebike_charging_station']
});

export function magicGenericCategoryName(categoryId) {
  return MAGIC_GENERIC_CATEGORY_NAMES[Math.trunc(Number(categoryId))] || '';
}

export function googleTypesForMagicCategory(categoryId, categoryName='') {
  const v=MAGIC_GENERIC_CATEGORY_TYPES[Math.trunc(Number(categoryId))];
  if(Array.isArray(v))return v.slice();
  // POI subcategory IDs are not stable generic IDs. When Magic Lane gives us a
  // clear category name, use a conservative Table-A mapping; ambiguous names
  // return [] and therefore retain the safer Text Search fallback.
  const n=String(categoryName||'').toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
  const rules=[
    [/gas station|petrol station|fuel station/,['gas_station']],
    [/parking garage/,['parking_garage']],[/parking lot/,['parking_lot']],[/park and ride/,['park_and_ride']],[/truck stop/,['truck_stop']],
    [/pharmacy/,['pharmacy']],[/hospital/,['hospital']],[/medical clinic|clinic/,['medical_clinic']],[/dentist|dental/,['dentist']],[/veterinary|\bvet\b/,['veterinary_care']],
    [/restaurant/,['restaurant']],[/coffee shop/,['coffee_shop']],[/cafe|café/,['cafe']],[/bakery/,['bakery']],[/fast food/,['fast_food_restaurant']],
    [/hotel/,['hotel']],[/hostel/,['hostel']],[/motel/,['motel']],[/guest house/,['guest_house']],
    [/shopping mall|mall/,['shopping_mall']],[/supermarket/,['supermarket']],[/grocery/,['grocery_store']],[/convenience store/,['convenience_store']],
    [/car repair|auto repair/,['car_repair']],[/car wash/,['car_wash']],[/tire|tyre/,['tire_shop']],[/car rental/,['car_rental']],
    [/train station/,['train_station']],[/bus station/,['bus_station']],[/bus stop/,['bus_stop']],[/subway|metro station/,['subway_station']],[/taxi stand/,['taxi_stand']],[/ferry terminal/,['ferry_terminal']],
    [/university/,['university']],[/school/,['school']],[/library/,['library']],
    [/movie theater|cinema/,['movie_theater']],[/museum/,['museum']],[/tourist attraction/,['tourist_attraction']],[/amusement park/,['amusement_park']],
    [/courthouse/,['courthouse']],[/post office/,['post_office']],[/police/,['police']],[/fire station/,['fire_station']],
    [/mosque/,['mosque']],[/church/,['church']],[/synagogue/,['synagogue']],
    [/gym|fitness/,['gym']],[/stadium/,['stadium']],[/swimming pool/,['swimming_pool']],
    [/charging station/,['electric_vehicle_charging_station']]
  ];
  for(const [re,types] of rules)if(re.test(n))return types.slice();
  return [];
}

export function buildNearbySearchBody(types, bias, radiusMeters=25000, languageCode='en', options={}) {
  const b=safeBias(bias), r=Math.min(50000,Math.max(250,Number(radiusMeters)||25000));
  const includedTypes=[...new Set((Array.isArray(types)?types:[]).map(x=>String(x||'').trim()).filter(Boolean))].slice(0,50);
  if(!includedTypes.length)throw new Error('Nearby Search requires at least one included type');
  const body={
    includedTypes,
    maxResultCount:MAX_RESULTS,
    rankPreference:'DISTANCE',
    languageCode:String(languageCode||'en'),
    regionCode:'EG',
    locationRestriction:{circle:{center:{latitude:b.latitude,longitude:b.longitude},radius:r}}
  };
  // Routing summaries are valuable while actively driving, but they elevate the
  // request to Google's Enterprise + Atmosphere SKU. Casual category browsing
  // stays distance-ranked and cheaper; active navigation gets traffic-aware ETA.
  if(options&&options.routingSummaries===true){
    body.routingParameters={origin:{latitude:b.latitude,longitude:b.longitude},travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE'};
  }
  return body;
}
export const MAX_RESULTS = 20;
export const MIN_QUERY_CODEPOINTS = 3;
export const MAX_QUERY_CODEPOINTS = 160;

export function isArabic(cp) {
  return (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff);
}

export function inferLang(q) {
  for (const ch of String(q || '')) if (isArabic(ch.codePointAt(0))) return 'ar';
  return 'en';
}

export function normalizeQuery(q) {
  return Array.from(String(q || '').trim().replace(/\s+/g, ' '))
    .slice(0, MAX_QUERY_CODEPOINTS).join('');
}

export function shouldCallGoogle(q) {
  return Array.from(normalizeQuery(q)).length >= MIN_QUERY_CODEPOINTS;
}

export function validCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function safeBias(bias, fallback = { latitude: 30.0444, longitude: 31.2357 }) {
  const lat = Number(bias && bias.latitude);
  const lon = Number(bias && bias.longitude);
  if (validCoordinate(lat, lon)) return { latitude: lat, longitude: lon };
  if (!fallback) return null;
  return { latitude: fallback.latitude, longitude: fallback.longitude };
}

export function encodeGooglePolyline(points) {
  let lastLat=0,lastLon=0,out='';
  const enc=n=>{let v=n<0?~(n<<1):(n<<1),s='';while(v>=0x20){s+=String.fromCharCode((0x20|(v&0x1f))+63);v>>=5;}return s+String.fromCharCode(v+63);};
  for(const p of Array.isArray(points)?points:[]){
    const lat=Number(p&&p.latitude),lon=Number(p&&p.longitude);if(!validCoordinate(lat,lon))continue;
    const ilat=Math.round(lat*1e5),ilon=Math.round(lon*1e5);out+=enc(ilat-lastLat)+enc(ilon-lastLon);lastLat=ilat;lastLon=ilon;
  }
  return out;
}

export function buildTextSearchBody(query, bias, radiusMeters = 50000, options = {}) {
  const q = normalizeQuery(query);
  const b = safeBias(bias);
  const r = Math.min(50000, Math.max(1000, Number(radiusMeters) || 50000));
  const body={textQuery:q,languageCode:inferLang(q),regionCode:'EG',pageSize:MAX_RESULTS};
  const encoded=String(options&&options.searchAlongRouteEncoded||'').trim();
  if(encoded){
    body.searchAlongRouteParameters={polyline:{encodedPolyline:encoded}};
    const origin=options&&options.routingOrigin;
    body.routingParameters={travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE'};
    if(origin&&validCoordinate(Number(origin.latitude),Number(origin.longitude))){
      body.routingParameters.origin={latitude:Number(origin.latitude),longitude:Number(origin.longitude)};
    }
  }else{
    body.locationBias={circle:{center:{latitude:b.latitude,longitude:b.longitude},radius:r}};
  }
  return body;
}

function component(comps, type) {
  for (const c of comps || []) {
    if (c && Array.isArray(c.types) && c.types.includes(type)) return c;
  }
  return null;
}
function longText(comps, type) {
  const c = component(comps, type);
  return c && c.longText ? String(c.longText) : '';
}
function shortText(comps, type) {
  const c = component(comps, type);
  return c && c.shortText ? String(c.shortText) : '';
}
function firstLong(comps, types) {
  for (const t of types) {
    const v = longText(comps, t);
    if (v) return v;
  }
  return '';
}


export function insideEgyptBounds(lat, lon) {
  const a=Number(lat), b=Number(lon);
  // Broad national bounding box including Sinai and the south-eastern border area.
  // It is only a fail-safe when Google's country component is absent.
  return Number.isFinite(a) && Number.isFinite(b) && a >= 21.70 && a <= 31.85 && b >= 24.65 && b <= 37.10;
}

export function plausibleStreetNumber(v) {
  const s = String(v || '').trim();
  return !!s && s.length <= 20 && /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(s);
}

export function magicLaneAddressFields(addressComponents, formattedAddress) {
  const comps = Array.isArray(addressComponents) ? addressComponents : [];
  const fields = new Array(20).fill('');
  fields[2] = firstLong(comps, ['premise']);
  fields[3] = firstLong(comps, ['subpremise']);
  fields[5] = firstLong(comps, ['route']);
  fields[6] = firstLong(comps, ['street_number']);
  if (fields[6] && !plausibleStreetNumber(fields[6])) fields[6] = '';
  fields[7] = firstLong(comps, ['postal_code']);
  fields[8] = firstLong(comps, ['sublocality_level_1', 'sublocality', 'neighborhood']);
  fields[9] = firstLong(comps, ['locality', 'postal_town']);
  fields[10] = firstLong(comps, ['administrative_area_level_2']);
  fields[11] = firstLong(comps, ['administrative_area_level_1']);
  fields[12] = shortText(comps, 'administrative_area_level_1');
  fields[13] = firstLong(comps, ['country']);
  fields[14] = shortText(comps, 'country').toUpperCase();
  fields[15] = firstLong(comps, ['neighborhood', 'sublocality_level_2', 'sublocality_level_1']);
  if (![5,8,9,10,11,15].some(i => fields[i])) fields[5] = String(formattedAddress || '');
  return fields;
}

export function haversineMeters(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.latitude), lon1 = Number(a.longitude), lat2 = Number(b.latitude), lon2 = Number(b.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371000, d2r = Math.PI / 180;
  const dlat = (lat2 - lat1) * d2r, dlon = (lon2 - lon1) * d2r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function normalizeName(s) {
  let t = String(s || '').toLocaleLowerCase();
  try { t = t.normalize('NFKD'); } catch (_) {}
  t = t.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '');
  t = t.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  return t.replace(/[^0-9a-z\u0600-\u06ff]+/gi, ' ').replace(/\s+/g, ' ').trim();
}


function textValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && typeof v.text === 'string') return v.text.trim();
  return '';
}

function boolLines(obj, mapping) {
  const out=[];
  for (const [key,label] of mapping) if (obj && obj[key] === true) out.push(label);
  return out;
}

function weekdayLines(hours) {
  const a = hours && Array.isArray(hours.weekdayDescriptions) ? hours.weekdayDescriptions : [];
  return a.map(x=>String(x||'').trim()).filter(Boolean).slice(0,7);
}

function currentOpenState(hours) {
  if (!hours || typeof hours !== 'object') return '';
  if (hours.openNow === true) return 'Open now';
  if (hours.openNow === false) return 'Closed now';
  return '';
}

function moneyText(m) {
  if (!m || typeof m !== 'object') return '';
  const currency=String(m.currencyCode||'').trim();
  const units=Number(m.units||0), nanos=Number(m.nanos||0);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return '';
  const value=units+nanos/1e9;
  return `${value.toFixed(Number.isInteger(value)?0:2)}${currency?' '+currency:''}`;
}

function priceRangeText(r) {
  if (!r || typeof r !== 'object') return '';
  const a=moneyText(r.startPrice), b=moneyText(r.endPrice);
  if (a && b) return `${a}–${b}`;
  return a || b;
}

function fuelLines(fuelOptions) {
  const prices=fuelOptions && Array.isArray(fuelOptions.fuelPrices) ? fuelOptions.fuelPrices : [];
  const out=[];
  for (const f of prices.slice(0,10)) {
    const kind=String(f && f.type || '').replace(/^FUEL_TYPE_/,'').replaceAll('_',' ').trim();
    const price=moneyText(f && f.price);
    if (kind && price) out.push(`${kind}: ${price}`);
  }
  return out;
}


function attributionTexts(v) {
  const out=[];
  for (const a of Array.isArray(v) ? v : []) {
    if (!a) continue;
    const name=textValue(a.providerDisplayName)||textValue(a.displayName)||textValue(a.provider)||textValue(a.name);
    const uri=textValue(a.providerUri)||textValue(a.uri);
    if (name) out.push(uri ? `${name} (${uri})` : name);
  }
  return [...new Set(out)].slice(0,8);
}

export function selectBestNavigationPoint(points) {
  let best=null;
  for (const p of Array.isArray(points) ? points : []) {
    const loc=p&&p.location||{};
    const lat=Number(loc.latitude), lon=Number(loc.longitude);
    if(!validCoordinate(lat,lon)) continue;
    const modes=(Array.isArray(p.travelModes)?p.travelModes:[]).map(x=>String(x).toUpperCase());
    if(modes.length && !modes.some(x=>x.includes('DRIVE'))) continue;
    const usages=(Array.isArray(p.usages)?p.usages:[]).map(x=>String(x).toUpperCase());
    let score=100;
    if(modes.some(x=>x.includes('DRIVE')))score+=30;
    if(usages.some(x=>x.includes('DROPOFF')))score+=25;
    if(usages.some(x=>x.includes('PICKUP')))score+=8;
    if(usages.some(x=>x.includes('PARKING')))score-=8;
    if(!usages.length)score+=12;
    const name=textValue(p.displayName);
    const candidate={latitude:lat,longitude:lon,score,displayName:name,usages,travelModes:modes,token:String(p.navigationPointToken||'')};
    if(!best||candidate.score>best.score)best=candidate;
  }
  return best;
}


export function selectPreferredEntrance(entrances) {
  const preferred=[];
  for(const e of Array.isArray(entrances)?entrances:[]){
    const loc=e&&e.location||{}, lat=Number(loc.latitude), lon=Number(loc.longitude);
    if(!validCoordinate(lat,lon))continue;
    const tags=(Array.isArray(e&&e.tags)?e.tags:[]).map(x=>String(x).toUpperCase());
    if(tags.includes('PREFERRED'))preferred.push({latitude:lat,longitude:lon,tags});
  }
  // Google explicitly allows more than one preferred entrance. Choosing among
  // several without route/side-of-road evidence would be guessing, so only use
  // it as a destination fallback when Google provides exactly one.
  return preferred.length===1?preferred[0]:null;
}

export function formatDistanceMeters(v) {
  const m=Number(v); if(!Number.isFinite(m)||m<0)return '';
  if(m<1000)return `${Math.round(m)} m`;
  return `${(m/1000).toFixed(m<10000?1:0)} km`;
}

function pointWeeklyMinute(pt) {
  if(!pt||typeof pt!=='object')return null;
  const day=Number(pt.day), hour=Number(pt.hour||0), minute=Number(pt.minute||0);
  if(!Number.isFinite(day)||day<0||day>6||!Number.isFinite(hour)||!Number.isFinite(minute))return null;
  return day*1440+hour*60+minute;
}
function pointEpochMs(pt, offsetMinutes) {
  const d=pt&&pt.date;
  if(!d||typeof d!=='object')return null;
  const y=Number(d.year),m=Number(d.month),day=Number(d.day),h=Number(pt.hour||0),mi=Number(pt.minute||0);
  if(![y,m,day,h,mi].every(Number.isFinite)||y<1970||m<1||m>12||day<1||day>31)return null;
  return Date.UTC(y,m-1,day,h,mi)-Number(offsetMinutes||0)*60000;
}

export function openAtArrivalStatus(place, etaSeconds, nowMs=Date.now()) {
  const eta=Number(etaSeconds);
  if(!Number.isFinite(eta)||eta<0)return '';
  const hours=place&&place.currentOpeningHours;
  const periods=hours&&Array.isArray(hours.periods)?hours.periods:[];
  if(!periods.length)return '';
  const offset=Number.isFinite(Number(place&&place.utcOffsetMinutes))?Number(place.utcOffsetMinutes):120;
  const target=Number(nowMs)+eta*1000;
  for(const period of periods){
    const o=period&&period.open, c=period&&period.close;
    const oe=pointEpochMs(o,offset), ce=pointEpochMs(c,offset);
    if(oe!==null){
      if(ce===null && target>=oe)return 'OPEN WHEN YOU ARRIVE ✓';
      if(ce!==null && target>=oe && target<ce)return 'OPEN WHEN YOU ARRIVE ✓';
      continue;
    }
    let ow=pointWeeklyMinute(o), cw=pointWeeklyMinute(c);
    if(ow===null)continue;
    if(cw===null)return 'OPEN WHEN YOU ARRIVE ✓';
    if(cw<=ow)cw+=7*1440;
    const local=new Date(target+offset*60000);
    let tw=local.getUTCDay()*1440+local.getUTCHours()*60+local.getUTCMinutes();
    if(tw<ow)tw+=7*1440;
    if(tw>=ow&&tw<cw)return 'OPEN WHEN YOU ARRIVE ✓';
  }
  return 'LIKELY CLOSED AT ARRIVAL ⚠';
}

export function businessStatusLabel(p) {
  const status=String(p&&p.businessStatus||'').toUpperCase();
  const moved=String(p&&p.movedPlaceId||'').trim();
  if(status==='CLOSED_PERMANENTLY'&&moved)return 'MOVED — current Google location resolves on selection';
  if(status==='CLOSED_TEMPORARILY')return 'TEMPORARILY CLOSED ⚠';
  if(status==='FUTURE_OPENING')return 'OPENS IN THE FUTURE';
  if(status==='CLOSED_PERMANENTLY')return 'PERMANENTLY CLOSED';
  return '';
}

export function buildBasicPlaceMetadata(p) {
  const extra=['Source: Google Maps'];
  const primaryType=textValue(p&&p.primaryTypeDisplayName)||String(p&&p.primaryType||'').replaceAll('_',' ');
  const businessStatus=businessStatusLabel(p);
  if(primaryType)extra.push(`Category: ${primaryType}`);
  if(businessStatus)extra.push(businessStatus);
  const plusCode=String(p&&p.plusCode&&(p.plusCode.globalCode||p.plusCode.compoundCode)||'').trim();
  if(plusCode)extra.push(`Plus Code: ${plusCode}`);
  if(p&&p.pureServiceAreaBusiness===true)extra.push('Service-area business — no guaranteed customer-facing storefront');
  for(const a of attributionTexts(p&&p.attributions))extra.push(`Attribution: ${a}`);
  return {description:[businessStatus,primaryType,'Google Maps'].filter(Boolean).join('\n'),extraInfoLines:extra,phone:'',website:'',primaryType,rawPrimaryType:String(p&&p.primaryType||''),openState:'',richLoaded:false};
}

export function parsePlaceDetailsResponse(body, fallback={}) {
  const p=typeof body==='string'?JSON.parse(body||'{}'):(body||{});
  const centerLat=Number(p.location&&p.location.latitude), centerLon=Number(p.location&&p.location.longitude);
  const nav=selectBestNavigationPoint(p.navigationPoints);
  const entrance=selectPreferredEntrance(p.entrances);
  const arrival=nav||entrance;
  const lat=arrival?arrival.latitude:centerLat, lon=arrival?arrival.longitude:centerLon;
  if(!validCoordinate(lat,lon))return null;
  const country=shortText(Array.isArray(p.addressComponents)?p.addressComponents:[],'country').toUpperCase();
  if((country&&country!=='EG')||(!country&&!insideEgyptBounds(lat,lon)))return null;
  const x={
    placeId:String(p.id||fallback.placeId||''),
    name:String((p.displayName&&p.displayName.text)||fallback.name||'Google place'),
    formattedAddress:String(p.formattedAddress||fallback.formattedAddress||''),
    addressFields:magicLaneAddressFields(p.addressComponents,p.formattedAddress||fallback.formattedAddress||''),
    latitude:lat,longitude:lon,centerLatitude:centerLat,centerLongitude:centerLon,
    navigationPoint:nav,preferredEntrance:nav?null:entrance,arrivalPointKind:nav?'navigation-point':(entrance?'preferred-entrance':'center'),currentOpeningHours:p.currentOpeningHours||null,
    utcOffsetMinutes:Number(p.utcOffsetMinutes),richLoaded:true,
    raw:p
  };
  Object.assign(x,buildRichPlaceMetadata(p));
  x.currentOpeningHours=p.currentOpeningHours||null;
  x.utcOffsetMinutes=Number(p.utcOffsetMinutes);
  x.navigationPoint=nav;
  x.preferredEntrance=nav?null:entrance;
  x.arrivalPointKind=nav?'navigation-point':(entrance?'preferred-entrance':'center');
  x.richLoaded=true;
  if(nav){
    const label=[nav.displayName,nav.usages&&nav.usages.length?nav.usages.join('/'):''].filter(Boolean).join(' · ');
    x.extraInfoLines.unshift(`Navigation point: ${label||'Google road-side destination'}`);
  } else if(entrance) {
    x.extraInfoLines.unshift('Preferred entrance: Google mapped entry point');
  }
  for(const a of attributionTexts(p.attributions))x.extraInfoLines.push(`Attribution: ${a}`);
  x.extraInfoLines.push('Source: Google Maps');
  x.extraInfoLines=[...new Set(x.extraInfoLines)].slice(0,40);
  return x;
}

export function buildRichPlaceMetadata(p) {
  const extra=['Source: Google Maps'];
  const primaryType=textValue(p && p.primaryTypeDisplayName) || String(p && p.primaryType || '').replaceAll('_',' ');
  const businessStatus=businessStatusLabel(p);
  const open=currentOpenState(p && p.currentOpeningHours);
  const rating=Number(p && p.rating), reviews=Number(p && p.userRatingCount);
  const phone=String((p && (p.internationalPhoneNumber || p.nationalPhoneNumber)) || '').trim();
  const website=String(p && p.websiteUri || '').trim();
  const plusCode=String(p && p.plusCode && (p.plusCode.globalCode || p.plusCode.compoundCode) || '').trim();
  const priceRange=priceRangeText(p && p.priceRange);
  const priceLevel=String(p && p.priceLevel || '').replace(/^PRICE_LEVEL_/,'').replaceAll('_',' ').trim();

  if (primaryType) extra.push(`Category: ${primaryType}`);
  if (businessStatus) extra.push(businessStatus);
  if (open) extra.push(open);
  if (Number.isFinite(rating) && rating > 0) extra.push(`Rating: ${rating.toFixed(1)}${Number.isFinite(reviews)&&reviews>=0?` (${Math.trunc(reviews)} reviews)`:''}`);
  if (phone) extra.push(`Phone: ${phone}`);
  if (website) extra.push(`Website: ${website}`);
  if (priceRange) extra.push(`Price range: ${priceRange}`);
  else if (priceLevel) extra.push(`Price: ${priceLevel}`);
  if (plusCode) extra.push(`Plus Code: ${plusCode}`);
  if (p && p.pureServiceAreaBusiness === true) extra.push('Service-area business — no guaranteed customer-facing storefront');
  const consumerAlert=String(p && p.consumerAlert && p.consumerAlert.overview || '').trim().slice(0,240);
  if (consumerAlert) extra.push(`Google consumer alert: ${consumerAlert}`);

  const services=boolLines(p,[
    ['reservable','Reservations'],['delivery','Delivery'],['takeout','Takeout'],['dineIn','Dine-in'],
    ['curbsidePickup','Curbside pickup'],['outdoorSeating','Outdoor seating'],['restroom','Restroom'],
    ['goodForChildren','Good for children'],['goodForGroups','Good for groups'],['allowsDogs','Dogs allowed'],
    ['liveMusic','Live music'],['servesBreakfast','Breakfast'],['servesLunch','Lunch'],['servesDinner','Dinner'],
    ['servesCoffee','Coffee'],['servesDessert','Dessert'],['servesVegetarianFood','Vegetarian food']
  ]);
  if (services.length) extra.push(`Services: ${services.join(', ')}`);

  const parking=boolLines(p && p.parkingOptions,[
    ['freeParkingLot','Free parking lot'],['paidParkingLot','Paid parking lot'],['freeStreetParking','Free street parking'],
    ['paidStreetParking','Paid street parking'],['valetParking','Valet parking'],['freeGarageParking','Free garage'],
    ['paidGarageParking','Paid garage']
  ]);
  if (parking.length) extra.push(`Parking: ${parking.join(', ')}`);

  const payments=boolLines(p && p.paymentOptions,[
    ['acceptsCreditCards','Credit cards'],['acceptsDebitCards','Debit cards'],['acceptsCashOnly','Cash only'],['acceptsNfc','NFC']
  ]);
  if (payments.length) extra.push(`Payments: ${payments.join(', ')}`);

  const access=boolLines(p && p.accessibilityOptions,[
    ['wheelchairAccessibleParking','Wheelchair parking'],['wheelchairAccessibleEntrance','Wheelchair entrance'],
    ['wheelchairAccessibleRestroom','Wheelchair restroom'],['wheelchairAccessibleSeating','Wheelchair seating']
  ]);
  if (access.length) extra.push(`Accessibility: ${access.join(', ')}`);

  for (const line of fuelLines(p && p.fuelOptions)) extra.push(`Fuel ${line}`);

  const today = weekdayLines(p && p.currentOpeningHours);
  if (today.length) extra.push(`Hours: ${today.join(' | ')}`);
  const secondary = Array.isArray(p && p.currentSecondaryOpeningHours) ? p.currentSecondaryOpeningHours : [];
  for (const h of secondary.slice(0,4)) {
    const typ=String(h && h.secondaryHoursType || h && h.type || 'Secondary').replaceAll('_',' ');
    const lines=weekdayLines(h);
    if (lines.length) extra.push(`${typ}: ${lines.join(' | ')}`);
  }

  let opened='';
  if (p && p.openingDate) {
    const y=Number(p.openingDate.year), m=Number(p.openingDate.month), d=Number(p.openingDate.day);
    if (Number.isFinite(y) && y>1900) opened=`${String(y).padStart(4,'0')}-${String(Number.isFinite(m)?m:1).padStart(2,'0')}-${String(Number.isFinite(d)?d:1).padStart(2,'0')}`;
  }
  if (opened) extra.push(`Opening date: ${opened}`);
  for(const a of attributionTexts(p && p.attributions)) extra.push(`Attribution: ${a}`);

  const desc=[];
  if (consumerAlert) desc.push(`⚠ ${consumerAlert}`);
  if (businessStatus) desc.push(businessStatus);
  if (primaryType) desc.push(primaryType);
  if (open) desc.push(open);
  if (Number.isFinite(rating) && rating > 0) desc.push(`★ ${rating.toFixed(1)}${Number.isFinite(reviews)&&reviews>=0?` · ${Math.trunc(reviews)} reviews`:''}`);
  if (services.length) desc.push(services.slice(0,6).join(' · '));
  if (parking.length) desc.push(`Parking: ${parking.slice(0,4).join(', ')}`);
  if (phone) desc.push(phone);
  if (website) desc.push(website);
  return {description:desc.join('\n'), extraInfoLines:extra.slice(0,32), phone, website, primaryType, openState:open};
}

function googleDurationSeconds(v) {
  const m=String(v||'').match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return m?Number(m[1]):NaN;
}

export function parsePlacesResponse(body) {
  const d = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
  const out = [];
  const byId = new Set();
  const rawPlaces=Array.isArray(d.places) ? d.places.slice(0, MAX_RESULTS) : [];
  const routingSummaries=Array.isArray(d.routingSummaries) ? d.routingSummaries : [];
  for (let placeIndex=0; placeIndex<rawPlaces.length; placeIndex++) {
    const p=rawPlaces[placeIndex];
    if (!p) continue;
    const movedPlaceId=String(p.movedPlaceId||'').trim();
    // Google marks a relocated place CLOSED_PERMANENTLY and provides the next
    // Place ID. Keep that row bound to the new ID so selection resolves the
    // current location; truly closed, non-moved places remain excluded.
    if (p.businessStatus === 'CLOSED_PERMANENTLY' && !movedPlaceId) continue;
    const lat = Number(p.location && p.location.latitude);
    const lon = Number(p.location && p.location.longitude);
    if (!validCoordinate(lat, lon)) continue;
    const country = shortText(Array.isArray(p.addressComponents) ? p.addressComponents : [], 'country').toUpperCase();
    if ((country && country !== 'EG') || (!country && !insideEgyptBounds(lat, lon))) continue;
    const placeId = String(movedPlaceId || p.id || '');
    if (placeId && byId.has(placeId)) continue;
    const x = {
      placeId,
      originalPlaceId:String(p.id||''),
      movedPlaceId:String(p.movedPlaceId||''),
      name: String((p.displayName && p.displayName.text) || p.id || 'Google place'),
      formattedAddress: String(p.formattedAddress || ''),
      addressFields: magicLaneAddressFields(p.addressComponents, p.formattedAddress || ''),
      latitude: lat,
      longitude: lon
    };
    Object.assign(x, buildBasicPlaceMetadata(p));
    const rs=routingSummaries[placeIndex];
    if(rs&&Array.isArray(rs.legs)&&rs.legs.length){
      const to=rs.legs[0]||{}, after=rs.legs[1]||{};
      const toSec=googleDurationSeconds(to.duration),toM=Number(to.distanceMeters),afterSec=googleDurationSeconds(after.duration),afterM=Number(after.distanceMeters);
      x.routingSummary={
        toPlaceDurationSeconds:Number.isFinite(toSec)?toSec:null,
        toPlaceDistanceMeters:Number.isFinite(toM)?toM:null,
        afterPlaceDurationSeconds:Number.isFinite(afterSec)?afterSec:null,
        afterPlaceDistanceMeters:Number.isFinite(afterM)?afterM:null
      };
      if(Number.isFinite(toSec)||Number.isFinite(toM)){
        const toParts=[]; if(Number.isFinite(toSec))toParts.push(`${Math.max(1,Math.round(toSec/60))} min`); if(Number.isFinite(toM))toParts.push(formatDistanceMeters(toM));
        const afterParts=[]; if(Number.isFinite(afterSec))afterParts.push(`${Math.max(1,Math.round(afterSec/60))} min`); if(Number.isFinite(afterM))afterParts.push(formatDistanceMeters(afterM));
        const line=afterParts.length
          ? `Along route: ${toParts.join(' • ')} to stop · ${afterParts.join(' • ')} onward`
          : `Drive: ${toParts.join(' • ')}`;
        x.extraInfoLines=[line,...(Array.isArray(x.extraInfoLines)?x.extraInfoLines:[])];x.description=[line,x.description].filter(Boolean).join('\n');
      }
    }
    const nn = normalizeName(x.name);
    let duplicate = false;
    for (const e of out) {
      if (nn && nn === normalizeName(e.name) && haversineMeters(x, e) <= 30) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    // Search-along-route responses contain two legs; Nearby Search contains one.
    // In both cases routing summaries are part of the SAME Places response, so
    // ranking by live-traffic drive time adds no per-result network fan-out.
    if (x.routingSummary) {
      const a=Number(x.routingSummary.toPlaceDurationSeconds), b=Number(x.routingSummary.afterPlaceDurationSeconds);
      if (Number.isFinite(a) && Number.isFinite(b)) x.__routeRankSeconds=a+b;
      else if (Number.isFinite(a)) x.__routeRankSeconds=a;
    }
    x.__googleOrder=placeIndex;
    out.push(x);
    if (placeId) byId.add(placeId);
  }
  if (out.some(x=>Number.isFinite(x.__routeRankSeconds))) {
    out.sort((a,b)=>{
      const ar=Number.isFinite(a.__routeRankSeconds)?a.__routeRankSeconds:Number.POSITIVE_INFINITY;
      const br=Number.isFinite(b.__routeRankSeconds)?b.__routeRankSeconds:Number.POSITIVE_INFINITY;
      return ar-br || a.__googleOrder-b.__googleOrder;
    });
  }
  for (const x of out) { delete x.__routeRankSeconds; delete x.__googleOrder; }
  return out;
}

export function classifyGoogleFailure(status, bodyText) {
  let message = '';
  let code = '';
  try {
    const d = JSON.parse(String(bodyText || '{}'));
    message = String(d && d.error && d.error.message || '');
    code = String(d && d.error && d.error.status || '');
  } catch (_) {}
  if (status === 401 || status === 403 || /API_KEY|PERMISSION_DENIED|REQUEST_DENIED/i.test(`${code} ${message}`)) {
    return { kind: 'auth', cooldownMs: Number.POSITIVE_INFINITY, code, message };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(`${code} ${message}`)) {
    return { kind: 'quota', cooldownMs: 60000, code, message };
  }
  if (status >= 500) return { kind: 'server', cooldownMs: 15000, code, message };
  if (status >= 400) return { kind: 'client', cooldownMs: 5000, code, message };
  return { kind: 'none', cooldownMs: 0, code, message };
}

// Official Places Autocomplete (New). Predictions intentionally stay text-only;
// one selected prediction is completed with Place Details using the same token.
export const AUTOCOMPLETE_URL='https://places.googleapis.com/v1/places:autocomplete';
export const AUTOCOMPLETE_FIELD_MASK=[
  'suggestions.placePrediction.placeId',
  'suggestions.placePrediction.text.text',
  'suggestions.placePrediction.structuredFormat.mainText.text',
  'suggestions.placePrediction.structuredFormat.secondaryText.text',
  'suggestions.placePrediction.types',
  'suggestions.placePrediction.distanceMeters'
].join(',');
export const MAX_AUTOCOMPLETE_SUGGESTIONS=5;
export function buildAutocompleteBody(query,bias,sessionToken,radiusMeters=50000){
  const q=normalizeQuery(query),b=safeBias(bias),r=Math.min(50000,Math.max(1000,Number(radiusMeters)||50000));
  const body={input:q,languageCode:inferLang(q),regionCode:'EG',includedRegionCodes:['EG'],sessionToken:String(sessionToken||'')};
  if(b){body.origin={latitude:b.latitude,longitude:b.longitude};body.locationBias={circle:{center:{latitude:b.latitude,longitude:b.longitude},radius:r}};}
  return body;
}
export function parseAutocompleteResponse(body){
  const d=typeof body==='string'?JSON.parse(body||'{}'):(body||{}),out=[];
  for(const s of Array.isArray(d.suggestions)?d.suggestions:[]){
    const p=s&&s.placePrediction;if(!p||!p.placeId)continue;
    const full=textValue(p.text),main=textValue(p.structuredFormat&&p.structuredFormat.mainText),secondary=textValue(p.structuredFormat&&p.structuredFormat.secondaryText);
    out.push({placeId:String(p.placeId),text:full||[main,secondary].filter(Boolean).join(', '),mainText:main||full,secondaryText:secondary,types:Array.isArray(p.types)?p.types.map(String):[],distanceMeters:Number(p.distanceMeters)});
    if(out.length>=MAX_AUTOCOMPLETE_SUGGESTIONS)break;
  }
  return out;
}
