#!/bin/bash
# =============================================================================
# Failure Test Suite Runner
# Distributed Code Execution Platform
# =============================================================================
# Runs all 5 failure tests sequentially and reports results.
#
# Prerequisites:
#   - API Gateway running:   npm run dev:gateway
#   - Execution Worker:      npm run dev:worker
#   - System Monitor:        npm run dev:monitor
#   - Infrastructure:        cd infra && docker compose up -d
#
# Usage:
#   chmod +x tests/failure/run-failure-tests.sh
#   ./tests/failure/run-failure-tests.sh
# =============================================================================

set -e

BASE_URL="${BASE_URL:-http://localhost:8000}"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
SKIP=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo "============================================================"
echo "  DISTRIBUTED CODE EXECUTION PLATFORM — FAILURE TEST SUITE"
echo "============================================================"
echo ""

# Check prerequisites
echo "Checking prerequisites..."
if ! curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
    echo -e "${RED}FATAL: API Gateway is not running at $BASE_URL${NC}"
    echo "Start it with: npm run dev:gateway"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} API Gateway is reachable"
echo ""

# ── Helper ────────────────────────────────────────────────────────────────────

run_test() {
    local test_num="$1"
    local test_name="$2"
    local test_file="$3"

    echo "------------------------------------------------------------"
    echo -e "${BLUE}Test $test_num: $test_name${NC}"
    echo "------------------------------------------------------------"

    if python3 "$test_file"; then
        echo -e "\n${GREEN}✓ Test $test_num PASSED${NC}"
        PASS=$((PASS + 1))
    else
        echo -e "\n${RED}✗ Test $test_num FAILED${NC}"
        FAIL=$((FAIL + 1))
    fi

    echo ""
    # Give the system time to stabilize between tests
    sleep 3
}

# ── Run Tests ─────────────────────────────────────────────────────────────────

run_test 1 "Infinite Loop (Timeout Kill)" "$TESTS_DIR/01-infinite-loop.py"
run_test 2 "Fork Bomb (PIDs-limit Kill)"  "$TESTS_DIR/02-fork-bomb.py"
run_test 3 "OOM Attack (Memory Kill)"     "$TESTS_DIR/03-oom-attack.py"
run_test 4 "Infinite Output (Streaming)"  "$TESTS_DIR/04-infinite-output.py"

# Test 5 (Worker Crash) requires interactive setup, so it's noted but not auto-run
echo "------------------------------------------------------------"
echo -e "${YELLOW}Test 5: Worker Crash Recovery (Manual)${NC}"
echo "------------------------------------------------------------"
echo "This test kills the execution-worker process mid-execution."
echo "It requires the System Monitor to be running."
echo ""
echo "Run manually with:"
echo "  python3 $TESTS_DIR/05-worker-crash.py"
echo ""
SKIP=$((SKIP + 1))

# ── Summary ───────────────────────────────────────────────────────────────────

echo "============================================================"
echo "  TEST RESULTS SUMMARY"
echo "============================================================"
echo -e "  ${GREEN}PASSED:${NC}  $PASS"
echo -e "  ${RED}FAILED:${NC}  $FAIL"
echo -e "  ${YELLOW}SKIPPED:${NC} $SKIP (manual tests)"
echo "============================================================"
echo ""

if [ $FAIL -gt 0 ]; then
    exit 1
fi

echo -e "${GREEN}All automated failure tests passed!${NC}"
echo ""
