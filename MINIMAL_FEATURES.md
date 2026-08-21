# CairoDrive v23.3 Minimal + Optimized Native Traffic

## Design rule

Magic Earth stays stock unless a feature is explicitly listed under **Kept**.

CairoDrive optimizes only code CairoDrive adds. It does not patch Magic Earth's
map rendering, navigation UI, Android Auto, voice guidance, stock debounce, route
algorithm, route alternatives, or other stock performance internals.

## Kept

| Feature | Behavior |
|---|---|
| Normal typed search | Google Places Text Search supplies `Landmark` rows to Magic Earth's native search result list. |
| POI/category / What's Nearby | Google Places Nearby Search supplies rows to the stock result list when there is a safe category mapping; otherwise stock search is left alone. |
| Google Places API | Search/POI data only. No custom full-screen UI and no asynchronous custom place-card enrichment. |
| Google traffic | Google Routes remains advisory for routing. For visualization, CairoDrive maps traffic state back onto the **Magic Lane route geometry** and asks Magic Lane's own `MapViewPathCollection` renderer to draw green/yellow/red segments. Google geometry never becomes the navigation route. |
| Native Magic Lane traffic | Enabled through Magic Lane's native Traffic preferences and `trafficVisibility` where the real stock map view is available. |
| Narrow roads | Strong native `Path` / `SingleTrack` terrain-profile evidence may create a temporary Magic Lane roadblock so Magic Lane itself recomputes. |
| `avoidUnpavedRoads` | Set to `true` for car route requests when that field exists. |
| Terrain profile | Set to `true` only because strong narrow-road detection needs native road-type sections. This is a functional dependency, not a general optimization. |
| Map/navigation UI | Stock Magic Earth. |
| Route calculation/navigation | Magic Lane remains authoritative. |
| Place card | Stock Magic Earth. |
| Android Auto | Stock/upstream behavior. |
| Voice/navigation instructions | Stock/upstream behavior; CairoDrive does not query or replace navigation instructions. |

## CairoDrive-only performance hygiene kept

These are not stock-app tweaks. They prevent the added network features from
hurting stock responsiveness:

- Places and traffic HTTP run on background executors.
- Places and traffic use separate workers.
- Stale Places requests are cancelled.
- Request/response sizes are bounded.
- Network timeouts and Google error cooldowns are bounded.
- Search field masks stay lean.
- Location bias is cached briefly.
- Traffic checks are low-frequency and only after a real navigation session exists.
- Traffic visualization is refresh-driven, not frame-driven: no draw loop, map-move listener, or zoom listener.
- Traffic colors are rendered by Magic Lane's **real stock MapView** using native `Path` objects.
- Adjacent equal traffic states are merged before any native objects are created.
- Native traffic is normally only a handful of paths; a hard **16-path** ceiling prevents pathological fragmentation.
- Each path uses adaptive Douglas-Peucker geometry simplification (roughly 3–8 m tolerance by segment length) with a **96-point hard ceiling only as a last resort**.
- Unchanged traffic fingerprints do not touch the native map at all.
- When traffic is unchanged, the native map is untouched. When it changes, CairoDrive removes only its own small traffic snapshot and inserts a fresh merged/simplified snapshot; stock Magic Earth paths are never cleared.
- Removed CairoDrive paths release their retained Java wrappers to avoid long-navigation accumulation.
- Only CairoDrive-owned path objects are removed; the stock path collection is never `clear()`ed.
- No persistent CairoDrive log writer is packaged.
- No custom UI activity hooks are packaged.

## Removed / dormant in Git history

The full-feature implementation remains in Git history and in
`archive/v22.3-full-features`.

| Removed feature | Status |
|---|---|
| Custom autocomplete overlay | Removed |
| Rich Google place-card enrichment | Removed |
| Custom navigation banner | Removed |
| Lane/maneuver bitmap overlays | Removed |
| Custom ETA/progress/road-shield UI | Removed |
| **Custom CairoDrive** speed-limit and overspeed UI | Removed; stock Magic Earth speed-limit/overspeed UI remains |
| AlarmService probing | Removed |
| Restriction/toll/ferry custom warnings | Removed |
| Repeat voice control | Removed |
| Media pause control | Removed |
| Social-report menu / reporting hooks | Removed |
| OSM bump/hump/table reporting | Removed |
| Better-route auto-switch | Removed |
| Better-route custom notifications | Removed |
| ExternalCh route algorithm experiment | Removed |
| Route algorithm A/B tests | Removed |
| Simulation rewrite / benchmark | Removed |
| Sub-1-second reroute benchmark instrumentation | Removed |
| Always-on drive tracing | Removed |
| Persistent 30-day CairoDrive logging | Removed |
| 1s/3s navigation UI polling | Removed |
| Activity `onResume` overlay attachment | Removed |
| Stock search debounce 1000ms -> 400ms binary patch | Removed |
| Forced Fastest route type | Removed |
| Forced `avoidTraffic=All` route field | Removed |
| Accurate-waypoint route mutation | Removed |
| Departure-heading mutation | Removed |
| Forced online route calculation | Removed |
| Alternatives-schema mutation | Removed |
| Path-algorithm mutation | Removed |

## Routing mutation contract

For car route requests CairoDrive may mutate only:

1. `avoidUnpavedRoads = true`
2. `buildTerrainProfile = true` when the wrapper exposes it

Traffic avoidance policy, route type, alternatives, online calculation, heading,
waypoint approach and path algorithm remain stock.

Google Routes traffic can only trigger a temporary native Magic Lane roadblock
after high-confidence traffic is map-matched to the active Magic Lane route.
Magic Lane always computes and displays the replacement route.

## Native traffic-map rendering contract

The visual layer intentionally targets the **active Magic Lane route only**. It is
not a whole-city viewport traffic service. Google traffic states (`NORMAL`, `SLOW`,
`TRAFFIC_JAM`) are spatially/heading matched onto sampled Magic Lane route points,
then contiguous Magic Lane geometry is rendered as green/yellow/red native paths.

Performance rules:

1. Do not draw from JavaScript per frame.
2. Do not subscribe to map pan/zoom callbacks.
3. Discover the real stock `GemSurfaceView` only when a traffic visualization is first needed.
4. Run Magic Lane map mutations on the GEM SDK thread.
5. Merge equal traffic runs before rendering so one long red/yellow/green stretch is one native Path whenever possible.
6. Simplify geometry adaptively before JNI/native object creation, then enforce hard 16-path / 96-point safety ceilings.
7. Skip a render when the traffic fingerprint has not changed.
8. If the fingerprint changed, replace CairoDrive's small owned traffic snapshot in one simple update; do not reconcile individual native Path wrappers.
9. Clear only CairoDrive-owned paths when navigation ends or traffic matching becomes unusable.
10. Any renderer/API failure fails open: stock Magic Earth continues normally.

The map renderer, camera, labels, route UI, Android Auto, voice guidance, and stock
speed-limit UI remain upstream Magic Earth behavior.

## Provider/licensing note

The native renderer is provider-agnostic, but the current traffic classifier can be
fed by Google Routes. Google Maps Platform terms may restrict displaying Routes
content on a non-Google map. Treat Google-backed visualization as a personal/test
integration unless your Google agreement permits that display. The renderer is kept
separate so a traffic-flow provider licensed for third-party maps can replace the
source without changing the Magic Lane rendering integration.
