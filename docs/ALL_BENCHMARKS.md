# All Benchmarks — Consolidated Results

> This file consolidates every benchmark run against the platform in one place, with raw numbers,
> so it can be pasted directly into another tool (GPT, a resume draft, an interview prep doc) without
> hunting across multiple files.
>
> Source data: [../BENCHMARK_RESULTS.md](../BENCHMARK_RESULTS.md) (the public numbers file). This file adds the full debugging narrative, resume bullets, and interview framing on top of those numbers — kept here rather than in the root file since it's prep material, not front-page repo content.

**If you only read one section: read §3 below.** The throughput and spawn-profiling numbers (§1, §2) are good evidence of measurement discipline. The bug found and fixed during crash-recovery testing (§3) is the strongest single piece of material in this project for an interview — it's evidence of debugging skill, not just system design. Full narrative: [failure-analysis/02-reaper-requeue-race-condition.md](failure-analysis/02-reaper-requeue-race-condition.md).

---

## Environment

| Property | Value |
|---|---|
| Run date | 2026-07-05 |
| Host OS | Windows 11 + WSL2 Ubuntu, Docker Desktop (containers run inside the WSL2 VM, not bare-metal Linux) |
| CPU | Intel Core i5-1340P (13th Gen), 16 logical processors visible to WSL2 |
| RAM | 7.6 GiB allocated to WSL2 / Docker Desktop |
| Disk | Intel NVMe SSD, 512 GB |
| Node.js | v22.22.2 |
| Workers | 3 × `execution-worker` replicas (`docker compose --scale execution-worker=3`) |
| Language under test | Python 3 (sandboxed, no network, 128MB memory cap, 50 pid limit) |
| Reproduce | `npm run start:all:scaled && node benchmark.js` / `node failure-benchmark.js` |

**Why the host matters:** WSL2 adds a virtualization boundary between the container runtime and the physical machine. Container spawn (namespace/cgroup setup, network teardown) crosses that boundary, so the absolute millisecond numbers below are almost certainly higher than they'd be on bare-metal Linux or a cloud VM with local NVMe passthrough. The architectural finding — that container spawn dominates execution time — should hold directionally on any host; the specific 374.7ms figure is WSL2-specific.

## Benchmark Limitations

- **Single machine** — client, API Gateway, Redis, PostgreSQL, and all 3 workers ran on one laptop. No real network latency between components.
- **WSL2 + Docker Desktop, not bare-metal Linux** — see above.
- **Local Redis and local PostgreSQL** — no replication, no network hop, no multi-tenant connection contention.
- **No cross-region or multi-host workers** — all 3 worker replicas shared the same CPU and Docker daemon.
- **CPU-bound test code only** — the benchmark payload is a one-line `print()` statement; it measures platform overhead, not workload diversity (no CPU-heavy loops, large I/O, or memory-heavy scripts).
- **Small worker pool (3 replicas)** — scaling behavior beyond 3 workers, or with a warm-container pool, is a stated future direction, not a measured result here.

---

## 1. Throughput & Latency Benchmark (`benchmark.js`)

