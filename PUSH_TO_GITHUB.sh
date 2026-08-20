#!/usr/bin/env bash
set -euo pipefail
REPO='EsmailELBoBDev2/Magic_Earth'
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
command -v git >/dev/null || { echo 'ERROR: git missing' >&2; exit 1; }
command -v gh >/dev/null || { echo 'ERROR: gh CLI missing. On Arch: sudo pacman -S github-cli && gh auth login' >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null
REMOTE="$(git remote get-url origin)"
case "$REMOTE" in
  *github.com/EsmailELBoBDev2/Magic_Earth.git|*github.com:EsmailELBoBDev2/Magic_Earth.git) ;;
  *) echo "ERROR: wrong origin: $REMOTE" >&2; exit 2;;
esac
VIS="$(gh repo view "$REPO" --json visibility -q .visibility)"
[[ "$VIS" == 'PRIVATE' ]] || { echo "ERROR: $REPO visibility is $VIS. Make it PRIVATE before pushing." >&2; exit 3; }
./VERIFY_REPO.sh
# Correct form of the command that previously failed. Literal ... is NOT valid awk.
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  BIG="$(git ls-tree -rl HEAD | awk '$4 >= 100*1024*1024 {print}')"
  [[ -z "$BIG" ]] || { echo 'ERROR: current HEAD contains >=100 MiB blobs:' >&2; echo "$BIG" >&2; exit 4; }
fi
git add -A
# Check staged blobs, including new files not yet in HEAD.
while read -r mode sha stage path; do
  [[ -n "${sha:-}" ]] || continue
  size="$(git cat-file -s "$sha")"
  if (( size >= 100*1024*1024 )); then echo "ERROR: staged blob >=100MiB: $path ($size bytes)" >&2; exit 5; fi
done < <(git ls-files -s)
if git diff --cached --quiet; then
  echo 'No new staged changes; pushing existing local commits.'
else
  git commit -m 'CairoDrive v22.3 portable drive-test CI'
fi
git branch -M main
git push -u origin main
echo
echo 'PUSH COMPLETE.'
echo 'GitHub Actions should start automatically: Build CairoDrive signed APK + AAB'
