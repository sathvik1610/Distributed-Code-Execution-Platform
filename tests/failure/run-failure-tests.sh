#!/bin/bash
# =============================================================================
# Failure Test Suite Runner
# Distributed Code Execution Platform
# =============================================================================
# Runs containment, recovery, and streaming regression tests against a live stack.
#
# Prerequisites:
#   - Full stack running: npm run start:all:scaled
#   - Runner images built: npm run docker:build:runners
#   - API_KEY exported if different from test-api-key
# =============================================================================

set -e

BASE_URL="${BASE_URL:-http://localhost:8000}"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo "============================================================"
echo "  DISTRIBUTED CODE EXECUTION PLATFORM — FAILURE TEST SUITE"
echo "============================================================"
echo ""

echo "Checking prerequisites..."
if ! curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
    echo -e "${RED}FATAL: API Gateway is not running at $BASE_URL${NC}"
    echo "Start it with: npm run start:all:scaled"
    exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q '^execution_redis$'; then
    echo -e "${RED}FATAL: Docker Compose stack is not visible or execution_redis is missing${NC}"
    echo "Start it with: npm run start:all:scaled"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} API Gateway and Docker stack are reachable"
echo ""

run_python_test() {
    local test_num="$1"
    local test_name="$2"
    local test_file="$3"

    echo "------------------------------------------------------------"
    echo -e "${BLUE}Test $test_num: $test_name${NC}"
    echo "------------------------------------------------------------"

    if BASE_URL="$BASE_URL" python3 "$test_file"; then
        echo -e "\n${GREEN}✓ Test $test_num PASSED${NC}"
        PASS=$((PASS + 1))
    else
        echo -e "\n${RED}✗ Test $test_num FAILED${NC}"
        FAIL=$((FAIL + 1))
    fi

    echo ""
    sleep 3
}

run_node_test() {
    local test_num="$1"
    local test_name="$2"
    local test_file="$3"

    echo "------------------------------------------------------------"
    echo -e "${BLUE}Test $test_num: $test_name${NC}"
    echo "------------------------------------------------------------"

    if BASE_URL="$BASE_URL" node "$test_file"; then
        echo -e "\n${GREEN}✓ Test $test_num PASSED${NC}"
        PASS=$((PASS + 1))
    else
        echo -e "\n${RED}✗ Test $test_num FAILED${NC}"
        FAIL=$((FAIL + 1))
    fi

    echo ""
    sleep 3
}

run_python_test 1 "Infinite Loop (Timeout Kill)" "$TESTS_DIR/01-infinite-loop.py"
run_python_test 2 "Fork Bomb (PIDs-limit Kill)"  "$TESTS_DIR/02-fork-bomb.py"
run_python_test 3 "OOM Attack (Memory Kill)"     "$TESTS_DIR/03-oom-attack.py"
run_python_test 4 "Infinite Output (Streaming Cap)"  "$TESTS_DIR/04-infinite-output.py"
run_python_test 5 "Worker Crash Recovery" "$TESTS_DIR/05-worker-crash.py"
run_node_test 6 "API + WebSocket Regression" "$TESTS_DIR/06-api-stream-regression.js"

echo "============================================================"
echo "  TEST RESULTS SUMMARY"
echo "============================================================"
echo -e "  ${GREEN}PASSED:${NC}  $PASS"
echo -e "  ${RED}FAILED:${NC}  $FAIL"
echo "============================================================"
echo ""

if [ $FAIL -gt 0 ]; then
    exit 1
fi

echo -e "${GREEN}All failure and regression tests passed!${NC}"
echo ""