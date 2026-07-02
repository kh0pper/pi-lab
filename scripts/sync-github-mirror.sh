#!/usr/bin/env bash
# sync-github-mirror.sh — publish local main to the public GitHub mirror
# (github.com/kh0pper/pi-lab) without publishing private history.
#
# The mirror has its own fresh history (no shared commits with origin) and
# deliberately sanitized public variants of a few docs. This script grafts the
# current tree of local main onto the mirror's history as ONE snapshot commit:
#   - every file syncs to local main's version (adds/edits/deletions included)
#   - PROTECTED files keep the mirror's version (or stay absent if the mirror
#     doesn't have them) — these are the public-sanitized docs
#
# Usage: scripts/sync-github-mirror.sh ["commit message"]
# Default message: subject line of local main's HEAD commit.
set -euo pipefail

MIRROR_URL="https://github.com/kh0pper/pi-lab.git"
MIRROR_BRANCH="main"
LOCAL_REF="main"
# Public-sanitized on the mirror — never overwrite from the private repo.
PROTECTED=(README.md CLAUDE.md examples/mcp.json)

cd "$(git rev-parse --show-toplevel)"

echo "Fetching mirror ${MIRROR_URL} ${MIRROR_BRANCH}..."
git fetch "$MIRROR_URL" "$MIRROR_BRANCH"
MIRROR_HEAD=$(git rev-parse FETCH_HEAD)

# Build the snapshot tree in a temp index: start from local main, then pin
# protected paths back to the mirror's blobs (or drop them).
TMP_INDEX=$(mktemp)
trap 'rm -f "$TMP_INDEX"' EXIT

GIT_INDEX_FILE="$TMP_INDEX" git read-tree "$LOCAL_REF"
for f in "${PROTECTED[@]}"; do
	if blob=$(git rev-parse --verify -q "$MIRROR_HEAD:$f"); then
		mode=$(git ls-tree "$MIRROR_HEAD" -- "$f" | awk '{print $1}')
		GIT_INDEX_FILE="$TMP_INDEX" git update-index --add --cacheinfo "$mode,$blob,$f"
	else
		GIT_INDEX_FILE="$TMP_INDEX" git update-index --force-remove "$f" || true
	fi
done
TREE=$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)

if [ "$TREE" = "$(git rev-parse "$MIRROR_HEAD^{tree}")" ]; then
	echo "Mirror already up to date (tree unchanged)."
	exit 0
fi

MSG=${1:-$(git log -1 --format=%s "$LOCAL_REF")}
COMMIT=$(git commit-tree "$TREE" -p "$MIRROR_HEAD" -m "$MSG")

echo "Publishing:"
git --no-pager diff --stat "$MIRROR_HEAD" "$COMMIT"
git push "$MIRROR_URL" "$COMMIT:refs/heads/$MIRROR_BRANCH"
echo "Mirror updated: ${MIRROR_HEAD:0:7}..${COMMIT:0:7}"
