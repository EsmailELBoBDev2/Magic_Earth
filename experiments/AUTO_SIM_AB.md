# v22.3 automatic MagicEarth vs ExternalCh simulation A/B

This is the **single-command real-device winner selector**. It is test-only and does not change normal navigation into simulation unless it explicitly arms `/data/local/tmp/cairodrive_simulation`.

It tests all exact-target-safe path-algorithm modes:

1. `stock` — MagicEarth initial route and reroute.
2. `externalch-reroute` — initial route stays stock; ExternalCh is requested only for an active recalculation **if the exact intercepted route path is actually reached**.
3. `externalch-all` — ExternalCh is requested for all intercepted car calculations. This catches exact-target builds where the internal roadblock recalculation does not expose a separately patchable reroute request.

The exact supplied 7.1.26.26 APK was statically checked before this harness was added. Its Android SDK DEX contains `MagicEarth` and `ExternalCh`, plus `startSimulation`, `startSimulationWithRoute`, and `isSimulationActive`. It does not expose the newer `simplifiedMl` / `mlch` names. `libGEM.so` contains its contraction-hierarchy implementation marker.

## Run

After installing the signed v22.3 artifact on an ADB-connected phone:

```bash
./experiments/run_route_algo_ab_simulation.sh
```

Default workload: two repeats each of one short, one medium, and one long Cairo route for all three modes. The script uses Android's shell GPS test provider so every algorithm receives the same origin. On an OEM build that blocks shell mock locations, park the phone and use:

```bash
./experiments/run_route_algo_ab_simulation.sh --live-origin
```

The agent converts any normal Magic Earth `startNavigation*` request to the matching native Magic Lane `startSimulation*` overload. **If it cannot find a compatible simulation overload it refuses to fall through to real navigation.**

Once simulation is active, the harness asks CairoDrive to place the same bounded native Magic Lane roadblock ahead of the simulated vehicle. That exercises the real NavigationService reroute path and records `ROUTE_RECOMPUTE_E2E` rather than a desktop approximation.

## Decision

ExternalCh is promoted only if:

- simulation and reroute succeed consistently;
- the requested CH mode is proven to have actually changed `pathAlgorithm` on the relevant calculation path;
- no fatal/ANR/native crash appears;
- paired route distance/ETA do not materially regress;
- no known narrow-route regression appears;
- p90 improves by at least ~20%, **or** it repeatedly moves a >=1s stock p90 below 1s with at least ~10% improvement.

If the evidence is incomplete or the gain is small, the result is `stock`.

At completion the script writes the winning runtime mode to:

```text
/data/local/tmp/cairodrive_route_algo
```

and removes every simulation/benchmark marker before relaunching the app normally.

Reports are saved under `route-algo-ab-YYYYMMDD-HHMMSS/REPORT.md` and `report.json`.
