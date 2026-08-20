#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
AG="$ROOT/payload/cairodrive-google-search-only.js"
SEARCH_CORE="$ROOT/payload/search-core.mjs"
NAV_CORE="$ROOT/payload/nav-core.mjs"
TRAFFIC_CORE="$ROOT/payload/traffic-core.mjs"
HTTP="$ROOT/payload/helper/com/cairodrive/search/AsyncHttp.java"
BANNER="$ROOT/payload/helper/com/cairodrive/nav/NavBanner.java"
AUTOCOMPLETE_PANEL="$ROOT/payload/helper/com/cairodrive/search/AutocompletePanel.java"
FILTER="$ROOT/payload/libcairodrive_filter.so"
CLOG="$ROOT/payload/helper/com/cairodrive/log/CairoLog.java"
BOOTSTRAP="$ROOT/payload/helper/com/cairodrive/bootstrap/GadgetBootstrapProvider.java"

for f in "$AG" "$SEARCH_CORE" "$NAV_CORE" "$TRAFFIC_CORE" "$HTTP" "$BANNER" "$AUTOCOMPLETE_PANEL" "$CLOG" "$BOOTSTRAP" "$FILTER" "$ROOT/payload/build_patch.sh" "$ROOT/provision_google_key.sh"; do
  [[ -s "$f" ]] || { echo "missing: $f" >&2; exit 1; }
done

node "$ROOT/search_core_selftest.mjs"
node "$ROOT/nav_core_selftest.mjs"
node "$ROOT/traffic_core_selftest.mjs"
cp "$AG" /tmp/cairodrive-v22.3-agent-check.mjs
node --check /tmp/cairodrive-v22.3-agent-check.mjs

