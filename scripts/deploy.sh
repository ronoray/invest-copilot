#!/bin/bash

# Investment Co-Pilot Deployment Script
# Follows Hungry Times deployment pattern
# Usage: sudo ./deploy.sh

set -e

echo "======================================"
echo "Investment Co-Pilot - Deployment"
echo "======================================"

# Configuration
DEPLOY_DIR="/opt/invest-copilot"
GIT_REPO="https://github.com/yourusername/invest-copilot.git"  # Update this
BRANCH="main"
LOG_FILE="/var/log/invest-deploy.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

log "====== Deployment started ======"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}ERROR: Please run as root (sudo ./deploy.sh)${NC}"
    exit 1
fi

# First time setup
if [ ! -d "$DEPLOY_DIR" ]; then
    log "First time setup detected"
    mkdir -p $DEPLOY_DIR
    cd $DEPLOY_DIR
    git clone $GIT_REPO .
    
    # Create .env if doesn't exist
    if [ ! -f .env ]; then
        log "Creating .env file from template"
        cp .env.example .env
        echo -e "${RED}IMPORTANT: Edit .env file with your credentials!${NC}"
        echo "Run: nano $DEPLOY_DIR/.env"
        exit 1
    fi
else
    cd $DEPLOY_DIR
fi

# Check .env exists
if [ ! -f .env ]; then
    echo -e "${RED}ERROR: .env file not found!${NC}"
    echo "Copy .env.example to .env and fill in your credentials"
    exit 1
fi

# Git sync check
log "Checking Git status..."
git fetch origin

LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u})

if [ $LOCAL != $REMOTE ]; then
    if git merge-base --is-ancestor $REMOTE $LOCAL; then
        echo -e "${RED}ERROR: Local is ahead of remote!${NC}"
        log "ERROR: Cannot deploy - local ahead of origin"
        exit 1
    fi
fi

# Pull latest
log "Pulling latest code from GitHub..."
git reset --hard origin/$BRANCH

# Load environment
source .env

# Stop containers
log "Stopping containers..."
docker-compose down

# Build new images
log "Building Docker images..."
docker-compose build

# Database migration
log "Running database migrations..."
docker-compose run --rm invest-api npx prisma migrate deploy

# Start services
log "Starting services..."
docker-compose up -d

# Wait for health check
log "Waiting for services to start..."
ATTEMPTS=0
MAX_ATTEMPTS=60

while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
    if curl -f http://localhost:3100/api/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ API is healthy${NC}"
        log "API health check passed"
        break
    fi
    ATTEMPTS=$((ATTEMPTS+1))
    sleep 1
done

if [ $ATTEMPTS -eq $MAX_ATTEMPTS ]; then
    echo -e "${RED}✗ API health check failed${NC}"
    log "ERROR: API health check failed after ${MAX_ATTEMPTS}s"
    docker-compose logs invest-api | tail -50
    exit 1
fi

# Create deployment marker
DEPLOYED_SHA=$(git rev-parse --short HEAD)
echo "INVEST_${DEPLOYED_SHA}" > $DEPLOY_DIR/DEPLOYED_SHA
log "Deployment marker: INVEST_${DEPLOYED_SHA}"

# Success
log "====== Deployment completed successfully ======"
echo ""
echo -e "${GREEN}Deployment complete!${NC}"
echo "======================================"
echo "Services:"
echo "  - Frontend: https://invest.hungrytimes.in"
echo "  - API: https://invest.hungrytimes.in/api"
echo "  - Deployed SHA: ${DEPLOYED_SHA}"
echo ""
echo "Useful commands:"
echo "  - View logs: docker-compose logs -f"
echo "  - Restart API: docker-compose restart invest-api"
echo "  - Database shell: docker-compose exec invest-postgres psql -U investuser investcopilot"
echo "======================================"
