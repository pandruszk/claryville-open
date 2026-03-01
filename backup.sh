#!/bin/bash
# Backup SQLite database
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./data/backups"
mkdir -p "$BACKUP_DIR"
cp ./data/claryville.db "$BACKUP_DIR/claryville_$DATE.db"
echo "Backed up to $BACKUP_DIR/claryville_$DATE.db"

# Keep only last 10 backups
ls -t "$BACKUP_DIR"/claryville_*.db | tail -n +11 | xargs -r rm
