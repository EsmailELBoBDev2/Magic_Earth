export const ROUTES_URL='https://routes.googleapis.com/directions/v2:computeRoutes';
export const ROUTES_FIELD_MASK=[
  'routes.duration','routes.staticDuration','routes.distanceMeters','routes.polyline.encodedPolyline',
  'routes.travelAdvisory.speedReadingIntervals'
].join(',');

export function buildTrafficRequest(origin,destination,{languageCode='en',routingPreference='TRAFFIC_AWARE',viaPoints=[]}={}){
  const o=cleanPoint(origin),d=cleanPoint(destination); if(!o||!d)throw new Error('invalid traffic endpoints');
  const vias=[]; for(const p of Array.isArray(viaPoints)?viaPoints:[]){const c=cleanPoint(p);if(c)vias.push({via:true,location:{latLng:{latitude:c.latitude,longitude:c.longitude}}});if(vias.length>=8)break;}
  const out={
    origin:{location:{latLng:{latitude:o.latitude,longitude:o.longitude}}},
    destination:{location:{latLng:{latitude:d.latitude,longitude:d.longitude}}},
    travelMode:'DRIVE', routingPreference,
    extraComputations:['TRAFFIC_ON_POLYLINE'],
    polylineQuality:'HIGH_QUALITY', polylineEncoding:'ENCODED_POLYLINE',
    languageCode:String(languageCode||'en'), units:'METRIC'
  };
  if(vias.length)out.intermediates=vias;
  return out;
}
function cleanPoint(p){const a=Number(p&&p.latitude),b=Number(p&&p.longitude);return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a)<=90&&Math.abs(b)<=180?{latitude:a,longitude:b}:null;}
export function decodePolyline(str){
  const s=String(str||''); const out=[]; let i=0,lat=0,lng=0;
  const one=()=>{let result=0,shift=0,b; do{if(i>=s.length)throw new Error('truncated polyline');b=s.charCodeAt(i++)-63;result|=(b&0x1f)<<shift;shift+=5;}while(b>=0x20);return (result&1)?~(result>>1):(result>>1);};
  while(i<s.length){lat+=one();lng+=one();out.push({latitude:lat/1e5,longitude:lng/1e5});}
  return out;
}
export function haversineMeters(a,b){const R=6371000,d=Math.PI/180,p1=Number(a.latitude)*d,p2=Number(b.latitude)*d,dl=(Number(b.longitude)-Number(a.longitude))*d,dp=p2-p1;const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
export function bearingDeg(a,b){const d=Math.PI/180,p1=Number(a.latitude)*d,p2=Number(b.latitude)*d,dl=(Number(b.longitude)-Number(a.longitude))*d;const y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);return (Math.atan2(y,x)/d+360)%360;}
export function headingDiff(a,b){const x=Math.abs(Number(a)-Number(b))%360;return Math.min(x,360-x);}
function segDistance(p,a,b){
  // Equirectangular local projection is accurate enough for <= few-km matching.
  const lat0=Number(p.latitude)*Math.PI/180, kx=111320*Math.cos(lat0), ky=110540;
  const px=Number(p.longitude)*kx,py=Number(p.latitude)*ky,ax=Number(a.longitude)*kx,ay=Number(a.latitude)*ky,bx=Number(b.longitude)*kx,by=Number(b.latitude)*ky;
  const vx=bx-ax,vy=by-ay,wx=px-ax,wy=py-ay,den=vx*vx+vy*vy;let t=den>0?(wx*vx+wy*vy)/den:0;t=Math.max(0,Math.min(1,t));const dx=px-(ax+t*vx),dy=py-(ay+t*vy);return Math.hypot(dx,dy);
}
export function parseDurationSeconds(v){
  const m=String(v||'').trim().match(/^(-?\d+(?:\.\d+)?)s$/);return m?Number(m[1]):NaN;
}
export function parseTrafficRoutesResponse(body){
  const d=typeof body==='string'?JSON.parse(body||'{}'):(body||{}),r=Array.isArray(d.routes)?d.routes[0]:null;
  if(!r)throw new Error('no route'); const points=decodePolyline(r.polyline&&r.polyline.encodedPolyline||''); if(points.length<2)throw new Error('traffic polyline too short');
  const speedByEdge=new Array(points.length-1).fill('NORMAL'); const ints=r.travelAdvisory&&Array.isArray(r.travelAdvisory.speedReadingIntervals)?r.travelAdvisory.speedReadingIntervals:[];
  for(const it of ints){const s=Math.max(0,Number(it.startPolylinePointIndex||0)|0),e=Math.min(points.length-1,Number(it.endPolylinePointIndex||0)|0),sp=String(it.speed||'NORMAL');for(let j=s;j<e;j++)speedByEdge[j]=sp;}
  const edges=[];let total=0;for(let i=0;i<points.length-1;i++){const a=points[i],b=points[i+1],len=haversineMeters(a,b);edges.push({a,b,lengthM:len,bearing:bearingDeg(a,b),speed:speedByEdge[i]});total+=len;}
  const duration=String(r.duration||''),staticDuration=String(r.staticDuration||'');
  const durationSeconds=parseDurationSeconds(duration),staticDurationSeconds=parseDurationSeconds(staticDuration);
  const trafficDelaySeconds=Number.isFinite(durationSeconds)&&Number.isFinite(staticDurationSeconds)?Math.max(0,durationSeconds-staticDurationSeconds):NaN;
  return {duration,staticDuration,durationSeconds,staticDurationSeconds,trafficDelaySeconds,distanceMeters:Number(r.distanceMeters||0),points,edges,totalPolylineMeters:total};
}
export function hasMeaningfulTrafficDelay(traffic,{minSeconds=75,minRatio=0.06}={}){
  const d=Number(traffic&&traffic.trafficDelaySeconds),base=Number(traffic&&traffic.staticDurationSeconds);
  if(!Number.isFinite(d)||!Number.isFinite(base)||base<=0)return false; // missing duration evidence must never alone authorize a hard reroute
  return d>=Number(minSeconds)||d/base>=Number(minRatio);
}
export function classifyTrafficLevel(match,traffic,{level2MinDelaySeconds=120,level2MinDelayRatio=0.08,level2MinAffectedMeters=400,level3MinJamRunMeters=120}={}){
  if(!match||!match.usable)return {level:0,reason:'unusable',affectedM:0,delaySeconds:NaN,delayRatio:NaN};
  const normal=Number(match.normalM||0),slow=Number(match.slowM||0),jam=Number(match.jamM||0),total=normal+slow+jam;
  const affected=slow+jam;
  const delay=Number(traffic&&traffic.trafficDelaySeconds),base=Number(traffic&&traffic.staticDurationSeconds);
  const ratio=Number.isFinite(delay)&&Number.isFinite(base)&&base>0?delay/base:NaN;
  const strongJam=!!(match.strongJamRun&&Number(match.strongJamRun.lengthM)>=Number(level3MinJamRunMeters));
  const meaningful=hasMeaningfulTrafficDelay(traffic,{minSeconds:75,minRatio:0.06});
  const jamRunM=match.strongJamRun?Number(match.strongJamRun.lengthM||0):0;
  const durationEvidenceMissing=!Number.isFinite(delay)||!Number.isFinite(base)||base<=0;
  // Direct Google speed-reading evidence can still justify avoidance if duration is
  // unexpectedly absent, but require a much longer contiguous jam so an omitted
  // staticDuration cannot turn a short red segment into a hard roadblock.
  if(strongJam&&(meaningful||(durationEvidenceMissing&&jamRunM>=300)))return {level:3,reason:meaningful?'strong-contiguous-jam':'strong-long-jam-no-duration',affectedM:affected,delaySeconds:delay,delayRatio:ratio};
  const moderateDelay=(Number.isFinite(delay)&&delay>=Number(level2MinDelaySeconds))||(Number.isFinite(ratio)&&ratio>=Number(level2MinDelayRatio));
  const moderateExtent=affected>=Number(level2MinAffectedMeters)||(total>0&&affected/total>=0.12);
  if(moderateDelay&&moderateExtent)return {level:2,reason:'meaningful-slow-traffic',affectedM:affected,delaySeconds:delay,delayRatio:ratio};
  return {level:1,reason:'normal-or-minor',affectedM:affected,delaySeconds:delay,delayRatio:ratio};
}

