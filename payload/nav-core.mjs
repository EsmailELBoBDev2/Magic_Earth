'use strict';

export function normKey(k) {
  return String(k || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function patchEnumValue(oldValue, numericValue, textValue) {
  if (typeof oldValue === 'number') return Number.isFinite(numericValue) ? numericValue : oldValue;
  if (typeof oldValue === 'string') {
    if (/^-?\d+$/.test(oldValue.trim())) return Number.isFinite(numericValue) ? String(numericValue) : oldValue;
    return textValue;
  }
  if (oldValue && typeof oldValue === 'object' && !Array.isArray(oldValue)) {
    const copy = {...oldValue};
    for (const k of Object.keys(copy)) {
      const nk = normKey(k);
      if ((nk === 'value' || nk === 'id' || nk === 'index') && Number.isFinite(numericValue)) copy[k] = numericValue;
      else if (nk === 'name' || nk === 'label') copy[k] = textValue;
    }
    return copy;
  }
  return Number.isFinite(numericValue) ? numericValue : textValue;
}

function scalarEquivalent(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return a === b; }
}

export function inspectTransportMode(root, enums = {}) {
  let found = null;
  const seen = new Set();
  function walk(v, depth) {
    if (found !== null || depth > 8 || v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k,val] of Object.entries(v)) {
      if (normKey(k) === 'transportmode') { found = val; return; }
      walk(val, depth + 1);
    }
  }
  walk(root, 0);
  if (found === null) return {present:false, isCar:true, value:null};
  const car = enums.car;
  if (typeof found === 'number' && Number.isFinite(car)) return {present:true, isCar:found === car, value:found};
  const s = String(found).toLowerCase();
  if (s.includes('car')) return {present:true, isCar:true, value:found};
  if (Number.isFinite(car) && /^-?\d+$/.test(s)) return {present:true, isCar:Number(s) === car, value:found};
  return {present:true, isCar:false, value:found};
}

/*
 * v22.3 KISS route patch.
 *
 * Only mutate fields that materially change the desired passenger-car routing:
 *   - Fastest + avoidTraffic=All are required for native better-route detection.
 *   - avoidUnpavedRoads is a deliberate CairoDrive comfort/safety preference.
 *   - accurateWaypointsApproach improves side-of-road arrival when exposed.
 *   - departureHeading reduces poor initial U-turn/backwards choices while moving.
 *   - buildTerrainProfile is initial-route only; active-navigation calculations are
 *     explicitly stripped of the expensive profile when the wrapper exposes it.
 *   - alternativesSchema=Never is active-navigation-only. A reroute needs one usable
 *     replacement route, not an alternatives fan-out; native better-route detection
 *     remains a separate NavigationService feature.
 *
 * allowOnlineCalculation is only set true for the initial route when the build
 * explicitly prefers Magic Lane online calculation and the exact wrapper exposes it.
 * Active reroutes preserve it to protect the sub-1 s target.
 * Deliberately NOT rewritten in production anymore: automaticTimestamp,
 * resultDetails, pathAlgorithm, initial-route alternativesSchema, balanced sorting,
 * accurateTrackMatch, maximumDistanceConstraint, avoidTurnAroundInstruction, and
 * truckProfile.width. They are defaults, user choices, or semantically wrong for a
 * normal passenger car. Less mutation also lowers ABI risk and recalculation work.
 *
 * The sole exception is an explicit, dormant A/B experiment: when
 * enums.experimentalPathAlgorithmValue is present, pathAlgorithm may be changed
 * to ExternalCh. Production never sets that flag by default.
 */
