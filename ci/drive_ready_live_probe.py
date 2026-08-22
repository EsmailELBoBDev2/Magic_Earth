#!/usr/bin/env python3
import json, os, re, sys, urllib.request, urllib.error
from pathlib import Path

PLACES=os.environ.get("GOOGLE_PLACES_API_KEY","").strip()
ROUTES=os.environ.get("GOOGLE_ROUTES_API_KEY","").strip() or PLACES
PKG=os.environ.get("CAIRODRIVE_ANDROID_PACKAGE","com.cairodrive.app").strip()
CERT=os.environ.get("CAIRODRIVE_ANDROID_CERT_SHA1","C0202993D2D3659C9A8EFDBA2F9490471F3A71A7").replace(":","").upper()
OUT=Path(os.environ.get("DRIVE_READY_LIVE_OUT","drive-ready-live.json"))

if not PLACES or not ROUTES:
    raise SystemExit("ERROR: Google Places/Routes secret is missing")
if not re.fullmatch(r"[0-9A-F]{40}",CERT):
    raise SystemExit("ERROR: invalid Android SHA-1 header")

def post(url,key,mask,body):
    raw=json.dumps(body,separators=(",",":")).encode()
    req=urllib.request.Request(url,data=raw,method="POST",headers={
        "Content-Type":"application/json",
        "Accept":"application/json",
        "X-Goog-Api-Key":key,
        "X-Goog-FieldMask":mask,
        "X-Android-Package":PKG,
        "X-Android-Cert":CERT,
        "User-Agent":"CairoDrive-drive-ready-probe/2"
    })
    try:
        with urllib.request.urlopen(req,timeout=25) as r:
            data=json.loads(r.read().decode())
            return r.status,data
    except urllib.error.HTTPError as e:
        text=e.read().decode(errors="replace")
        raise SystemExit(f"ERROR: HTTP {e.code} from {url.split('/')[2]}: {text[:700]}")
    except Exception as e:
        raise SystemExit(f"ERROR: network {url.split('/')[2]}: {type(e).__name__}: {e}")

def component(place,typ):
    for c in place.get("addressComponents") or []:
        if typ in (c.get("types") or []):
            return str(c.get("longText") or c.get("shortText") or "")
    return ""

# Public numbered Nasr City addresses. The probe checks Google's own returned
# structured component and formatted address; it never manufactures an address.
address_cases=[
    ("1","1 Al Nasr Road, Ramo Buildings, Nasr City, Cairo",30.071768,31.353264),
    ("11","11 Abbas El Akkad Street, Nasr City, Cairo",30.066150,31.336453),
]
place_evidence=[]
for expected,q,lat,lon in address_cases:
    _,d=post(
        "https://places.googleapis.com/v1/places:searchText",
        PLACES,
        "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location",
        {
          "textQuery":q,"languageCode":"en","regionCode":"EG","pageSize":3,
          "locationBias":{"circle":{"center":{"latitude":lat,"longitude":lon},"radius":2500}}
        }
    )
    rows=d.get("places") or []
    for p in rows:
        num=component(p,"street_number")
        formatted=str(p.get("formattedAddress") or "")
        visible=bool(num) or bool(re.search(rf"(^|[^0-9]){re.escape(expected)}([^0-9]|$)",formatted))
        place_evidence.append({
            "query":q,"expected":expected,"structuredStreetNumber":num,
            "formattedAddress":formatted,"visibleNumberEvidence":visible
        })
        if visible: break

if not any(x["visibleNumberEvidence"] for x in place_evidence):
    raise SystemExit("ERROR: live Places probe found no Google-provided number evidence in numbered Nasr City cases")
print("PLACES_LIVE_OK",
      "cases="+str(len(address_cases)),
      "numberEvidence=yes",
      "structuredAny="+("yes" if any(x["structuredStreetNumber"] for x in place_evidence) else "no"))

# Real Cairo route: El Zawya El Hamra -> Al Fangary -> Stadium -> Rabaa -> Nasr City.
origin=(30.09629,31.27619)
via=[(30.07546,31.30117),(30.069129,31.312311),(30.06751325,31.32496459)]
destination=(30.06332,31.34933)
route_body={
 "origin":{"location":{"latLng":{"latitude":origin[0],"longitude":origin[1]}}},
 "destination":{"location":{"latLng":{"latitude":destination[0],"longitude":destination[1]}}},
 "intermediates":[{"via":True,"location":{"latLng":{"latitude":a,"longitude":b}}} for a,b in via],
 "travelMode":"DRIVE",
 "routingPreference":"TRAFFIC_AWARE",
 "extraComputations":["TRAFFIC_ON_POLYLINE"],
 "polylineQuality":"HIGH_QUALITY",
 "polylineEncoding":"ENCODED_POLYLINE",
 "languageCode":"en",
 "units":"METRIC"
}
mask="routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals"
_,routes=post("https://routes.googleapis.com/directions/v2:computeRoutes",ROUTES,mask,route_body)
rr=routes.get("routes") or []
if not rr:
    raise SystemExit("ERROR: live Routes probe returned no route")
r=rr[0]
poly=((r.get("polyline") or {}).get("encodedPolyline") or "")
ints=((r.get("travelAdvisory") or {}).get("speedReadingIntervals") or [])
if not poly:
    raise SystemExit("ERROR: live Routes probe missing encoded polyline")
if not ints:
    raise SystemExit("ERROR: live Routes probe missing speedReadingIntervals")
speeds={}
for x in ints:
    s=str(x.get("speed") or "NORMAL")
    speeds[s]=speeds.get(s,0)+1
print("ROUTES_LIVE_OK",
      "distanceM="+str(r.get("distanceMeters")),
      "duration="+str(r.get("duration")),
      "staticDuration="+str(r.get("staticDuration")),
      "trafficIntervals="+str(len(ints)),
      "speeds="+json.dumps(speeds,separators=(",",":")))

OUT.write_text(json.dumps({
  "placesEvidence":place_evidence,
  "routesResponse":routes,
  "routeRequestAnchors":{"origin":origin,"via":via,"destination":destination}
},indent=2))
print("DRIVE_READY_LIVE_PROBE: PASS")
