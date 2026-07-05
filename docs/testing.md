# Testing

## Type Check

```bash
npm run typecheck
```

## Failure And Regression Suite

```bash
npm run test:failure
```

The suite validates:

1. infinite loop timeout,
2. fork bomb containment,
3. memory exhaustion containment,
4. infinite output stream cap,
5. worker crash recovery,
6. API/WebSocket regressions.

Expected summary:

```text
PASSED: 6
FAILED: 0
```

## What The Tests Prove

| Test | What It Proves |
|---|---|
| Infinite loop | Worker timeout kills runaway CPU loops |
| Fork bomb | Docker PID limit prevents process exhaustion |
| OOM attack | Docker memory limit kills memory abuse |
| Infinite output | Output cap prevents stream/memory blowup |
| Worker crash | Heartbeat monitor recovers orphaned jobs |
| API/WebSocket regression | Auth, replay, validation, output flags work |

## Benchmarks

Throughput, latency, Docker spawn profiling, and crash-recovery numbers are a separate concern from correctness testing above — see [BENCHMARK_RESULTS.md](../BENCHMARK_RESULTS.md).
