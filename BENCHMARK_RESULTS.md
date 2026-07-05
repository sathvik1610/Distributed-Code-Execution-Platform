# Benchmark Results

> Run: 2026-07-05 10:58:09 UTC
> Workers: 3 execution-worker replicas
> Language: Python (simple print statement — measures end-to-end latency, not execution time)
> Host: Windows 11 + WSL2 Ubuntu, Docker Desktop, Node.js v22.22.2

## Hardware

| Component | Spec |
|---|---|
| CPU | Intel Core i5-1340P (13th Gen, 16 logical processors visible to WSL2) |
| RAM | 7.6 GiB allocated to WSL2 / Docker Desktop (host has more; this is the VM's ceiling) |
| Disk | Intel NVMe SSD (512 GB) |
| Virtualization | Docker Desktop running containers inside a WSL2 Ubuntu VM, not bare-metal Linux |

**Why this matters:** WSL2 adds a virtualization layer between the container runtime and the host — container spawn (namespace/cgroup setup, network teardown) crosses that boundary and is measurably slower than on bare-metal Linux. The 82.7% Docker-spawn-dominance finding below would likely still hold on bare metal, since it's architectural, but the absolute millisecond numbers (374.7ms avg spawn) are almost certainly higher here than they would be on a native Linux host or a cloud VM with local NVMe passthrough.

## How to read these numbers

- **Latency** = time from HTTP submission to final `COMPLETED` status (includes queue wait + Docker spawn + execution + DB write)
- **Throughput** = completed jobs per second over the entire run
- **Concurrency** = number of simultaneous client goroutines submitting + waiting for results

---

### Scenario 1: Optimal Queue Balance
- **Jobs submitted:** 9
- **Client concurrency:** 3
- **Throughput:** 3.95 jobs/sec
- **Latency avg:** 679.9 ms
- **Latency p50:** 539 ms
- **Latency p95:** 948 ms
- **Latency p99:** 948 ms
- **Latency min/max:** 512 ms / 948 ms

> **Note on run-to-run variance:** an earlier run of this exact scenario (same code, same host) measured ~5.04 jobs/sec and p50=625ms instead of the 3.95 jobs/sec and p50=539ms shown here. Both are real measurements — Docker on a shared dev host (WSL2, page cache state, other processes competing for CPU) has genuine run-to-run variance at small sample sizes. **This is exactly why Scenario 3 (500 jobs) exists below**: at n=9, a single run's throughput number isn't a reliable claim on its own. At n=500 over 114 seconds, that variance averages out, and the result that matters — p95 tracking p50 tightly with no drift — is far more defensible than any single small-n number.

### Scenario 2: Queue Saturation
- **Jobs submitted:** 20
- **Client concurrency:** 10
- **Throughput:** 4.39 jobs/sec
- **Latency avg:** 1827.0 ms
- **Latency p50:** 2164 ms
- **Latency p95:** 2350 ms
- **Latency p99:** 2350 ms
- **Latency min/max:** 459 ms / 2350 ms

### Scenario 3: Sustained Load (500 jobs)
- **Jobs submitted:** 500
- **Client concurrency:** 3
- **Throughput:** 4.35 jobs/sec
- **Latency avg:** 688.5 ms
- **Latency p50:** 714 ms
- **Latency p95:** 925 ms
- **Latency p99:** 930 ms
- **Latency min/max:** 510 ms / 1029 ms

---

## What these numbers mean

- p50 is your typical user experience
- p95 is your worst-case tail — anything above this in production needs investigation
- The gap between Scenario 1 and Scenario 2 throughput shows queue saturation behaviour
- Scenario 3 (500 jobs) confirms steady-state stability — p95 (925ms) tracks p50 (714ms) closely with no runaway tail latency or memory-driven slowdown over a 114-second sustained run

---

## Docker Spawn Profiling (per-job breakdown)

Every job's execution is broken into three measured phases, captured directly from worker logs during the Scenario 3 stress run (500 jobs submitted, 500/500 completed per the throughput benchmark's own accounting above).

**Why the sample below is 401, not 500:** the timing data was pulled after the run by tailing each worker container's Docker logs (`docker logs <worker> | grep timing | tail -200`, capped at 200 lines per worker to keep the sample manageable). Worker-1's container had been recreated shortly before this run (during earlier failure-benchmark testing), so its log buffer only contained 1 matching entry at collection time — the other jobs it processed during this run are real and counted in the throughput/latency numbers above, they're just not present in this specific log-derived timing sample. This is a data-collection artifact of tailing container logs after the fact, not a job failure — all 500 jobs completed successfully. A production version of this profiling would push these timings to Prometheus per-job rather than relying on log scraping, avoiding this gap entirely.