export function patchRoutePreferenceTree(root, enums = {}) {
  const transport = inspectTransportMode(root, enums);
  if (transport.present && !transport.isCar) return {changed:false, fields:[], skipped:'non-car'};

  const fields = [];
  const seen = new Set();
  function walk(v, depth) {
    if (depth > 10 || v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const k of Object.keys(v)) {
      const nk = normKey(k);
      const old = v[k];
      let next = old;
      if (nk === 'avoidtraffic') next = patchEnumValue(old, enums.trafficAll, 'All');
      else if (nk === 'avoidunpavedroads') next = true;
      else if (nk === 'accuratewaypointsapproach') next = true;
      else if (nk === 'routetype') next = patchEnumValue(old, enums.fastest, 'Fastest');
      else if (nk === 'allowonlinecalculation' && enums.preferOnlineCalculation === true) next = true;
      else if (nk === 'buildterrainprofile' && typeof enums.enableTerrainProfile === 'boolean') next = !!enums.enableTerrainProfile;
      else if (nk === 'alternativesschema' && enums.fastReroute === true) next = patchEnumValue(old, enums.alternativesNever, 'Never');
      else if (nk === 'pathalgorithm' && Number.isFinite(enums.experimentalPathAlgorithmValue)) next = patchEnumValue(old, enums.experimentalPathAlgorithmValue, enums.experimentalPathAlgorithmName || 'ExternalCh');
      else if (nk === 'departureheading' && Number.isFinite(enums.departureHeadingDeg)) {
        const h=Math.max(0,Math.min(360,Number(enums.departureHeadingDeg)));
        if (old && typeof old === 'object' && !Array.isArray(old)) {
          next={...old};
          const hk=Object.keys(next).find(x=>normKey(x)==='heading')||'heading';
          const ak=Object.keys(next).find(x=>normKey(x)==='accuracy')||'accuracy';
          next[hk]=h;
          next[ak]=Number.isFinite(enums.departureHeadingAccuracyDeg)?Math.max(1,Math.min(90,Number(enums.departureHeadingAccuracyDeg))):25;
        } else if (typeof old==='number') next=h;
      }
      else if ((nk === 'departureheadingaccuracy' || nk === 'departureheadingaccuracydeg') && Number.isFinite(enums.departureHeadingAccuracyDeg)) next=Math.max(1,Math.min(90,Number(enums.departureHeadingAccuracyDeg)));
      if (!scalarEquivalent(old, next)) {
        v[k] = next;
        fields.push(k);
      }
      if (v[k] && typeof v[k] === 'object') walk(v[k], depth + 1);
    }
  }
  walk(root, 0);
  return {changed:fields.length > 0, fields:[...new Set(fields)], skipped:''};
}

export function patchRouteRequestObject(req, enums = {}) {
  if (!req || typeof req !== 'object') return {req, changed:false, fields:[], skipped:'invalid'};
  if (String(req.class || '') !== 'RoutingService' || !/calculateRoute/i.test(String(req.method || '')))
    return {req, changed:false, fields:[], skipped:'not-route'};
  const r = patchRoutePreferenceTree(req.args || {}, enums);
  return {req, ...r};
}

export function eventToBanner(eventName, instruction = '') {
  const e = String(eventName || '').replace(/^ETurnEvent\./i,'').replace(/[_\s-]+/g,'').toLowerCase();
  const t = String(instruction || '').trim();
  if (/uturn|turnaround/.test(e)) return {title:'U-TURN  ↶', importance:3};
  if (/roundaboutexitleft/.test(e)) return {title:'ROUNDABOUT — EXIT LEFT  ◀', importance:3};
  if (/roundaboutexitright/.test(e)) return {title:'ROUNDABOUT — EXIT RIGHT  ▶', importance:3};
  if (/exitleft/.test(e)) return {title:'TAKE LEFT EXIT  ◀', importance:3};
  if (/exitright/.test(e)) return {title:'TAKE RIGHT EXIT  ▶', importance:3};
  if (/keepleft|bearleft|lightleft|forkleft|mergeleft/.test(e)) return {title:"KEEP LEFT  ◀\nIGNORE RIGHT", importance:3};
  if (/keepright|bearright|lightright|forkright|mergeright/.test(e)) return {title:"KEEP RIGHT  ▶\nIGNORE LEFT", importance:3};
  if (/sharpleft/.test(e)) return {title:'SHARP LEFT  ◀', importance:2};
  if (/sharpright/.test(e)) return {title:'SHARP RIGHT  ▶', importance:2};
  if (/left/.test(e)) return {title:'TURN LEFT  ◀', importance:2};
  if (/right/.test(e)) return {title:'TURN RIGHT  ▶', importance:2};
  if (/stay|straight|continue/.test(e)) return {title:'GO STRAIGHT  ▲', importance:1};
  if (/roundabout/.test(e)) return {title:'ENTER ROUNDABOUT', importance:2};
  if (t) return {title:t.toUpperCase(), importance:1};
  return {title:'FOLLOW ROAD', importance:1};
}

export function shouldShowBanner(distanceMeters, importance) {
  const d = Number(distanceMeters);
  if (!Number.isFinite(d) || d < 0) return true;
  if (importance >= 3) return d <= 1400;
  if (importance >= 2) return d <= 650;
  return d <= 350;
}
