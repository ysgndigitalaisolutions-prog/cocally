#!/usr/bin/env bash
# Nightly Mongo dump from the compose stack, kept 14 days locally. Optionally
# copies to an S3-compatible bucket when BACKUP_BUCKET and rclone are configured.
# Cron on the VM:  15 16 * * * /opt/cocally/backup-mongo.sh >> /opt/cocally/backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
sudo docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T mongo \
  mongodump --archive --gzip --db cocally > "backups/cocally-${stamp}.archive.gz"
find backups -name 'cocally-*.archive.gz' -mtime +14 -delete
if [ -n "${BACKUP_BUCKET:-}" ] && command -v rclone >/dev/null; then
  rclone copy "backups/cocally-${stamp}.archive.gz" "${BACKUP_BUCKET}/mongo/"
fi
echo "backup ok ${stamp}"
