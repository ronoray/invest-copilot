#!/bin/bash
set -e

# ============================================================================
# Investment Co-Pilot Deployment Script
# For docker-compose based deployment
# ============================================================================

# Configuration
APP_DIR="${APP_DIR:-/opt/invest-copilot}"
RELEASES="${APP_DIR}/releases"
BRANCH="${INVEST_BRANCH:-main}"
KEEP_STAGES="${KEEP_STAGES:-8}"
HEALTH_URL="${INVEST_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
HEALTH_TIMEOUT=120

# Deployment lock
LOCK_FILE="/tmp/invest-deploy.lock"

# Logging
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
error() { log "ERROR: $*" >&2; }
fatal() { error "$*"; cleanup; exit 1; }

# Cleanup function
cleanup() {
  rm -f "$LOCK_FILE"
}

# Trap errors and cleanup
trap cleanup EXIT INT TERM

# ============================================================================
# Check deployment lock
# ============================================================================
if [ -f "$LOCK_FILE" ]; then
  PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    fatal "Deployment already in progress (PID: $PID)"
  else
    log "Removing stale lock file"
    rm -f "$LOCK_FILE"
  fi
fi

echo $$ > "$LOCK_FILE"

# ============================================================================
# Start deployment
# ============================================================================
log "========================================="
log "START Investment Co-Pilot Deployment"
log "========================================="
log "APP_DIR=$APP_DIR"
log "BRANCH=$BRANCH"

cd "$APP_DIR" || fatal "Cannot cd to $APP_DIR"

# Verify tools
command -v git >/dev/null 2>&1 || fatal "git not found"
command -v docker >/dev/null 2>&1 || fatal "docker not found"

# ============================================================================
# Git sync
# ============================================================================
log "Fetching origin/$BRANCH"
git fetch origin "$BRANCH" 2>&1 || fatal "git fetch failed"

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse "origin/$BRANCH")

log "Local HEAD:  $LOCAL_SHA"
log "Remote HEAD: $REMOTE_SHA"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  log "Already at latest commit, nothing to deploy"
  exit 0
fi

log "Pulling latest changes"
git reset --hard "origin/$BRANCH" || fatal "git reset failed"
git clean -fd

TARGET_SHA=$(git rev-parse HEAD)
log "✅ Updated to SHA: $TARGET_SHA"

# ============================================================================
# Build and deploy with docker-compose
# ============================================================================
log "Building containers with docker-compose"
docker compose build --no-cache invest-api invest-web 2>&1 || fatal "Docker build failed"

log "Stopping containers"
docker compose down

log "Starting containers"
docker compose up -d 2>&1 || fatal "Docker compose up failed"

# ============================================================================
# Health check
# ============================================================================
# Health check
log "Waiting for services to be healthy..."
ELAPSED=0
while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
  # Check if container is running and API started
  if docker exec invest-api node -e "const http=require('http');http.get('http://localhost:3100/api/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))" 2>/dev/null; then
    log "✅ Health check passed"
    break
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  log "Waiting... ($ELAPSED/$HEALTH_TIMEOUT seconds)"
done

if [ $ELAPSED -ge $HEALTH_TIMEOUT ]; then
  error "Health check timeout after $HEALTH_TIMEOUT seconds"
  log "Last 50 lines of invest-api logs:"
  docker logs invest-api --tail 50
  fatal "Deployment failed - health check timeout"
fi

# ============================================================================
# Save deployed SHA
# ============================================================================
echo "$TARGET_SHA" > "$APP_DIR/DEPLOYED_SHA"
log "✅ Wrote DEPLOYED_SHA: $TARGET_SHA"

# ============================================================================
# Success
# ============================================================================
log "========================================="
log "✅ DEPLOYMENT SUCCESSFUL"
log "========================================="
log "Commit: ${TARGET_SHA:0:7}"
log "Branch: $BRANCH"
log "Time: $(date)"

exit 0