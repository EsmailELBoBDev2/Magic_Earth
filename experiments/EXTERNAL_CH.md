# ExternalCh / CH routing audit and A/B experiment

Audit date: 2026-08-20. Production default: **stock MagicEarth**.

## What is confirmed

The Magic Lane Android route-preferences documentation for the exact-target generation exposes `ERoutePathAlgorithm.MagicEarth` (default) and `ERoutePathAlgorithm.ExternalCh`. It does **not** document `ExternalCh` as universally faster, traffic-equivalent, or route-quality-equivalent.

Newer/current Flutter API documentation exposes four names: `ml`, `simplifiedMl`, `externalCH`, and `mlch`; importantly it describes `simplifiedMl` as **"Best speed, recommended for low end devices"**. Those newer Flutter enum names are not part of the Android target contract used by this patch, so CairoDrive does not inject them into Magic Earth 7.1.26.26.

Contraction Hierarchies are normally a route-query speed-up technique based on preprocessing. That makes `ExternalCh` a credible latency experiment, not proof that it is the best production choice. Preprocessed CH modes can also have reduced flexibility for dynamic per-request weights/preferences depending on implementation. CairoDrive needs live traffic, temporary roadblocks, restrictions and narrow-road avoidance, so speed alone is insufficient.


## Preferred v22.3 test: automatic no-drive A/B

The manual commands below are retained for debugging, but the normal path is now:

```bash
./experiments/run_route_algo_ab_simulation.sh
```

It tests `stock`, `externalch-reroute`, and `externalch-all` across fixed short/mid/long Cairo scenarios using the exact SDK simulator. It automatically rejects a mode if the expected `pathAlgorithm` change was not actually observed, if route-quality evidence is missing/regresses, or if stability fails. It configures the measured winner and removes simulation mode at the end. See `AUTO_SIM_AB.md`.

## Safe v22.3 experiment

The production path never changes `pathAlgorithm` unless `/data/local/tmp/cairodrive_route_algo` explicitly contains an experiment mode. Startup logs the exact runtime `ERoutePathAlgorithm` values:

```text
ROUTE_ALGO_ENUMS magicEarth=... externalCh=... experiment=stock
```

### A. Stock baseline

```bash
./experiments/route_algo_stock.sh
./watch_drive.sh clear
# perform the same reroute scenario(s)
./watch_drive.sh snapshot > stock.log
./watch_drive.sh recompute
```

### B. ExternalCh only on active reroutes (preferred experiment)

```bash
./experiments/route_algo_externalch_reroute.sh
./watch_drive.sh clear
# repeat the SAME scenario(s)
./watch_drive.sh snapshot > externalch.log
./watch_drive.sh recompute
```

Compare:

```bash
python3 experiments/compare_recompute_logs.py stock.log externalch.log
```

`externalch-all` also exists for controlled testing, but reroute-only is the safer first experiment because the initial/preview route remains exactly stock.

## Promotion gate

Do **not** promote ExternalCh merely for one fast run. Require all of:

1. Runtime enum exists on the exact APK and no ABI/native failures occur.
2. Multiple comparable reroutes covering short/mid/long Cairo routes; the automated default collects six reroutes per mode and can be increased with `--repeats`.
3. ExternalCh p90 recompute is at least ~20% faster, or is what gets a consistently over-1s stock reroute below 1s.
4. Result route total distance/ETA remain sensible and route geometry is valid.
5. `avoidTraffic=All`, Level-3 temporary roadblocks and strong SingleTrack/Path roadblocks still influence routing as intended.
6. No increase in known-narrow route sections or restricted-road warnings.
7. Better-route detection and route replacement remain functional.

If any of 4-7 fails, keep `MagicEarth` even if ExternalCh benchmarks faster.

## Current recommendation

**Default safely to MagicEarth until the automatic exact-device A/B runs.** The harness then configures `externalch-reroute` only if that path is proven reachable and meaningfully better; otherwise it can choose `externalch-all` if that is the only effective CH path and it passes the same quality/stability gates. Any inconclusive result fails safe to `stock`.
