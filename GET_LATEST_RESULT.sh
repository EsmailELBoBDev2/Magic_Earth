#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="${CAIRODRIVE_REPO:-EsmailELBoBDev2/Magic_Earth}"
command -v gh >/dev/null || { echo 'ERROR: gh CLI missing' >&2; exit 2; }
gh auth status >/dev/null
RUN_ID="${1:-}"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow build.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
fi
META="$(gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion,url,headSha --jq '[.status,(.conclusion//""),.headSha,.url]|@tsv')"
IFS=$'\t' read -r STATUS CONCLUSION SHA URL <<<"$META"
echo "Run $RUN_ID: status=$STATUS conclusion=${CONCLUSION:-pending}"
echo "$URL"
if [[ "$STATUS" != completed ]]; then
  echo 'Run is not complete yet; nothing downloaded.'
  exit 0
fi
DEST="${CAIRODRIVE_DOWNLOAD_DIR:-$HOME/Downloads/CairoDrive-run-$RUN_ID}"
rm -rf "$DEST"; mkdir -p "$DEST"
gh run download "$RUN_ID" --repo "$REPO" --dir "$DEST"
echo "Downloaded all available artifacts to: $DEST"
find "$DEST" -maxdepth 2 -type f -printf '%p\n' | sort
REPORT="$(find "$DEST" -type f -name 'FUTURE_APK_REPORT.txt' -print -quit || true)"
if [[ -n "$REPORT" ]]; then
  echo
  echo 'For a failed/new incompatible APK, send me this file first:'
  echo "$REPORT"
fi
