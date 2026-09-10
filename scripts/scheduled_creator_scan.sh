#!/usr/bin/env bash
# scheduled_creator_scan.sh — ramped creator-scan cadence, per 2026-09-10 user direction:
# 6x/day (every 4h) for the first 4 days, then 1x/day at 09:00 Cairo time thereafter.
# Cron fires this every 4 hours; this script decides whether THIS invocation should actually run.
set -euo pipefail
cd "$(dirname "$0")/.."

MARKER="data/db/.scan_schedule_start"
LOG="data/db/scheduled_scan.log"
mkdir -p data/db

if [ ! -f "$MARKER" ]; then
  date -u +%Y-%m-%d > "$MARKER"
fi
START_DATE=$(cat "$MARKER")
DAYS_SINCE=$(( ($(date -u +%s) - $(date -u -d "$START_DATE" +%s)) / 86400 ))
HOUR_CAIRO=$(TZ=Africa/Cairo date +%H)

RUN=false
if [ "$DAYS_SINCE" -lt 4 ]; then
  RUN=true   # ramp period: every 4h slot runs (6x/day)
elif [ "$HOUR_CAIRO" = "09" ]; then
  RUN=true   # steady state: only the 09:00 Cairo slot runs (1x/day)
fi

if [ "$RUN" = "true" ]; then
  echo "[$(date -u -Iseconds)] running (day $DAYS_SINCE since $START_DATE)" >> "$LOG"
  pnpm creator-scan >> "$LOG" 2>&1
  pnpm registry-report >> "$LOG" 2>&1
else
  echo "[$(date -u -Iseconds)] skipped (day $DAYS_SINCE, steady-state, not the 09:00 CAI slot)" >> "$LOG"
fi