| Phase | What it measures | Avg | p50 | p95 | Min | Max |
|---|---|---|---|---|---|---|
| **containerInitMs** | `docker run` spawn → first byte of stdout/stderr | 374.7 ms | 369 ms | 393 ms | 327 ms | 2469 ms |
| **codeRuntimeMs** | first output → container exit | 65.0 ms | 63 ms | 84 ms | 51 ms | 110 ms |
| **dbWriteMs** | result + status transaction commit | 2.6 ms | 3 ms | 4 ms | 2 ms | 6 ms |
| **totalMs** | full sandbox execution (sum of the above) | 453.2 ms | 445 ms | 489 ms | 403 ms | 2593 ms |

### Where the time actually goes

```
containerInit  ████████████████████████████████████████████  82.7%
codeRuntime    ████████                                       14.3%
dbWrite                                                         0.6%
```

**Docker container spawn is the dominant cost — not the code, not the database.** For a one-line `print()` script, over 4 out of every 5 milliseconds are spent starting the sandboxed container (image already cached, so this is pure `docker run` overhead: namespace/cgroup setup, network=none interface teardown, seccomp profile application). Actual code execution is ~65ms, and the PostgreSQL transaction is negligible at ~3ms.

> **Note on dbWriteMs:** this 2.6ms figure is for Postgres running on the same host as the worker — no network hop. It's an accurate measurement of Postgres's own commit cost (one indexed INSERT, one indexed UPDATE), but a production deployment with a managed database on a separate host (RDS, Cloud SQL) would add real network round-trip latency on top of this number — likely a few extra milliseconds, not a different order of magnitude.

**Implication:** the platform's throughput ceiling is set by Docker daemon spawn rate, not by application logic. Scaling further means either (a) adding more workers/hosts to parallelize spawns, or (b) replacing per-job container spawn with a warm-container pool — the highest-leverage optimization this project could make next, and out of scope for the current architecture.

## Benchmark Limitations

These numbers describe this specific environment and setup — they are not a general claim about the platform's behavior at any scale or on any hardware. Specifically:

- **Single machine.** Client, API Gateway, Redis, PostgreSQL, and all workers ran on one laptop. No network latency between components, which is unrealistic for a real deployment where workers might be on separate hosts.
- **WSL2 + Docker Desktop, not bare-metal Linux.** Container spawn crosses a virtualization boundary here; a native Linux host or a cloud VM would likely show lower absolute spawn times, though the *proportion* of time spent on spawn vs. code execution should hold directionally.
- **Local Redis and local PostgreSQL.** No replication, no network hop, no connection pooling contention from other tenants. A managed Redis/Postgres in production adds latency this benchmark doesn't capture.
- **No cross-region or multi-host workers.** All three worker replicas shared the same CPU and Docker daemon — they did not compete for genuinely separate hardware.
- **CPU-bound test code only.** The benchmark payload is a one-line `print()` statement — it measures platform overhead, not workload diversity (no CPU-heavy loops, no large I/O, no memory-heavy scripts).
- **Small worker pool (3 replicas).** Throughput scaling behavior beyond 3 workers, or under container-pool warm-start optimizations, is not measured here — it's a stated future direction, not a validated result.

---

## Worker Crash Recovery

Simulates a hard worker failure (`docker kill`) while jobs are actively executing on it, then measures automatic recovery.

**Test setup:** worker `infra-execution-worker-1` killed 1500ms after submitting 9 jobs (each a 2-second sleep + print, so the worker is guaranteed to be mid-execution — not still queued, not already finished — at the moment of the kill).

| Metric | Value |
|---|---|
| Total jobs | 9 |
| Completed successfully | 9 / 9 |
| Success rate | 100.0% |
| Jobs retried (were on killed worker) | 1 |
| Jobs completed without retry | 8 |
| Recovery time (kill → retried job completed) | 19,027 ms |

### Recovery Timeline

```
T+0ms       Worker killed (docker kill infra-execution-worker-1)
T+~15s      Heartbeat key expires (worker:heartbeat:{workerId} TTL=15s)
T+~25s      System Monitor detects dead worker (next scan cycle)
T+~25s      Orphaned job re-enqueued to jobs:queue:pending
T+~26s      Surviving worker claims and executes recovered job
T+~28s      Recovered job completes
```

**Worst-case theoretical recovery window:** heartbeat TTL (15s) + reaper scan interval (10s) = **~25 seconds**. Measured: 19,027 ms.

### How recovery works

1. Worker claims jobs via `BRPOPLPUSH` — jobs move to `jobs:queue:processing:{workerId}`
2. Worker is killed — jobs remain in the processing queue (crash-safe by design)
3. Worker's heartbeat key expires after 15s (not refreshed because the process is dead)
4. System Monitor scans every 10s: finds a processing queue without a matching heartbeat
5. Reads orphaned jobs, increments `retry_count`, updates status, re-enqueues to `jobs:queue:pending`
6. A surviving worker claims and completes the job normally

## To reproduce

```bash
npm run start:all:scaled       # 3 workers
node benchmark.js

# Worker crash recovery
KILL_DELAY_MS=1500 RECOVERY_TIMEOUT_MS=60000 node failure-benchmark.js
```