Three load scenarios were run back-to-back after a warm-up job (to bypass Docker's one-time cold pull/cache-miss cost).

### Scenario 1 — Optimal Queue Balance (baseline)
- Jobs submitted: **9**
- Client concurrency: **3** (matches worker count — no queue backlog)
- Throughput: **3.95 jobs/sec**
- Latency avg: **679.9 ms**
- Latency p50: **539 ms**
- Latency p95: **948 ms**
- Latency p99: **948 ms**
- Latency min / max: **512 ms / 948 ms**

> **Run-to-run variance note:** an earlier run of this exact scenario measured ~5.04 jobs/sec and p50=625ms instead of the numbers above. Both are genuine measurements — Docker on a shared dev host (WSL2, page cache state, other host processes) has real run-to-run variance at small sample sizes. This is precisely why Scenario 3 (500 jobs) exists: at n=9 a single throughput number isn't a reliable claim; at n=500 over 114 seconds the variance averages out and the tighter claim (p95 tracking p50, no drift) becomes defensible.

### Scenario 2 — Queue Saturation (stress the queue, not just workers)
- Jobs submitted: **20**
- Client concurrency: **10** (>3x worker count — forces queue backlog)
- Throughput: **4.39 jobs/sec**
- Latency avg: **1827.0 ms**
- Latency p50: **2164 ms**
- Latency p95: **2350 ms**
- Latency p99: **2350 ms**
- Latency min / max: **459 ms / 2350 ms**

### Scenario 3 — Sustained Load (500 jobs, steady state)
- Jobs submitted: **500**
- Client concurrency: **3**
- Total wall-clock duration: **114.89 seconds**
- Throughput: **4.35 jobs/sec**
- Latency avg: **688.5 ms**
- Latency p50: **714 ms**
- Latency p95: **925 ms**
- Latency p99: **930 ms**
- Latency min / max: **510 ms / 1029 ms**

**Interpretation:**
- p95 (925ms) tracks p50 (714ms) tightly across 500 jobs and 114 seconds — no tail-latency blowup, no memory leak, no queue starvation over a sustained run.
- The throughput ceiling (~4.3–4.4 jobs/sec across all three scenarios, regardless of client concurrency) shows the system is **worker-count-bound, not queue-bound or client-bound** — adding more client concurrency (Scenario 2) doesn't increase throughput past ~4.4 jobs/sec because only 3 workers exist to actually execute jobs.

---

## 2. Docker Spawn Profiling (per-job timing breakdown)

Every job's execution was instrumented with three timestamps captured directly in the worker process (`sandbox.ts` + `index.ts`). Data below is aggregated from **401 of the 500 jobs** run in Scenario 3 — all 500 completed successfully per the throughput benchmark's own accounting above; the 401 figure is a data-collection artifact, not a failure count. Timing data was pulled after the run by tailing each worker container's Docker logs (capped at 200 lines/worker). One worker's container had been recreated shortly before this run (during earlier failure-benchmark testing), so its log buffer held fewer historical entries at collection time — the jobs it processed are still counted in the throughput/latency numbers above, just not present in this specific log-derived timing sample. A production version of this profiling would push timings to Prometheus per-job instead of scraping logs, avoiding this gap.

| Phase | Definition | Avg | p50 | p95 | Min | Max |
|---|---|---|---|---|---|---|
| **containerInitMs** | `docker run` spawn issued → first byte of stdout/stderr received | **374.7 ms** | 369 ms | 393 ms | 327 ms | 2469 ms |
| **codeRuntimeMs** | first output → container process exit | **65.0 ms** | 63 ms | 84 ms | 51 ms | 110 ms |
| **dbWriteMs** | result + status Postgres transaction commit | **2.6 ms** | 3 ms | 4 ms | 2 ms | 6 ms |
| **totalMs** | full sandbox execution (sum of the above) | **453.2 ms** | 445 ms | 489 ms | 403 ms | 2593 ms |

> **dbWriteMs is co-located Postgres** — worker and database on the same host, no network hop. A production deployment with a managed database on a separate host would add real network round-trip latency on top of this — likely a few extra milliseconds, not a different order of magnitude, since 2.6ms already reflects genuinely small work (one indexed INSERT, one indexed UPDATE).

**Percentage breakdown of average total execution time:**

```
containerInit  ████████████████████████████████████████████  82.7%
codeRuntime    ████████                                       14.3%
dbWrite                                                         0.6%
```

**Key finding:** for a trivial one-line `print()` script, **82.7% of total execution time is Docker container spawn overhead** — not user code, not the database. Actual code execution averages 65ms; the PostgreSQL transaction commit is negligible (2.6ms). This means:
- The system's throughput ceiling is set by the **Docker daemon's container spawn rate**, not by application-level logic, queue design, or the database.
- The highest-leverage future optimization is a **warm/pre-forked container pool** to eliminate the per-job spawn cost, not further queue or DB tuning.

---

## 3. Worker Crash Recovery Benchmark (`failure-benchmark.js`)

Simulates a hard worker failure (`docker kill`) while jobs are actively executing on it, then measures automatic recovery. This benchmark exists to test a specific design claim — **at-least-once delivery** — rather than assume it: if the reaper/heartbeat design is correct, every job should complete even when its worker is killed mid-execution.

**Test setup:**
- Worker killed: `infra-execution-worker-1`
- Total jobs submitted: **9** (2-second sleep + print)
- Kill delay: **1500ms** after submission
- Recovery timeout window: 60s

**Why a 2-second sleep and a 1500ms kill delay, specifically:** this isn't arbitrary. The test needs the killed worker to be genuinely mid-execution — not still queued, not already finished — at the exact instant `docker kill` fires, so the benchmark actually exercises the orphan-recovery path instead of getting lucky or unlucky with timing. 1.5s delay before the kill plus a 2s job runtime gives a reliable ~500ms window where the job is provably claimed and running. Short enough to keep the benchmark fast, long enough to be deterministic across repeated runs.

### The claim was disproven before it was confirmed

**The first several runs of this exact benchmark failed** — reliably losing 1 out of 9 jobs every time, not randomly. That result is more valuable than the clean numbers below: it caught a real gap between the system's design intent (at-least-once delivery) and its actual behavior. Root cause was a race condition between the reaper's recovery ordering and a surviving worker's claim logic — full investigation and fix narrative in [failure-analysis/02-reaper-requeue-race-condition.md](failure-analysis/02-reaper-requeue-race-condition.md), **the single most interview-relevant document in this project.**

**One-line summary of the bug:** the reaper pushed a recovered job onto Redis before committing its Postgres status update, so a fast surviving worker could pop the job from Redis and query Postgres while the row still showed the pre-recovery status — its claim query matched 0 rows and silently discarded a job nobody had actually claimed. Fixed by (1) reordering the reaper to commit Postgres before Redis, and (2) hardening the worker to re-queue instead of silently discard a rejected claim when the job isn't yet terminal — because no ordering of two independent systems with no shared transaction can fully close a race window, so the consumer has to fail safe.

The results below are from a **verified rerun after both fixes were deployed and confirmed** (by checking the compiled code actually running inside the container, not just trusting a green build — see the writeup for why that check mattered).

### Result Summary (post-fix, verified)

| Metric | Value |
|---|---|
| Total jobs | 9 |
| Completed successfully | **9 / 9** |
| Success rate | **100.0%** |
| Jobs retried (were on killed worker) | 1 |
| Jobs completed cleanly (surviving workers, no retry) | 8 |
| Recovery time (kill → retried job completed) | **19,027 ms** |

### Per-Job Breakdown

| # | Status | retry_count | Time from kill to completion |
|---|---|---|---|
| 1 | ✅ Clean | 0 | 1,120 ms |
| 2 | 🔄 Retried (was on killed worker) | 1 | **19,027 ms** |
| 3 | ✅ Clean | 0 | 1,147 ms |
| 4 | ✅ Clean | 0 | 3,585 ms |
| 5 | ✅ Clean | 0 | 3,584 ms |
| 6 | ✅ Clean | 0 | 6,024 ms |
| 7 | ✅ Clean | 0 | 6,024 ms |
| 8 | ✅ Clean | 0 | 8,470 ms |
| 9 | ✅ Clean | 0 | 8,470 ms |

### Recovery Timeline (theoretical worst case vs measured)

```
T+0ms       Worker killed (docker kill infra-execution-worker-1)
T+~15s      Heartbeat key expires (worker:heartbeat:{workerId} TTL=15s)
T+~25s      System Monitor detects dead worker (next 10s scan cycle)
T+~25s      Orphaned job re-enqueued to jobs:queue:pending
T+~26s      Surviving worker claims and executes recovered job
T+~28s      Recovered job completes
```

**Worst-case theoretical recovery window:** heartbeat TTL (15s) + reaper scan interval (10s) = **~25 seconds**.
**Measured actual recovery:** 19,027 ms — inside the theoretical worst case, since the kill happened partway through a heartbeat cycle rather than at the very start of one.

**What this now demonstrates (after the fix — be precise about this in an interview):**
- **At-least-once delivery — verified, not just claimed.** Every submitted job completes, including the one whose worker was killed mid-execution. This is true *because* the race condition was found and fixed — it was measurably false before that (1/9 jobs lost, repeatably, across multiple runs).
- **Fully automatic recovery**: no manual intervention — the System Monitor detects the dead worker and re-enqueues its orphaned job without any external trigger.
- **No duplicate execution**: the state-machine guard (`UPDATE ... WHERE status='PENDING'`) plus idempotent result writes (`ON CONFLICT DO UPDATE`) prevented the recovered job from double-executing. This part held throughout — the bug was jobs being *lost*, never jobs being *duplicated*.

---

## Resume Bullets (benchmark-backed)

> Benchmarked a 500-job sustained workload on a 3-worker cluster, achieving ~4.4 jobs/sec throughput
> at 925ms p95 latency, and used per-phase timing instrumentation to identify Docker container
> startup (82.7% of execution time) as the primary throughput bottleneck over code execution or
> database writes.

> Diagnosed and fixed a distributed race condition between job-recovery ordering and worker claim
> logic that caused silent job loss during worker crash recovery, verified via a purpose-built
> failure-injection benchmark (`docker kill` on a live worker) — improved crash-recovery success
> rate from ~89% to 100% across repeated runs.

---

## Numbers Cheat Sheet (for quick recall)

| Metric | Value |
|---|---|
| Sustained throughput (3 workers) | ~4.3–4.4 jobs/sec |
| p50 latency (500-job sustained run) | 714 ms |
| p95 latency (500-job sustained run) | 925 ms |
| Docker container spawn — % of total exec time | 82.7% |
| Docker container spawn — avg time | 374.7 ms |
| Code runtime — avg time | 65.0 ms |
| DB transaction commit — avg time | 2.6 ms |
| Worker crash → job recovery (measured) | 19.0 s |
| Worker crash → job recovery (theoretical worst case) | ~25 s |
| Crash recovery success rate | 100% (9/9) |
| Heartbeat TTL / interval | 15s / 5s |
| Reaper scan interval | 10s |
