#!/usr/bin/env python3
"""
CairoDrive v22.3 exact-device route-algorithm A/B simulation.

Purpose
-------
Run repeatable Magic Lane simulation reroutes on the real installed CairoDrive
binary and decide whether the exact-target ExternalCh path algorithm is worth
promoting over the stock MagicEarth algorithm.

This is intentionally an on-device benchmark. A desktop Python simulation cannot
measure the proprietary ARM64 Magic Lane routing engine. The script automates the
real data collection with ADB, Magic Earth's own route planning, Magic Lane's own
navigation simulator, and CairoDrive's native roadblock-triggered reroute timing.

Modes tested:
  stock                initial + reroute stock MagicEarth
  externalch-reroute   stock initial route; request ExternalCh on reroute when the
                       exact wrapper exposes that route-calculation path
  externalch-all       request ExternalCh on all intercepted car calculations

At the end, the script writes /data/local/tmp/cairodrive_route_algo to the winner:
  stock, externalch-reroute, or externalch-all
and removes the test-only simulation markers before relaunching CairoDrive.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shlex
import statistics
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

PACKAGE_DEFAULT = "com.cairodrive.app"
SIM_MARKER = "/data/local/tmp/cairodrive_simulation"
SIM_SPEED_MARKER = "/data/local/tmp/cairodrive_simulation_speed"
ALGO_MARKER = "/data/local/tmp/cairodrive_route_algo"
ROADBLOCK_MARKER = "/data/local/tmp/cairodrive_benchmark_roadblock"

# One historically stable route from each Cairo length bucket. These coordinates
# come from the project's existing Cairo route benchmark rather than invented
# points, keeping the A/B workload comparable with earlier route-quality work.
SCENARIOS = [
    ("short", "Tahrir -> Dokki", (30.0444, 31.2357), (30.0388, 31.2122)),
    ("mid", "City Stars -> Cairo Festival City", (30.0736, 31.3464), (30.0276, 31.4073)),
    ("long", "Cairo Airport -> Giza Pyramids", (30.1212, 31.4050), (29.9787, 31.1342)),
]

FATAL_RE = re.compile(r"FATAL EXCEPTION|ANR in |SIGSEGV|SIGABRT", re.I)
E2E_RE = re.compile(
    r"ROUTE_RECOMPUTE_E2E\s+reason=benchmark:(?P<reason>\S+)\s+ms=(?P<ms>-?\d+).*?"
    r"(?:algorithm=(?P<algorithm>\S+)\s+token=(?P<token>\S+))?"
)
BENCH_RE = re.compile(
    r"ROUTE_BENCH_RESULT\s+token=(?P<token>\S+)\s+phase=(?P<phase>\S+)\s+"
    r"algorithm=(?P<algorithm>\S+)\s+distanceM=(?P<distance>-?\d+)\s+etaS=(?P<eta>-?\d+)\s+"
    r"narrowKnown=(?P<narrow_known>yes|no)\s+narrow=(?P<narrow>yes|no)"
)
ALGO_APPLY_RE = re.compile(
    r"ROUTE_ALGO_APPLIED\s+stage=(?P<stage>\S+)\s+requested=(?P<requested>\S+)\s+"
    r"pathFieldChanged=(?P<changed>yes|no)\s+mode=(?P<mode>\S+)"
)


class BenchError(RuntimeError):
    pass


@dataclass
class Trial:
    mode: str
    scenario: str
    repeat: int
    token: str
    success: bool = False
    e2e_ms: Optional[int] = None
    simulation_rewrite: bool = False
    simulation_blocked: bool = False
    externalch_reroute_applied: bool = False
    externalch_initial_applied: bool = False
    before_distance_m: Optional[int] = None
    after_distance_m: Optional[int] = None
    before_eta_s: Optional[int] = None
    after_eta_s: Optional[int] = None
    after_narrow_known: bool = False
    after_narrow: bool = False
    fatal: bool = False
    note: str = ""
    log_file: str = ""


class ADB:
    def __init__(self, serial: str, verbose: bool = False):
        self.serial = serial
        self.verbose = verbose

    def run(self, args: Iterable[str], *, check: bool = True, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
        cmd = ["adb", "-s", self.serial, *map(str, args)]
        if self.verbose:
            print("+", shlex.join(cmd))
        cp = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
        if check and cp.returncode != 0:
            raise BenchError(f"ADB command failed ({cp.returncode}): {shlex.join(cmd)}\n{cp.stdout}\n{cp.stderr}")
        return cp

    def shell(self, *args: str, check: bool = True, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
        return self.run(["shell", *args], check=check, timeout=timeout)

    def write_text(self, path: str, value: str) -> None:
        # sh -c is used only for our fixed /data/local/tmp paths; the value is shell-quoted.
        cmd = f"printf %s {shlex.quote(value)} > {shlex.quote(path)}"
        self.shell("sh", "-c", cmd)

    def remove(self, *paths: str) -> None:
        self.shell("rm", "-f", *paths, check=False)

    def logcat(self) -> str:
        cp = self.run(["logcat", "-d", "-v", "threadtime", "cairodrive:I", "*:S"], check=False, timeout=20)
        return (cp.stdout or "") + (cp.stderr or "")

    def clear_logcat(self) -> None:
        self.run(["logcat", "-c"], check=False)


def choose_device(requested: Optional[str]) -> str:
    cp = subprocess.run(["adb", "devices"], text=True, capture_output=True, check=True)
    devices = [line.split()[0] for line in cp.stdout.splitlines()[1:] if len(line.split()) >= 2 and line.split()[1] == "device"]
    if requested:
        if requested not in devices:
            raise BenchError(f"Requested ADB device {requested!r} not available; devices={devices}")
        return requested
    if len(devices) == 1:
        return devices[0]
    physical = [d for d in devices if not d.startswith("emulator-")]
    if len(physical) == 1:
        return physical[0]
    raise BenchError(f"Need exactly one ADB device or --serial; devices={devices}")


def location_enabled(adb: ADB) -> Optional[bool]:
    value = (adb.shell("cmd", "location", "is-location-enabled", check=False).stdout or "").strip().lower()
    return True if value == "true" else False if value == "false" else None


def enable_shell_mock_location(adb: ADB) -> None:
    uid = (adb.shell("id", "-u", check=False).stdout or "2000").strip() or "2000"
    attempts = [
        ("appops", "set", uid, "android:mock_location", "allow"),
        ("appops", "set", "com.android.shell", "android:mock_location", "allow"),
        ("appops", "set", "--uid", "com.android.shell", "android:mock_location", "allow"),
    ]
    for command in attempts:
        cp = adb.shell(*command, check=False)
        if cp.returncode == 0:
            return
    raise BenchError("Phone refused MOCK_LOCATION for ADB shell; use a mock-location helper/root or run with --live-origin.")


def install_test_provider(adb: ADB, origin: tuple[float, float]) -> None:
    help_text = (adb.shell("cmd", "location", "help", check=False).stdout or "")
    if "add-test-provider" not in help_text:
        raise BenchError("This Android build lacks cmd location providers add-test-provider; use --live-origin if parked.")
    enable_shell_mock_location(adb)
    adb.shell("cmd", "location", "set-location-enabled", "true", check=False)
    adb.shell("cmd", "location", "providers", "remove-test-provider", "gps", check=False)
    cp = adb.shell(
        "cmd", "location", "providers", "add-test-provider", "gps",
        "--requiresSatellite", "--supportsSpeed", "--supportsBearing", "--accuracy", "1", check=False,
    )
    if cp.returncode != 0:
        raise BenchError("Could not create GPS test provider: " + ((cp.stdout or "") + (cp.stderr or "")).strip())
    cp = adb.shell("cmd", "location", "providers", "set-test-provider-enabled", "gps", "true", check=False)
    if cp.returncode != 0:
        raise BenchError("Could not enable GPS test provider")
    inject_location(adb, origin)


def inject_location(adb: ADB, point: tuple[float, float]) -> None:
    lat, lon = point
    now_ms = int(time.time() * 1000)
    cp = adb.shell(
        "cmd", "location", "providers", "set-test-provider-location", "gps",
        "--location", f"{lat:.7f},{lon:.7f}", "--accuracy", "3.0", "--time", str(now_ms), check=False,
    )
    if cp.returncode != 0:
        raise BenchError("Mock-location injection failed: " + ((cp.stdout or "") + (cp.stderr or "")).strip())


def remove_test_provider(adb: ADB, original_state: Optional[bool]) -> None:
    adb.shell("cmd", "location", "providers", "set-test-provider-enabled", "gps", "false", check=False)
    adb.shell("cmd", "location", "providers", "remove-test-provider", "gps", check=False)
    if original_state is not None:
        adb.shell("cmd", "location", "set-location-enabled", "true" if original_state else "false", check=False)


def wait_log(adb: ADB, pattern: re.Pattern[str], timeout: float) -> tuple[bool, str]:
    deadline = time.monotonic() + timeout
    latest = ""
    while time.monotonic() < deadline:
        latest = adb.logcat()
        if pattern.search(latest):
            return True, latest
        if FATAL_RE.search(latest):
            return False, latest
        time.sleep(0.35)
    return False, latest


def parse_bounds(raw: str) -> Optional[tuple[int, int]]:
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", raw or "")
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return ((x1 + x2) // 2, (y1 + y2) // 2)


def try_tap_start(adb: ADB) -> bool:
    remote = "/sdcard/cairodrive-ab-window.xml"
    adb.shell("uiautomator", "dump", remote, check=False, timeout=15)
    xml = adb.shell("cat", remote, check=False).stdout or ""
    if not xml.strip().startswith("<?xml"):
        return False
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return False
    words = re.compile(r"\b(start|go|navigate|demo|simulation)\b|ابدأ|بدء|انطلق|محاكاة|ملاحة", re.I)
    candidates = []
    for node in root.iter("node"):
        text = " ".join([node.attrib.get("text", ""), node.attrib.get("content-desc", ""), node.attrib.get("resource-id", "")]).strip()
        if not words.search(text):
            continue
        xy = parse_bounds(node.attrib.get("bounds", ""))
        if xy:
            score = 2 if node.attrib.get("clickable") == "true" else 1
            if re.search(r"demo|simulation|محاكاة", text, re.I):
                score += 3  # safest UI action if Magic Earth already offers Demo
            candidates.append((score, text, xy))
    if not candidates:
        return False
    candidates.sort(reverse=True)
    _, text, (x, y) = candidates[0]
    print(f"    UI fallback tap: {text!r} @ {x},{y}")
    adb.shell("input", "tap", str(x), str(y), check=False)
    return True


def launch_trial(adb: ADB, package: str, destination: tuple[float, float]) -> None:
    lat, lon = destination
    uri = f"google.navigation:q={lat:.7f},{lon:.7f}&mode=d"
    adb.shell("am", "force-stop", package, check=False)
    adb.shell(
        "am", "start", "-W", "-a", "android.intent.action.VIEW",
        "-c", "android.intent.category.BROWSABLE", "-d", uri, "-p", package,
        check=False, timeout=35,
    )


def parse_trial(log_text: str, trial: Trial) -> Trial:
    trial.simulation_rewrite = "SIMULATION_REWRITE_APPLIED" in log_text
    trial.simulation_blocked = "SIMULATION_REWRITE_BLOCKED" in log_text
    trial.fatal = bool(FATAL_RE.search(log_text))
    for m in E2E_RE.finditer(log_text):
        token = m.group("token") or m.group("reason")
        if token == trial.token or m.group("reason") == trial.token:
            trial.e2e_ms = int(m.group("ms"))
    before = after = None
    for m in BENCH_RE.finditer(log_text):
        if m.group("token") != trial.token:
            continue
        record = m.groupdict()
        if record["phase"] == "before":
            before = record
        elif record["phase"] == "after":
            after = record
    if before:
        trial.before_distance_m = int(before["distance"])
        trial.before_eta_s = int(before["eta"])
    if after:
        trial.after_distance_m = int(after["distance"])
        trial.after_eta_s = int(after["eta"])
        trial.after_narrow_known = after["narrow_known"] == "yes"
        trial.after_narrow = after["narrow"] == "yes"
    for m in ALGO_APPLY_RE.finditer(log_text):
        if m.group("requested") != "ExternalCh" or m.group("changed") != "yes":
            continue
        if m.group("stage") == "reroute":
            trial.externalch_reroute_applied = True
        if m.group("stage") == "initial":
            trial.externalch_initial_applied = True
    trial.success = bool(trial.simulation_rewrite and not trial.simulation_blocked and not trial.fatal and trial.e2e_ms is not None)
    if trial.fatal:
        trial.note = "crash/ANR/native fatal marker"
    elif trial.simulation_blocked:
        trial.note = "simulation rewrite had no compatible exact-target overload"
    elif not trial.simulation_rewrite:
        trial.note = "navigation start was not converted to simulation"
    elif trial.e2e_ms is None:
        trial.note = "benchmark roadblock did not produce a measured route update"
    return trial


def percentile(values: list[int], p: float) -> float:
    if not values:
        return math.nan
    values = sorted(values)
    if len(values) == 1:
        return float(values[0])
    pos = (len(values) - 1) * p
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi:
        return float(values[lo])
    return values[lo] * (hi - pos) + values[hi] * (pos - lo)


def stats_for(trials: list[Trial], mode: str) -> dict:
    selected = [t for t in trials if t.mode == mode]
    good = [t for t in selected if t.success and t.e2e_ms is not None]
    vals = [int(t.e2e_ms) for t in good]
    return {
        "mode": mode,
        "attempts": len(selected),
        "successes": len(good),
        "failures": len(selected) - len(good),
        "p50_ms": percentile(vals, .50),
        "p90_ms": percentile(vals, .90),
        "mean_ms": statistics.fmean(vals) if vals else math.nan,
        "best_ms": min(vals) if vals else math.nan,
        "worst_ms": max(vals) if vals else math.nan,
        "sub1s_rate": sum(v < 1000 for v in vals) / len(vals) if vals else 0.0,
        "reroute_path_applied": sum(t.externalch_reroute_applied for t in selected),
        "initial_path_applied": sum(t.externalch_initial_applied for t in selected),
    }


def paired_quality(trials: list[Trial], candidate: str) -> dict:
    by_key = {(t.mode, t.scenario, t.repeat): t for t in trials if t.success}
    pairs = []
    for t in trials:
        if t.mode != "stock" or not t.success:
            continue
        c = by_key.get((candidate, t.scenario, t.repeat))
        if not c or not c.success:
            continue
        if t.after_distance_m and c.after_distance_m and t.after_distance_m > 0:
            dist_delta = abs(c.after_distance_m - t.after_distance_m) / t.after_distance_m
        else:
            dist_delta = math.nan
        if t.after_eta_s and c.after_eta_s and t.after_eta_s > 0:
            eta_delta = abs(c.after_eta_s - t.after_eta_s) / t.after_eta_s
        else:
            eta_delta = math.nan
        narrow_regression = bool(t.after_narrow_known and c.after_narrow_known and not t.after_narrow and c.after_narrow)
        pairs.append((dist_delta, eta_delta, narrow_regression))
    dist = [x[0] for x in pairs if math.isfinite(x[0])]
    eta = [x[1] for x in pairs if math.isfinite(x[1])]
    return {
        "pairs": len(pairs),
        "median_distance_delta": statistics.median(dist) if dist else math.nan,
        "max_distance_delta": max(dist) if dist else math.nan,
        "median_eta_delta": statistics.median(eta) if eta else math.nan,
        "max_eta_delta": max(eta) if eta else math.nan,
        "narrow_regressions": sum(x[2] for x in pairs),
    }


def decide(trials: list[Trial]) -> tuple[str, str, dict]:
    stock = stats_for(trials, "stock")
    reroute = stats_for(trials, "externalch-reroute")
    all_mode = stats_for(trials, "externalch-all")
    details = {"stock": stock, "externalch-reroute": reroute, "externalch-all": all_mode}

    candidates = []
    for mode, st in [("externalch-reroute", reroute), ("externalch-all", all_mode)]:
        q = paired_quality(trials, mode)
        details[mode]["quality"] = q
        # The mode must actually mutate a pathAlgorithm field somewhere relevant.
        if mode == "externalch-reroute":
            effective = st["reroute_path_applied"] >= max(1, st["successes"] // 2)
        else:
            effective = st["initial_path_applied"] >= max(1, st["successes"] // 2)
        details[mode]["effective"] = effective
        if not effective or st["successes"] < 4 or st["failures"] > 0:
            continue
        # Require paired post-reroute route metrics for at least half of the good
        # samples. A latency win without route-quality visibility is inconclusive.
        if q["pairs"] < max(2, st["successes"] // 2):
            continue
        if q["narrow_regressions"] > 0:
            continue
        if math.isfinite(q["median_distance_delta"]) and q["median_distance_delta"] > 0.10:
            continue
        if math.isfinite(q["median_eta_delta"]) and q["median_eta_delta"] > 0.15:
            continue
        if stock["successes"] < 4 or stock["failures"] > 0 or not math.isfinite(stock["p90_ms"]):
            continue
        gain = (stock["p90_ms"] - st["p90_ms"]) / max(1.0, stock["p90_ms"])
        threshold_cross = stock["p90_ms"] >= 1000 and st["p90_ms"] < 1000 and gain >= 0.10
        clear_gain = gain >= 0.20 and st["p50_ms"] <= stock["p50_ms"] * 1.05 and st["sub1s_rate"] >= stock["sub1s_rate"]
        details[mode]["p90_gain"] = gain
        details[mode]["qualifies"] = bool(threshold_cross or clear_gain)
        if threshold_cross or clear_gain:
            candidates.append((st["p90_ms"], -st["sub1s_rate"], mode, gain))

    if candidates:
        candidates.sort()
        mode = candidates[0][2]
        gain = candidates[0][3]
        return mode, f"{mode} produced a meaningful safe p90 reroute improvement ({gain*100:.1f}%)", details

    # Stock is the conservative production fallback whenever CH does not earn promotion.
    if stock["successes"] >= 4 and stock["failures"] == 0:
        return "stock", "ExternalCh did not prove a large enough safe real-device advantage; keep MagicEarth", details
    return "stock", "Benchmark was incomplete/inconclusive; fail safe to MagicEarth", details


def markdown_report(trials: list[Trial], winner: str, reason: str, details: dict) -> str:
    lines = [
        "# CairoDrive route algorithm A/B simulation report",
        "",
        f"Winner/configured mode: **{winner}**",
        "",
        f"Reason: {reason}",
        "",
        "| Mode | Success | p50 ms | p90 ms | mean ms | <1s | ExternalCh applied |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for mode in ("stock", "externalch-reroute", "externalch-all"):
        st = details[mode]
        applied = st.get("reroute_path_applied", 0) if mode == "externalch-reroute" else st.get("initial_path_applied", 0)
        fmt = lambda v: "n/a" if not isinstance(v, (int, float)) or not math.isfinite(v) else f"{v:.0f}"
        lines.append(
            f"| {mode} | {st['successes']}/{st['attempts']} | {fmt(st['p50_ms'])} | {fmt(st['p90_ms'])} | "
            f"{fmt(st['mean_ms'])} | {st['sub1s_rate']*100:.1f}% | {applied} |"
        )
    lines += ["", "## Individual trials", "", "| Mode | Scenario | Rep | E2E ms | Simulation | CH reroute | CH initial | Fatal |", "|---|---|---:|---:|---|---|---|---|"]
    for t in trials:
        lines.append(
            f"| {t.mode} | {t.scenario} | {t.repeat} | {t.e2e_ms if t.e2e_ms is not None else 'FAIL'} | "
            f"{'yes' if t.simulation_rewrite else 'no'} | {'yes' if t.externalch_reroute_applied else 'no'} | "
            f"{'yes' if t.externalch_initial_applied else 'no'} | {'yes' if t.fatal else 'no'} |"
        )
    lines += ["", "The production app remains no-drive unless the explicit simulation marker is armed by this benchmark script.", ""]
    return "\n".join(lines)


def analyzer_selftest() -> None:
    # ExternalCh should win when it is really applied, stable, quality-compatible,
    # and substantially faster.
    trials: list[Trial] = []
    for rep, stock_ms, ext_ms in [(1, 1250, 720), (2, 1180, 680), (3, 1100, 700), (4, 1300, 740)]:
        trials.append(Trial("stock", "x", rep, f"s{rep}", True, stock_ms, True, False, False, False, 10000, 10100, 800, 810))
        trials.append(Trial("externalch-reroute", "x", rep, f"e{rep}", True, ext_ms, True, False, True, False, 10000, 10050, 800, 805))
        trials.append(Trial("externalch-all", "x", rep, f"a{rep}", True, 900, True, False, False, True, 10000, 10100, 800, 810))
    winner, _, _ = decide(trials)
    assert winner == "externalch-reroute", winner

    # A route-quality regression must keep stock even if CH is faster.
    for t in trials:
        if t.mode == "externalch-reroute":
            t.after_distance_m = 14000
    winner, _, _ = decide(trials)
    assert winner in {"stock", "externalch-all"}, winner


def run(args: argparse.Namespace) -> int:
    analyzer_selftest()
    if args.dry_run:
        print("Analyzer selftest: PASS")
        print("Exact-target modes to test: stock, externalch-reroute, externalch-all")
        for category, name, origin, dest in SCENARIOS:
            print(f"  {category:5s} {name}: {origin} -> {dest}")
        return 0

    serial = choose_device(args.serial)
    adb = ADB(serial, args.verbose)
    if adb.shell("pm", "path", args.package, check=False).returncode != 0:
        raise BenchError(f"{args.package} is not installed on {serial}")

    root = Path(args.output or f"route-algo-ab-{datetime.now().strftime('%Y%m%d-%H%M%S')}").resolve()
    root.mkdir(parents=True, exist_ok=True)
    original_location = location_enabled(adb)
    test_provider = False
    trials: list[Trial] = []

    modes = ["stock", "externalch-reroute", "externalch-all"]
    selected = [s for s in SCENARIOS if not args.scenarios or s[0] in set(args.scenarios.split(","))]
    if not selected:
        raise BenchError("No scenarios selected")

    try:
        adb.write_text(SIM_MARKER, "benchmark")
        adb.write_text(SIM_SPEED_MARKER, str(args.sim_speed))
        adb.remove(ROADBLOCK_MARKER)

        if not args.live_origin:
            print("Preparing repeatable ADB GPS test provider...")
            install_test_provider(adb, selected[0][2])
            test_provider = True

        for mode in modes:
            print(f"\n=== {mode} ===")
            adb.write_text(ALGO_MARKER, mode)
            for category, name, origin, destination in selected:
                for rep in range(1, args.repeats + 1):
                    token = f"{category}-r{rep}-{mode.replace('externalch-', 'ch-')}"
                    trial = Trial(mode, category, rep, token)
                    log_path = root / f"{token}.log"
                    trial.log_file = str(log_path)
                    print(f"  {category} rep {rep}: {name}")
                    try:
                        if test_provider:
                            inject_location(adb, origin)
                            time.sleep(0.8)
                        adb.clear_logcat()
                        adb.remove(ROADBLOCK_MARKER)
                        launch_trial(adb, args.package, destination)

                        rewrite_re = re.compile(r"SIMULATION_REWRITE_APPLIED|SIMULATION_REWRITE_BLOCKED|FATAL EXCEPTION|SIGSEGV|SIGABRT")
                        ok, logs = wait_log(adb, rewrite_re, args.start_timeout)
                        if "SIMULATION_REWRITE_APPLIED" not in logs and not FATAL_RE.search(logs):
                            # Autostart may be disabled. Safely tap a text-labelled Start/Demo control.
                            if try_tap_start(adb):
                                ok, logs = wait_log(adb, rewrite_re, 8.0)

                        if "SIMULATION_REWRITE_APPLIED" in logs:
                            time.sleep(args.settle_seconds)
                            control = json.dumps({"token": token, "startAheadM": args.start_ahead, "lengthM": args.block_length}, separators=(",", ":"))
                            adb.write_text(ROADBLOCK_MARKER, control)
                            end_re = re.compile(rf"ROUTE_RECOMPUTE_E2E\s+reason=benchmark:{re.escape(token)}\b|FATAL EXCEPTION|SIGSEGV|SIGABRT")
                            _, logs = wait_log(adb, end_re, args.reroute_timeout)
                            # Give onRouteUpdated a short chance to append route-quality metrics.
                            time.sleep(0.8)
                            logs = adb.logcat()
                        else:
                            logs = adb.logcat()
                    except Exception as exc:
                        logs = adb.logcat()
                        trial.note = str(exc)
                    finally:
                        adb.shell("am", "force-stop", args.package, check=False)
                    log_path.write_text(logs, encoding="utf-8", errors="replace")
                    parse_trial(logs, trial)
                    trials.append(trial)
                    result = f"{trial.e2e_ms} ms" if trial.e2e_ms is not None else f"FAIL ({trial.note})"
                    print(f"    -> {result}")

        winner, reason, details = decide(trials)
        report = {
            "winner": winner,
            "reason": reason,
            "package": args.package,
            "serial": serial,
            "trials": [asdict(t) for t in trials],
            "summary": details,
        }
        (root / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        (root / "REPORT.md").write_text(markdown_report(trials, winner, reason, details), encoding="utf-8")

        # Configure the measured winner, then leave simulation mode OFF for normal use.
        adb.write_text(ALGO_MARKER, winner)
        print(f"\nWINNER: {winner}\n{reason}")
        print(f"Report: {root / 'REPORT.md'}")
        return 0
    finally:
        adb.remove(SIM_MARKER, SIM_SPEED_MARKER, ROADBLOCK_MARKER)
        if test_provider:
            remove_test_provider(adb, original_location)
        # Relaunch with the selected production algorithm marker but no simulation marker.
        adb.shell("am", "force-stop", args.package, check=False)
        adb.shell("monkey", "-p", args.package, "-c", "android.intent.category.LAUNCHER", "1", check=False, timeout=20)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial")
    ap.add_argument("--package", default=PACKAGE_DEFAULT)
    ap.add_argument("--repeats", type=int, default=2, help="repeats per scenario per algorithm mode")
    ap.add_argument("--scenarios", default="short,mid,long", help="comma-separated: short,mid,long")
    ap.add_argument("--sim-speed", type=float, default=2.0)
    ap.add_argument("--start-ahead", type=int, default=500)
    ap.add_argument("--block-length", type=int, default=180)
    ap.add_argument("--settle-seconds", type=float, default=0.8)
    ap.add_argument("--start-timeout", type=float, default=20.0)
    ap.add_argument("--reroute-timeout", type=float, default=25.0)
    ap.add_argument("--output")
    ap.add_argument("--live-origin", action="store_true", help="do not mock GPS; use the parked phone's real current position")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.repeats < 1:
        ap.error("--repeats must be >=1")
    try:
        return run(args)
    except (BenchError, subprocess.SubprocessError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
