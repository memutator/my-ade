#!/usr/bin/env bash
# Poll `git log` for new commits on this branch; print each new commit once.
# Read via get_output (incremental) — every line is a commit that just landed.
set -u
cd "$(dirname "$0")/../../.."
seen=$(mktemp)
git log --format='%H' -50 >"$seen" 2>/dev/null
while :; do
  git log --format='%H %ad %s' --date=format:'%H:%M:%S' -50 2>/dev/null | while read -r sha rest; do
    if ! grep -q "^$sha\$" "$seen"; then
      echo "$sha" >>"$seen"
      echo "NEW-COMMIT ${sha:0:9} $rest"
    fi
  done
  sleep 20
done
