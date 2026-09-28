#!/usr/bin/env bash
# Nightly logical backup of the production database (MongoDB Atlas).
# Atlas keeps its own backups; this is a second, independent copy on the VM
# disk (and in BACKUP_BUCKET when rclone is configured) so a bad migration or
# an Atlas account problem is still recoverable. Installed by setup.sh as a
# root cron job at 16:15 UTC; keeps 14 days.
set -euo pipefail
cd "$(dirname "$0")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
uri="$(grep '^MONGODB_URI=' .env.prod | cut -d= -f2-)"
[ -n "$uri" ] || { echo "MONGODB_URI missing from .env.prod" >&2; exit 1; }
# The database tools run in a throwaway container: nothing stays resident.
sudo docker run --rm -e MONGODB_URI="$uri" mongo:7 \
  sh -c 'mongodump --uri "$MONGODB_URI" --archive --gzip' > "backups/cocally-${stamp}.archive.gz"
find backups -name 'cocally-*.archive.gz' -mtime +14 -delete
if [ -n "${BACKUP_BUCKET:-}" ] && command -v rclone >/dev/null; then
  rclone copy "backups/cocally-${stamp}.archive.gz" "${BACKUP_BUCKET}/mongo/"
fi
echo "backup ok ${stamp}"
