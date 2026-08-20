# Narrow-road comfort algorithm — v22.3

Goal: avoid genuinely path-like roads without pretending road class equals physical width.

## Strong evidence only

- `SingleTrack`
- `Path`

Ordinary residential/local roads are not treated as physically narrow merely because of their class.

## KISS changes from v21.1

- **Removed:** fake `truckProfile.width = 200 cm`. Magic Lane's truck-profile width is a vehicle-dimension restriction mechanism, not a generic comfort score.
- Initial route may request `buildTerrainProfile=true` so `roadTypeSections` can be inspected.
- Active-navigation `calculateRoute` requests set terrain profile off to protect reroute latency.
- A qualifying section creates only a temporary native Magic Lane roadblock; Magic Lane computes the replacement route.
- Roadblock start is the section's **distance ahead of current route progress**, fixing the old absolute route-start distance mistake.

## Guards

- actionable look-ahead: roughly 70–1200 m;
- path-like section length >=35 m;
- avoid near-destination false positives;
- long per-section cooldown and global hold-down;
- fail open if route profile/API is unavailable.

This keeps narrow-road logic useful without sacrificing normal-car routing correctness for an invented width model.