export function trafficRefreshIntervalMs(match){
  if(!match||!match.usable)return 180000;
  const total=Number(match.normalM||0)+Number(match.slowM||0)+Number(match.jamM||0);if(total<=0)return 180000;
  const jam=Number(match.jamM||0)/total,slow=Number(match.slowM||0)/total;
  if((match.strongJamRun&&Number(match.strongJamRun.lengthM)>=120)||jam>=0.08)return 120000;
  if(jam+slow>=0.12)return 180000;
  return 300000;
}
function buildTrafficEdgeGrid(edges,maxDistanceM=35){
  const cell=0.001; // ~96-111 m/cell around Egypt; candidate lookup still checks exact distance.
  const pad=Math.max(0.00045,Number(maxDistanceM||35)/90000);
  const grid=new Map();
  const key=(y,x)=>`${y}:${x}`;
  for(let i=0;i<edges.length;i++){
    const e=edges[i];
    const minLat=Math.min(Number(e.a.latitude),Number(e.b.latitude))-pad,maxLat=Math.max(Number(e.a.latitude),Number(e.b.latitude))+pad;
    const minLon=Math.min(Number(e.a.longitude),Number(e.b.longitude))-pad,maxLon=Math.max(Number(e.a.longitude),Number(e.b.longitude))+pad;
    const y0=Math.floor(minLat/cell),y1=Math.floor(maxLat/cell),x0=Math.floor(minLon/cell),x1=Math.floor(maxLon/cell);
    // Normal route polyline edges occupy only a handful of cells. A defensive
    // cap prevents a malformed/giant segment from exploding the index.
    if((y1-y0+1)*(x1-x0+1)>100){continue;}
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const k=key(y,x),a=grid.get(k);if(a)a.push(i);else grid.set(k,[i]);}
  }
  return {cell,grid,key};
}
export function matchMagicSamplesToTraffic(samples,traffic,{maxDistanceM=35,maxHeadingDiffDeg=40,minCoverage=0.65}={}){
  const ss=Array.isArray(samples)?samples:[],edges=traffic&&Array.isArray(traffic.edges)?traffic.edges:[]; if(ss.length<2||!edges.length)return {coverage:0,matched:[],normalM:0,slowM:0,jamM:0,strongJamRun:null,usable:false};
  const spatial=buildTrafficEdgeGrid(edges,maxDistanceM);
  const matched=[];let possible=0,covered=0,normalM=0,slowM=0,jamM=0,candidateChecks=0;
  for(let i=0;i<ss.length;i++){
    const p=ss[i]; const step=Math.max(0,Number(p.stepM||50)); possible+=step; let best=null;
    const cy=Math.floor(Number(p.latitude)/spatial.cell),cx=Math.floor(Number(p.longitude)/spatial.cell);const ids=new Set();
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const a=spatial.grid.get(spatial.key(cy+dy,cx+dx));if(a)for(const id of a)ids.add(id);}
    // Fail-safe for unusual long segments omitted by the bounded grid. This is
    // rare; correctness wins over speed when the index cannot supply candidates.
    const candidates=ids.size?[...ids]:edges.map((_,j)=>j);
    for(const j of candidates){candidateChecks++;const e=edges[j],dist=segDistance(p,e.a,e.b);if(dist>maxDistanceM)continue;const hd=Number.isFinite(Number(p.heading))?headingDiff(p.heading,e.bearing):0;if(hd>maxHeadingDiffDeg)continue;const score=dist+hd*0.35;if(!best||score<best.score)best={edge:e,edgeIndex:j,dist,hd,score};}
    if(!best)continue;covered+=step;const speed=best.edge.speed||'NORMAL';if(speed==='TRAFFIC_JAM')jamM+=step;else if(speed==='SLOW')slowM+=step;else normalM+=step;matched.push({...p,speed,matchDistanceM:best.dist,headingDiffDeg:best.hd,edgeIndex:best.edgeIndex});
  }
  let bestRun=null,run=null;
  for(const m of matched){if(m.speed==='TRAFFIC_JAM'){if(!run||m.routeDistanceM-(run.lastRouteDistanceM||m.routeDistanceM)>Math.max(100,(m.stepM||50)*2.5))run={startRouteDistanceM:m.routeDistanceM,endRouteDistanceM:m.routeDistanceM,lengthM:0,lastRouteDistanceM:m.routeDistanceM};run.endRouteDistanceM=m.routeDistanceM+(m.stepM||50);run.lengthM+=m.stepM||50;run.lastRouteDistanceM=m.routeDistanceM;if(!bestRun||run.lengthM>bestRun.lengthM)bestRun={...run};}else run=null;}
  const coverage=possible>0?covered/possible:0;return {coverage,matched,normalM,slowM,jamM,strongJamRun:bestRun,usable:coverage>=minCoverage,candidateChecks,totalEdgeChecksBruteForce:ss.length*edges.length};
}
