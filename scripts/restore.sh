#!/usr/bin/env bash
# Restore a goods-shelf restic backup into a NEW directory (never touches the live data directory).
#   scripts/restore.sh [--env-file FILE] <target-dir> [snapshot-id|latest]
# Then, to actually switch the instance over (after checking the result; add the same -p / --env-file
# you use for this instance, and use its GS_DATA / GS_UID:GS_GID instead of data and 1000:1000):
#   docker compose stop goods-shelf
#   mv data data.before-restore && mv <target-dir>/data data
#   sudo chown -R 1000:1000 data
#   docker compose up -d
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$ROOT/.env"
if [ "${1:-}" = "--env-file" ]; then ENV_FILE=$(realpath -m "${2:?--env-file needs a path}"); shift 2; fi
TARGET=${1:?usage: restore.sh [--env-file FILE] <target-dir> [snapshot|latest]}
SNAP=${2:-latest}
[ -f "$ENV_FILE" ] || { echo "config file $ENV_FILE not found" >&2; exit 1; }
# shellcheck source=lib-env.sh
. "$ROOT/scripts/lib-env.sh"
load_env "$ENV_FILE" RESTIC_PASSWORD BACKUP_REPOSITORY BACKUP_SSH_KEY
REPO="${BACKUP_REPOSITORY:?set BACKUP_REPOSITORY in $ENV_FILE (e.g. sftp:user@host:backups/goods-shelf)}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD in $ENV_FILE}"
KEY="${BACKUP_SSH_KEY:-$HOME/.ssh/goods_backup_ed25519}"
KEY="${KEY/#\~/$HOME}"
REPO_OPTS=()   # same repository access as backup.sh
case "$REPO" in
  sftp:*)   REPO_OPTS=(-v "$KEY:/root/.ssh/id_ed25519:ro" -v "$HOME/.ssh/known_hosts:/root/.ssh/known_hosts:ro")
  [ -f "$KEY" ] || { echo "SSH key $KEY not found (BACKUP_SSH_KEY)" >&2; exit 1; }
  [ -f "$HOME/.ssh/known_hosts" ] || { echo "$HOME/.ssh/known_hosts not found — connect to the backup host once with ssh first" >&2; exit 1; } ;;
  local:/*) REPO_OPTS=(-v "${REPO#local:}:${REPO#local:}") ;;
  /*)       REPO_OPTS=(-v "$REPO:$REPO") ;;
esac
mkdir -p "$TARGET"
TARGET=$(cd "$TARGET" && pwd)
[ -z "$(ls -A "$TARGET")" ] || { echo "target $TARGET is not empty" >&2; exit 1; }

docker run --rm --network host \
  -e RESTIC_REPOSITORY="$REPO" -e RESTIC_PASSWORD \
  -v "$TARGET:/restore" "${REPO_OPTS[@]}" \
  restic/restic:0.19.1 -o sftp.args="-o BatchMode=yes -o IdentitiesOnly=yes" \
  restore "$SNAP" --tag goods-shelf --target /restore

# lay the result out like the data directory: goods.db + media/
mkdir -p "$TARGET/data"
mv "$TARGET/data/tmp/backup/goods.db" "$TARGET/data/goods.db" 2>/dev/null || true
rm -rf "$TARGET/data/tmp"
# restic runs as root in the container
docker run --rm -v "$TARGET:/t" alpine chown -R "$(id -u):$(id -g)" /t
echo "restored to $TARGET/data:"
docker run --rm -v "$TARGET/data:/d:ro" python:3.13-slim python -c "
import sqlite3; c = sqlite3.connect('file:/d/goods.db?immutable=1', uri=True)
print('integrity:', c.execute('pragma integrity_check').fetchone()[0], '| items:', c.execute('select count(*) from item').fetchone()[0])"
find "$TARGET/data/media" -type f | wc -l | xargs echo "media files:"