for s in "$ROOT"/*.sh "$ROOT"/ci/*.sh "$ROOT/payload/build_patch.sh"; do bash -n "$s"; done

# Core invariants.
grep -q "CAIRODRIVE_READY" "$AG"
grep -q "MAGICLANE_TRAFFIC_ENABLED" "$AG"
grep -q "NAV_ROUTE_PREFS_PATCHED" "$AG"
grep -q "LANE_ASSIST_READY" "$AG"
grep -q "DRIVE_ASSIST_SHOW" "$AG"
grep -q "SOCIAL_REPORT_SENT" "$AG"
grep -q "VOICE_REPEAT_PLAY" "$AG"
grep -q "DRIVE_TRACE" "$AG"
grep -q "function driveTraceEnabled(){ return true; }" "$AG"
grep -q "CairoLog" "$AG"
grep -q "BUCKET_MS = 3L" "$CLOG"
grep -q "RETAIN_MS = 30L" "$CLOG"
[[ -x "$ROOT/pull_logs.sh" ]]
grep -q "System.loadLibrary(\"gadget\")" "$BOOTSTRAP"
grep -q "GadgetBootstrapProvider" "$ROOT/tools/rewrite_manifest.py"
! grep -q "patch_libflutter.py" "$ROOT/payload/build_patch.sh"
grep -q "OSM_TRAFFIC_CALMING_QUEUED" "$AG"
grep -q "traffic_calming=" "$AG"
grep -q "LANDMARK_BASIC_POPULATED" "$AG"
grep -q "LANDMARK_DETAILS_ENRICHED" "$AG"
grep -q "LANDMARK_CONTACT_POPULATED" "$AG"
grep -q "ContactInfo" "$AG"
grep -q "Speed bump — save for OSM" "$AG"
[[ -x "$ROOT/export_osm_reports.sh" ]]
[[ -f "$ROOT/GOOGLE_TRAFFIC_THEORETICAL_PROMPT.md" ]]
[[ -f "$ROOT/NARROW_ROAD_ALGORITHM.md" ]]
grep -q "addExtraInfo" "$AG"
grep -q "setDescription" "$AG"
grep -q "DETAILS_FIELD_MASK" "$SEARCH_CORE"
grep -q "detailsFieldMaskForType" "$SEARCH_CORE"
grep -q "MIN_QUERY_CODEPOINTS = 3" "$SEARCH_CORE"
grep -q "places.attributions" "$SEARCH_CORE"
grep -q "'currentOpeningHours'" "$SEARCH_CORE"
grep -q "'parkingOptions'" "$SEARCH_CORE"
grep -q "'fuelOptions'" "$SEARCH_CORE"
! grep -q "places.evCharge" "$SEARCH_CORE"
grep -q "consumeAction" "$BANNER"
grep -q "⋯ CairoDrive" "$BANNER"
grep -q "showReportChoices" "$BANNER"
grep -q "SOCIAL_REPORT_CATEGORIES" "$AG"
grep -q "STOCK_ALARMS_RESPECTED" "$AG"
! grep -q "enableSafetyCamera" "$AG"
! grep -q "enableSocialReports" "$AG"
grep -q "KEYCODE_MEDIA_PAUSE" "$BANNER"
grep -q "getLaneImage" "$AG"
grep -q "getAbstractGeometryImage" "$AG"
grep -q "getRealisticNextTurnImage" "$AG"
grep -q "getSignpostDetails" "$AG"
grep -q "NARROW_EVIDENCE" "$AG"
grep -q "ARRIVAL_OPEN_CHECK" "$AG"
grep -q "mirrorBatch" "$AG"
grep -q "MAX_SEGMENT_BYTES" "$CLOG"
grep -q "asBitmap(720,180" "$AG"
grep -q "patchRouteRequestObject" "$AG"
grep -q "avoidunpavedroads" "$NAV_CORE"
grep -q "avoidtraffic" "$NAV_CORE"
grep -q "routetype" "$NAV_CORE"
grep -qi "accuratewaypointsapproach" "$NAV_CORE"
grep -qi "departureheading" "$NAV_CORE"
# KISS: these fields are explicitly documented as preserved defaults / non-owned preferences.
! grep -q "nk === 'avoidturnaroundinstruction'" "$NAV_CORE"
grep -q "nk === 'allowonlinecalculation' && enums.preferOnlineCalculation === true" "$NAV_CORE"
! grep -q "nk === 'automatictimestamp'" "$NAV_CORE"
grep -q "nk === 'alternativesschema' && enums.fastReroute === true" "$NAV_CORE"
grep -q "alternativesNever" "$NAV_CORE"
! grep -q "nk === 'alternativeroutesbalancedsorting'" "$NAV_CORE"
! grep -q "nk === 'resultdetails'" "$NAV_CORE"
grep -q "nk === 'pathalgorithm' && Number.isFinite(enums.experimentalPathAlgorithmValue)" "$NAV_CORE"
grep -q "ROUTE_ALGO_EXPERIMENT_MODE" "$AG"
grep -q "ROUTE_ALGO_ENUMS" "$AG"
test -x "$ROOT/experiments/route_algo_stock.sh"
test -x "$ROOT/experiments/route_algo_externalch_all.sh"
test -x "$ROOT/experiments/route_algo_externalch_reroute.sh"
test -x "$ROOT/experiments/compare_recompute_logs.py"
! grep -q "nk === 'accuratetrackmatch'" "$NAV_CORE"
! grep -q "nk === 'maximumdistanceconstraint'" "$NAV_CORE"
! grep -q "nk === 'truckprofile'" "$NAV_CORE"
grep -q "buildterrainprofile" "$NAV_CORE"
grep -q "SEARCH_INTERCEPT" "$AG"
grep -q "places:searchText" "$SEARCH_CORE"
grep -q "places:autocomplete" "$SEARCH_CORE"
grep -q "searchAlongRouteParameters" "$SEARCH_CORE"
grep -q "routingSummaries" "$SEARCH_CORE"
grep -q "routingPreference:'TRAFFIC_AWARE'" "$SEARCH_CORE"
grep -q "__routeRankSeconds" "$SEARCH_CORE"
grep -q "encodeGooglePolyline" "$SEARCH_CORE"
grep -q "SEARCH_ALONG_ROUTE_GOOGLE" "$AG"
grep -qi "departureheading" "$NAV_CORE"
grep -q "SPEED_ASSIST" "$AG"
grep -q "getCurrentStreetSpeedLimit" "$AG"
grep -q "getNextSpeedLimitVariation" "$AG"
grep -q "MAGICLANE_TRAFFIC_EVENT" "$AG"
grep -q "getTrafficEvents" "$AG"
grep -q "BETTER_ROUTE_AUTO_SWITCH" "$AG"
grep -q "BETTER_ROUTE_INVALIDATED" "$AG"
grep -q "ROUTE_RECOMPUTE_STARTED" "$AG"
grep -q "ROUTE_RECOMPUTE_DONE" "$AG"
grep -q "ROUTE_RECOMPUTE_E2E" "$AG"
grep -q "WaitingRoute" "$AG"
grep -q "alternativesNever" "$AG"
grep -q "fastReroute=activeNav" "$AG"
grep -q "enableTerrainProfile=!activeNav" "$AG"
grep -q "GOOGLE_TRAFFIC_PAUSED" "$AG"
grep -q "}},40);" "$AG"
grep -q "ROUTE_RECOMPUTE_TARGET_MS = 1000" "$AG"
grep -q "onBetterRouteDetected" "$AG"
grep -q "startNavigationWithRoute" "$AG"
grep -q "BETTER_ROUTE_ROLLBACK" "$AG"
grep -q "ROUTE_WARNINGS" "$AG"
grep -q "hasTollRoads" "$AG"
grep -q "hasFerryConnections" "$AG"
grep -q "NAVIGATION_STATUS" "$AG"
grep -q "ROUTE_RESTRICTION" "$AG"
grep -q "getCurrentRestrictions" "$AG"
grep -q "getRestrictionSections" "$AG"
grep -q "sessionToken" "$SEARCH_CORE"
grep -q "AUTOCOMPLETE_PANEL_SHOW" "$AG"
grep -q "startTrafficPostJson" "$HTTP"
grep -q "directions/v2:computeRoutes" "$TRAFFIC_CORE"
grep -q "TRAFFIC_ON_POLYLINE" "$TRAFFIC_CORE"
grep -q "TRAFFIC_AWARE" "$TRAFFIC_CORE"
grep -q "GOOGLE_TRAFFIC_MATCH" "$AG"
grep -q "GOOGLE_TRAFFIC_LEVEL" "$AG"
grep -q "classifyTrafficLevel" "$TRAFFIC_CORE"
grep -q "native-better-route-decision" "$AG"
grep -q "BETTER_ROUTE_SUGGEST" "$AG"
grep -q "strongNarrowEvidenceOnRoute" "$AG"
grep -q "reason=candidate-narrow" "$AG"
grep -q "onlineCalculation=.*initial-if-exposed" "$AG"
grep -q "GOOGLE_TRAFFIC_ROADBLOCK" "$AG"
grep -q "invokeNavigationRoadBlock(length,ahead,'google-traffic')" "$AG"
grep -q "invokeNavigationRoadBlock(Math.min(600,len+30),ahead,'narrow-road')" "$AG"
grep -q "maxDistanceM=35" "$TRAFFIC_CORE"
grep -q "maxHeadingDiffDeg=40" "$TRAFFIC_CORE"
grep -q "newSingleThreadExecutor" "$HTTP"
grep -q 'Accept-Encoding", "gzip"' "$HTTP"
grep -q "GZIPInputStream" "$HTTP"
grep -q "setUseCaches(false)" "$HTTP"
grep -qi "accuratewaypointsapproach" "$NAV_CORE"
grep -qi "getRemainingTravelTimeDistanceToNextWaypoint" "$AG"
grep -qi "getNextWaypointDriveSide" "$AG"
grep -qi "nextWaypointEtaSide=yes" "$AG"
grep -q "buildTrafficEdgeGrid" "$TRAFFIC_CORE"
grep -q "candidateChecks" "$TRAFFIC_CORE"
grep -q "consumerAlert" "$SEARCH_CORE"
grep -q "NEARBY_SEARCH_URL" "$SEARCH_CORE"
grep -q "places:searchNearby" "$SEARCH_CORE"
grep -q "rankPreference:'DISTANCE'" "$SEARCH_CORE"
grep -q "routingParameters" "$SEARCH_CORE"
grep -q "routingSummaries:routeAware" "$AG"
grep -q "Drive:" "$SEARCH_CORE"
grep -q "googleTypesForMagicCategory" "$SEARCH_CORE"
grep -q "selectPreferredEntrance" "$SEARCH_CORE"
grep -q "formatDistanceMeters" "$SEARCH_CORE"
! grep -q "regularOpeningHours" "$SEARCH_CORE"
! grep -q "subDestinations" "$SEARCH_CORE"
grep -q "GOOGLE_NEARBY_REQUEST" "$AG"
grep -q "CATEGORY_NATIVE_FALLBACK" "$AG"
grep -q "PLACE_DETAILS_MOVED_FOLLOW" "$AG"
grep -q "businessStatusLabel" "$SEARCH_CORE"
grep -q "androidNetworkAvailable" "$AG"
grep -q "biasFromSearchArgs" "$AG"
grep -q "Preferred entrance: Google mapped entry point" "$SEARCH_CORE"
grep -q "setOverSpeedThreshold(1.39,true)" "$AG"
grep -q "setOverSpeedThreshold(2.78,false)" "$AG"
grep -q "setMonitorWithoutRoute(true)" "$AG"
grep -q "getRoadInfoImage" "$AG"
grep -q "getNextTurnImage" "$AG"
grep -q "getRemainingTravelTimeDistance" "$AG"
grep -q "getRoundaboutExitNumber" "$AG"
grep -q "getReturnToRoutePosition" "$AG"
grep -q "wakeNavigationAssist" "$AG"
[[ -f "$ROOT/ONLINE_FEATURE_SWEEP_V22.3.md" ]]
[[ -f "$ROOT/V22.3_FEATURE_OPT_AUDIT.md" ]]
[[ -f "$ROOT/.github/workflows/build.yml" ]]
[[ -f "$ROOT/GITHUB_CI_STATUS.md" ]]
[[ -x "$ROOT/PUSH_TO_GITHUB.sh" ]]
[[ -x "$ROOT/patch.sh" ]]
[[ -x "$ROOT/ci/reassemble-base-apk.sh" ]]
grep -q "com.cairodrive.app" "$ROOT/.github/workflows/build.yml"
grep -q "CairoDrive-v22.3-DRIVE-TEST-com.cairodrive.app" "$ROOT/.github/workflows/build.yml"
grep -q "reassemble-base-apk.sh" "$ROOT/ci/fetch-base-apk.sh"
grep -q "17.17.0" "$ROOT/ci/fetch-frida-gadget.sh"
python3 -m py_compile "$ROOT/tools/summarize_recompute.py" "$ROOT/experiments/run_route_algo_ab_simulation.py" "$ROOT/ci/verify-target-routing-surface.py"
"$ROOT/experiments/run_route_algo_ab_simulation.py" --dry-run >/dev/null
bash -n "$ROOT/watch_drive.sh" "$ROOT/watch_nav.sh" "$ROOT/watch_search.sh" "$ROOT/experiments/run_route_algo_ab_simulation.sh"
[[ -x "$ROOT/experiments/run_route_algo_ab_simulation.sh" ]]
[[ -f "$ROOT/experiments/AUTO_SIM_AB.md" ]]
grep -q "SIMULATION_REWRITE_APPLIED" "$AG"
grep -q "SIMULATION_REWRITE_BLOCKED" "$AG"
grep -q "startSimulationWithRoute" "$AG"
grep -q "isSimulationActive" "$AG"
grep -q "ROUTE_BENCH_TRIGGER" "$AG"
grep -q "ROUTE_BENCH_RESULT" "$AG"
grep -q "ROUTE_ALGO_APPLIED" "$AG"
grep -q "externalch-reroute" "$ROOT/experiments/run_route_algo_ab_simulation.py"
grep -q "externalch-all" "$ROOT/experiments/run_route_algo_ab_simulation.py"
grep -q "newer simplifiedMl/mlch enum names: absent" "$ROOT/ci/verify-target-routing-surface.py"
! grep -qiE "simplifiedMl|\bmlch\b" "$AG"
grep -q "EXPECTED_LIBAPP_SHA256='558e04e9a41aca50a3409ee7640785eedfefb23ff1fe787865b7595f029e19a4'" "$ROOT/payload/build_patch.sh"
grep -q 'future-compatible' "$ROOT/payload/build_patch.sh"
grep -q 'FUTURE_COMPATIBLE_CANDIDATE' "$ROOT/tools/preflight.py"
grep -q 'DART_POST_DISCOVERED' "$AG"
grep -q "patch_search_debounce.py" "$ROOT/payload/build_patch.sh"
grep -q "PATCHED =bytes.fromhex('00 32 80 d2')" "$ROOT/tools/patch_search_debounce.py"
grep -q "com.cairodrive.app" "$ROOT/provision_google_key.sh"
grep -q "com.generalmagic.magicearth" "$ROOT/provision_google_key.sh"

[[ ! -e "$ROOT/payload/libflutter.patched.so" ]] || { echo "proprietary-derived libflutter.patched.so must not be shipped" >&2; exit 1; }

# Google network scope is deliberately narrow: Places Search/Autocomplete/Details
# plus Routes computeRoutes traffic advisory. No map tiles, route matrix or other
# Google mapping surfaces are permitted in the payload.
grep -q "https://routes.googleapis.com/directions/v2:computeRoutes" "$TRAFFIC_CORE"
! grep -RqiE 'routeMatrix|mapsplatform\.googleapis|maptiles|roads\.googleapis|geolocation\.googleapis' "$AG" "$SEARCH_CORE" "$NAV_CORE" "$TRAFFIC_CORE"
ENDPOINTS="$(grep -RhoE "https://[^'\" ]+" "$ROOT/payload" --include='*.js' --include='*.mjs' | sort -u || true)"
[[ "$(printf '%s\n' "$ENDPOINTS" | sed '/^$/d' | wc -l)" -le 5 ]]
if [[ -n "$ENDPOINTS" ]]; then
  ! printf '%s\n' "$ENDPOINTS" | grep -vE '^https://(places\.googleapis\.com/v1/places|routes\.googleapis\.com/directions/v2:computeRoutes)' >/dev/null
fi
! grep -q "FieldMask.*\*\|FIELD_MASK.*\*" "$SEARCH_CORE" "$TRAFFIC_CORE"

# No old v10 hook families.
! grep -qiE 'Process\.setExceptionHandler|installAndroidAuto|AudioFocus|AudioTrack|MediaPlayer|TrafficOverlay|hazardDedupe|STOCK_SIMULATION|GLThread|premium' "$AG"
! grep -RqsE 'AIza[0-9A-Za-z_-]{25,}' "$ROOT/payload" "$ROOT/tools" "$ROOT/ci" "$ROOT/experiments"

# Native filter is arm64 and exactly scopes search + route calculation.
file "$FILTER" | grep -q 'ARM aarch64'
readelf -h "$FILTER" | grep -q 'AArch64'
readelf -Ws "$FILTER" | grep -q 'cd_set_route_handler'
grep -q 'RoutingService' "$ROOT/payload/cairodrive-native-filter.c"
grep -q 'calculateRoute' "$ROOT/payload/cairodrive-native-filter.c"
grep -q 'SearchService' "$ROOT/payload/cairodrive-native-filter.c"
grep -q 'searchLandmarkDetails' "$ROOT/payload/cairodrive-native-filter.c"
! grep -qiE 'NavigationInstruction|TrafficPreferences|hazard|camera|bump' "$ROOT/payload/cairodrive-native-filter.c"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP" /tmp/cairodrive-v22.3-agent-check.mjs' EXIT
cc -O2 -I"$ROOT" "$ROOT/filter_selftest.c" -o "$TMP/filter-selftest"
"$TMP/filter-selftest"

# Minimal compile-time Android/org.json stubs so both helper sources receive a
# real javac syntax/type pass even when this verifier runs without an Android SDK.
mkdir -p "$TMP/src/org/json" "$TMP/src/android/app" "$TMP/src/android/content" "$TMP/src/android/content/res" "$TMP/src/android/util" "$TMP/src/android/graphics" "$TMP/src/android/graphics/drawable" "$TMP/src/android/media" "$TMP/src/android/os" "$TMP/src/android/view" "$TMP/src/android/widget" "$TMP/out"
cat > "$TMP/src/org/json/JSONObject.java" <<'J'
package org.json; import java.util.*; public class JSONObject { public JSONObject(String s){} public Iterator<String> keys(){return Collections.<String>emptyList().iterator();} public String optString(String k,String d){return d;} }
J
cat > "$TMP/src/android/util/DisplayMetrics.java" <<'J'
package android.util; public class DisplayMetrics { public float density=1f; }
J
cat > "$TMP/src/android/content/res/Resources.java" <<'J'
package android.content.res; public class Resources { public android.util.DisplayMetrics getDisplayMetrics(){return new android.util.DisplayMetrics();} }
J
cat > "$TMP/src/android/content/Context.java" <<'J'
package android.content; public class Context { public static final String AUDIO_SERVICE="audio"; public Object getSystemService(String s){return null;} public Context getApplicationContext(){return this;} public java.io.File getExternalFilesDir(String s){return null;} }
J
cat > "$TMP/src/android/graphics/Color.java" <<'J'
package android.graphics; public class Color { public static final int WHITE=0xffffffff; }
J
cat > "$TMP/src/android/graphics/Bitmap.java" <<'J'
package android.graphics; public class Bitmap { public boolean isRecycled(){return false;} public void recycle(){} }
J
cat > "$TMP/src/android/graphics/Typeface.java" <<'J'
package android.graphics; public class Typeface { public static final Typeface DEFAULT_BOLD=new Typeface(); }
J
cat > "$TMP/src/android/graphics/drawable/GradientDrawable.java" <<'J'
package android.graphics.drawable; public class GradientDrawable { public void setColor(int c){} public void setCornerRadius(float r){} public void setStroke(int w,int c){} }
J
cat > "$TMP/src/android/view/Gravity.java" <<'J'
package android.view; public class Gravity { public static final int CENTER_HORIZONTAL=1,CENTER=2,CENTER_VERTICAL=3; }
J
cat > "$TMP/src/android/view/KeyEvent.java" <<'J'
package android.view; public class KeyEvent { public static final int ACTION_DOWN=0,ACTION_UP=1,KEYCODE_MEDIA_PAUSE=127; public KeyEvent(long a,long b,int c,int d,int e){} }
J
cat > "$TMP/src/android/os/SystemClock.java" <<'J'
package android.os; public class SystemClock { public static long uptimeMillis(){return 0;} }
J
cat > "$TMP/src/android/media/AudioManager.java" <<'J'
package android.media; public class AudioManager { public void dispatchMediaKeyEvent(android.view.KeyEvent e){} }
J
cat > "$TMP/src/android/view/View.java" <<'J'
package android.view; public class View { public static final int GONE=8,VISIBLE=0; public Object getParent(){return null;} public void setVisibility(int v){} public void setY(float y){} public interface OnClickListener{void onClick(View v);} }
J
cat > "$TMP/src/android/view/ViewGroup.java" <<'J'
package android.view; public class ViewGroup extends View { public static class LayoutParams { public static final int MATCH_PARENT=-1,WRAP_CONTENT=-2; public LayoutParams(int w,int h){} } public static class MarginLayoutParams extends LayoutParams { public int leftMargin,rightMargin,topMargin,bottomMargin; public MarginLayoutParams(int w,int h){super(w,h);} } public void addView(View v,LayoutParams p){} public void removeView(View v){} public void removeAllViews(){} public int getHeight(){return 1000;} }
J
cat > "$TMP/src/android/app/Activity.java" <<'J'
package android.app; public class Activity extends android.content.Context { public boolean isFinishing(){return false;} public void runOnUiThread(Runnable r){r.run();} public android.content.res.Resources getResources(){return new android.content.res.Resources();} public android.view.View findViewById(int id){return null;} }
J
cat > "$TMP/src/android/app/AlertDialog.java" <<'J'
package android.app; public class AlertDialog { public static class Builder { public Builder(Activity a){} public Builder setTitle(CharSequence s){return this;} public Builder setItems(String[] s, android.content.DialogInterface.OnClickListener l){return this;} public Builder setNegativeButton(CharSequence s, android.content.DialogInterface.OnClickListener l){return this;} public AlertDialog show(){return new AlertDialog();} } }
J
cat > "$TMP/src/android/content/DialogInterface.java" <<'J'
package android.content; public interface DialogInterface { interface OnClickListener { void onClick(DialogInterface d,int which); } }
J
cat > "$TMP/src/android/R.java" <<'J'
package android; public final class R { public static final class id { public static final int content=1; } }
J
cat > "$TMP/src/android/widget/ImageView.java" <<'J'
package android.widget; public class ImageView extends android.view.View { public enum ScaleType { CENTER_INSIDE } public ImageView(android.app.Activity a){} public void setAdjustViewBounds(boolean b){} public void setScaleType(ScaleType t){} public void setImageBitmap(android.graphics.Bitmap b){} }
J
cat > "$TMP/src/android/widget/LinearLayout.java" <<'J'
package android.widget; public class LinearLayout extends android.view.ViewGroup { public static final int VERTICAL=1,HORIZONTAL=0; public static class LayoutParams extends android.view.ViewGroup.LayoutParams { public LayoutParams(int w,int h){super(w,h);} public LayoutParams(int w,int h,float weight){super(w,h);} public void setMargins(int a,int b,int c,int d){} } public LinearLayout(android.app.Activity a){} public void setOrientation(int i){} public void setGravity(int i){} public void setPadding(int a,int b,int c,int d){} public void setBackground(Object o){} public Object getBackground(){return new android.graphics.drawable.GradientDrawable();} public void setElevation(float e){} public void bringToFront(){} }
J
cat > "$TMP/src/android/widget/TextView.java" <<'J'
package android.widget; public class TextView extends android.view.View { public TextView(android.app.Activity a){} public void setTextColor(int c){} public void setTypeface(android.graphics.Typeface t){} public void setTextSize(float s){} public void setGravity(int g){} public void setMaxLines(int n){} public void setText(CharSequence s){} }
J
cat > "$TMP/src/android/widget/Button.java" <<'J'
package android.widget; public class Button extends TextView { public Button(android.app.Activity a){super(a);} public void setAllCaps(boolean b){} public void setBackground(Object o){} public void setMinHeight(int h){} public void setPadding(int a,int b,int c,int d){} public void setOnClickListener(android.view.View.OnClickListener l){} }
J
javac --release 8 -d "$TMP/out" $(find "$TMP/src" -name '*.java' -print) "$HTTP" "$BANNER" "$AUTOCOMPLETE_PANEL" "$CLOG" >/dev/null

echo "v22.3 KISS + fast-reroute + auto-sim-AB static verification: PASS"
