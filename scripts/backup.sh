#!/usr/bin/env bash
# Nightly backup of goods-shelf (DB + media) with restic (SFTP or a local directory; see README).
#   scripts/backup.sh [--env-file FILE] [--check]
#     --env-file  instance config to use (default: .env next to docker-compose.yml)
#     --check     also verify a 5% sample of the stored data (done automatically on Sundays)
# Cron: 30 3 * * *  /path/to/goods-shelf/scripts/backup.sh >> /path/to/goods-shelf/logs/backup.log 2>&1
# Host needs: bash, coreutils, flock (util-linux), docker; curl only for BACKUP_PUSH_URL.
# The app container must be running (the DB snapshot is taken inside it).
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$ROOT/.env"; CHECK=
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE=$(realpath -m "${2:?--env-file needs a path}"); shift ;;
    --check) CHECK=1 ;;
    *) echo "usage: backup.sh [--env-file FILE] [--check]" >&2; exit 2 ;;
  esac
  shift
done
[ -f "$ENV_FILE" ] || { echo "config file $ENV_FILE not found" >&2; exit 1; }
cd "$ROOT"
# shellcheck source=lib-env.sh
. "$ROOT/scripts/lib-env.sh"
load_env "$ENV_FILE" RESTIC_PASSWORD BACKUP_PUSH_URL BACKUP_REPOSITORY BACKUP_SSH_KEY GS_NAME GS_DATA

REPO="${BACKUP_REPOSITORY:?set BACKUP_REPOSITORY in $ENV_FILE (e.g. sftp:user@host:backups/goods-shelf)}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD in $ENV_FILE}"
KEY="${BACKUP_SSH_KEY:-$HOME/.ssh/goods_backup_ed25519}"
KEY="${KEY/#\~/$HOME}"
IMAGE="restic/restic:0.19.1"
DATA="$(cd "$ROOT" && realpath -m "${GS_DATA:-./data}")"
APP="${GS_NAME:-goods-shelf}"
KEEP=(--keep-daily 14 --keep-weekly 8 --keep-monthly 12)
# How the restic container reaches the repository: sftp:… uses the SSH key + known_hosts;
# a local directory (/mnt/usb/goods-shelf or local:/…) is mounted into the container at the same path.
REPO_OPTS=()
case "$REPO" in
  sftp:*)   REPO_OPTS=(-v "$KEY:/root/.ssh/id_ed25519:ro" -v "$HOME/.ssh/known_hosts:/root/.ssh/known_hosts:ro")
  [ -f "$KEY" ] || { echo "SSH key $KEY not found (BACKUP_SSH_KEY)" >&2; exit 1; }
  [ -f "$HOME/.ssh/known_hosts" ] || { echo "$HOME/.ssh/known_hosts not found — connect to the backup host once with ssh first" >&2; exit 1; } ;;
  local:/*) mkdir -p "${REPO#local:}"; REPO_OPTS=(-v "${REPO#local:}:${REPO#local:}") ;;
  /*)       mkdir -p "$REPO"; REPO_OPTS=(-v "$REPO:$REPO") ;;
esac

log()  { echo "$(date '+%F %T') $*"; }
push() {  # Uptime Kuma push monitor (optional)
  [ -n "${BACKUP_PUSH_URL:-}" ] || return 0
  curl -fsS -m 15 -G "${BACKUP_PUSH_URL%%\?*}" --data-urlencode "status=$1" --data-urlencode "msg=$2" >/dev/null \
    || log "WARNING: Uptime Kuma push failed (backup itself is unaffected)"
}
restic() {
  docker run --rm --network host --hostname "$(hostname)" \
    -e RESTIC_REPOSITORY="$REPO" -e RESTIC_PASSWORD \
    -v "$DATA:/data:ro" "${REPO_OPTS[@]}" \
    -v goods-shelf-restic-cache:/root/.cache/restic \
    "$IMAGE" -o sftp.args="-o BatchMode=yes -o IdentitiesOnly=yes" "$@"
}

mkdir -p "$ROOT/logs"
exec 9>"$ROOT/logs/backup-$APP.lock"   # one lock per instance
flock -n 9 || { log "another backup is running — skip"; exit 0; }

fail() { log "FAILED: $1"; push down "backup failed: $1"; exit 1; }
trap 'fail "line $LINENO"' ERR

log "start"
# 1. consistent SQLite snapshot while the app keeps running (WAL-safe online backup)
ITEMS=$(docker exec "$APP" python -c "
import sqlite3, pathlib
pathlib.Path('/data/tmp/backup').mkdir(parents=True, exist_ok=True)   # the app empties /data/tmp on start
src = sqlite3.connect('/data/goods.db'); dst = sqlite3.connect('/data/tmp/backup/goods.db')
src.backup(dst); dst.close()
snap = sqlite3.connect('/data/tmp/backup/goods.db')
assert snap.execute('pragma integrity_check').fetchone()[0] == 'ok'
print(snap.execute('select count(*) from item').fetchone()[0])
")

# 2. init the repository on first run
restic cat config >/dev/null 2>&1 || { log "initialising repository $REPO"; restic init; }

# 3. back up DB snapshot + all media (content-addressed → only new files are uploaded)
restic backup --tag goods-shelf --host "$(hostname)" \
  /data/tmp/backup/goods.db /data/media
# 4. retention
restic forget --tag goods-shelf --host "$(hostname)" "${KEEP[@]}" --prune
# 5. weekly (Sunday) or on request: verify structure + a 5% sample of the data
if [ -n "$CHECK" ] || [ "$(date +%u)" = 7 ]; then
  restic check --read-data-subset=5%
fi

docker exec "$APP" rm -f /data/tmp/backup/goods.db
LATEST=$(restic snapshots --tag goods-shelf --latest 1 --json | grep -o '"short_id":"[^"]*"' | tail -1 | cut -d'"' -f4)
log "ok — snapshot $LATEST, $ITEMS items"
push up "ok ${LATEST} ${ITEMS} items"
