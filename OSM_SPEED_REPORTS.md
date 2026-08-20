# Speed-calming reports

The Magic Lane social-report taxonomy exposed by the target app does not contain a dedicated speed-bump report. Therefore CairoDrive must **not** rename or submit `Pothole` as `Speed bump`.

CairoDrive's Report menu has three local OSM review candidates:
- Speed bump -> `traffic_calming=bump`
- Speed hump -> `traffic_calming=hump`
- Raised table/crossing -> `traffic_calming=table`

When pressed, CairoDrive stores the current high-accuracy GPS point, accuracy, bearing, speed, provider and timestamp in the app's private external-files directory as GeoJSONL. It does **not** upload directly to OpenStreetMap. Direct OSM editing requires authenticated changesets and human verification; automatically uploading one-tap driving observations would risk bad map data.

Use `./export_osm_reports.sh` after the drive to pull and combine candidates into a normal GeoJSON FeatureCollection for review in an OSM-capable editor.
