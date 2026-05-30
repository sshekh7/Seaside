#!/bin/bash
# Load .env.local into environment
set -a
source "$(dirname "$0")/../.env.local"
set +a
exec npx tsx experiments/01-plan-day.ts "$@"
