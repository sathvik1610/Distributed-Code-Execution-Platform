# Interview Notes — Distributed Code Execution Platform

Study this before any backend/SDE interview where you mention this project.
These answers are technically precise. Say them calmly, not defensively.

---

## Lead With This: The Reaper Race Condition

**When asked "tell me about a bug you found" or "walk me through a hard technical problem" — this is the answer, not the throughput numbers.** Almost any candidate can describe a system they built. Very few can describe a specific bug they found by testing their own claims, root-caused to an exact ordering issue, and fixed with a specific, defensible change. That's the actual skill this story demonstrates.

**The honest framing (use this, don't sanitize it):**
> "I designed the system to provide at-least-once delivery — heartbeats detect dead workers, a reaper requeues their orphaned jobs, idempotent writes prevent duplicate results. That was the claim. I didn't just assume it was true — I wrote a benchmark that kills a worker mid-execution and checks whether every job still completes. The first several runs disproved my own claim: it reliably lost 1 out of 9 jobs, every single time, not randomly. I traced the job through every system that touches it, found a race condition between the reaper's recovery ordering and a worker's claim logic, fixed it two ways, and reran the benchmark until it hit 100% repeatably."

The full writeup — with the actual debugging steps, not just the fix — is in [failure-analysis/02-reaper-requeue-race-condition.md](failure-analysis/02-reaper-requeue-race-condition.md). Read it before any interview. See also Q5a below for the compressed spoken version.

**The one framing mistake to avoid:** don't present "at-least-once delivery" and "no job loss" as if they were always true. They weren't — the benchmark caught a real gap between design intent and actual behavior. That gap, and how it was closed, is the interesting part. Presenting it as if it always worked throws away the best evidence you have of debugging skill.

---

## Resume Bullet (benchmark-backed, use this over generic phrasing)

> Benchmarked a 500-job sustained workload on a 3-worker cluster, achieving ~4.4 jobs/sec throughput
> at 925ms p95 latency, and used per-phase timing instrumentation to identify Docker container
> startup (82.7% of execution time) as the primary throughput bottleneck over code execution or
> database writes.

Optionally pair with a second bullet on the debugging story:

> Diagnosed and fixed a distributed race condition between job-recovery ordering and worker claim
> logic that caused silent job loss during worker crash recovery, verified via a purpose-built
> failure-injection benchmark (`docker kill` on a live worker) — improved crash-recovery success
> rate from ~89% to 100% across repeated runs.

---

## Interview Questions You Will Almost Certainly Get (with where the answer lives)

| Question | Answer location |
|---|---|
| Why Redis Lists over Streams/Kafka for the work queue? | [design-decisions.md §1](../docs/design-decisions.md) |
| Why `BRPOPLPUSH` specifically? | [design-decisions.md §2](../docs/design-decisions.md), Q4 below |
| Why Docker instead of Firecracker/VMs? | [design-decisions.md §4](../docs/design-decisions.md) |
| Why PostgreSQL instead of MongoDB? | [design-decisions.md §7](../docs/design-decisions.md) |
| Why was Docker startup ~83% of runtime? | [BENCHMARK_RESULTS.md](../BENCHMARK_RESULTS.md) Docker Spawn Profiling |
| How would you eliminate that bottleneck? | "What Would You Build Next?" below |
| Explain the race condition you found. How did you debug it? | "Lead With This" section above + [failure-analysis/02-reaper-requeue-race-condition.md](failure-analysis/02-reaper-requeue-race-condition.md), Q5a below |
| Why is recovery ~19–25 seconds? Why heartbeat TTL = 15s? | [design-decisions.md §5](../docs/design-decisions.md) |
| What happens if Redis crashes during recovery? | [design-decisions.md §11](../docs/design-decisions.md) |
| Why `ON CONFLICT DO UPDATE`? | [design-decisions.md §8](../docs/design-decisions.md) |
| What delivery guarantee does your system provide? | Q2 below (at-least-once, not exactly-once) |
| Why did your throughput numbers change between runs? | Q5b below |
| Is 2.6ms DB write time realistic for production? | Q5c below |
| Why a 2-second sleep in the crash-recovery test? | Q5d below |

---

## 5-Minute System Walk (Memorise This Structure)

> "The system is a distributed code execution platform — think a lightweight LeetCode backend.
> A client POSTs code and a language to the API Gateway. The Gateway validates the request,
> writes a `PENDING` row to Postgres, and pushes a job payload onto a Redis list using `LPUSH`.
> One or more workers sit in a `BRPOPLPUSH` blocking loop — this atomically moves the job from
> the pending list to a per-worker processing list, which is crash-safe. The worker spawns a
> Docker container with strict resource limits — 128 MB memory, 50-process limit, 5-second
> timeout — runs the user code inside it, streams stdout/stderr over Redis pub/sub in real time,
> and writes the final result transactionally to Postgres. The API Gateway relays the stream to
> the client via WebSocket. A System Monitor process runs a reaper loop: it checks worker
> heartbeats every 10 seconds, detects dead workers, and re-enqueues any jobs stranded in their
> processing lists."

---

## Questions to Answer Cold

### Q1 — "Your rate limiter is in-memory. What breaks under load?"

> "An in-memory rate limiter is per-process. If you run two gateway instances behind a load
> balancer, each instance has its own counter, so a client gets 2× their rate limit. The fix
> is a Redis-backed shared counter — I've implemented this using `@fastify/rate-limit`'s `redis`
> option, which uses atomic `INCR`/`EXPIRE` under the hood. For a single gateway this was
> fine as a prototype; the Redis store is the production-correct approach and it's now in place."

### Q2 — "Is your delivery exactly-once?"

> "No — it's at-least-once. The `BRPOPLPUSH` move is atomic, but the result write to Postgres
> and the acknowledgement `LREM` are two separate operations. If the worker crashes between them,
> the System Monitor reaper re-enqueues the job from the processing list. A second execution
> could produce a duplicate result row. I guard against this with `ON CONFLICT (job_id) DO NOTHING`
> on the result insert, so the duplicate write is silently idempotent. The submission still gets
> processed correctly — the user just can't tell it ran twice. Exactly-once would require a saga
> pattern or transactional outbox, which I decided was out of scope."

### Q3 — "Are your workers stateless?"

> "Workers keep no durable local state — no disk writes that survive a restart, no in-memory
> cache that matters. But they do have runtime dependencies: a Redis connection, a Postgres
> connection, and access to the Docker socket. If any of those go away, the worker can't function.
> The distinction I'd draw is: stateless in the sense that you can kill and restart a worker
> at any time without data loss — but not dependency-free."

### Q4 — "Why Redis instead of Kafka?"

> "Three reasons. First, `BRPOPLPUSH` gives atomic dequeue with crash-safe processing-list
> semantics in a single operation — Kafka's consumer groups give you similar guarantees but
> with much more operational overhead. Second, Redis pub/sub is the right primitive for
> ephemeral real-time log streaming — I don't need persistent log replay. Third, at the scale
> of this project, Redis is one less moving part to operate. The tradeoff is that Redis is
> not a durable log — if Redis goes down and loses its in-memory queue state, pending jobs
> that haven't been written to Postgres yet are lost. For a system that needed replay or
> guaranteed durability across Redis restarts, Kafka would be the right choice."

### Q5a — "Tell me about a bug you found and fixed."

> "While writing a benchmark that kills a worker mid-execution to test crash recovery, I found it
> reliably lost 1 out of 9 jobs — not randomly, same pattern every run. I traced the job through
> every system that touches it — API, Redis, Postgres, worker logs — instead of guessing, and found
> the reaper was pushing a recovered job to Redis before updating its status in Postgres. A fast
> surviving worker could pop the job from Redis and run its claim query in the small gap before that
> Postgres update committed, see a stale status, and silently discard the job as 'already claimed by
> someone else.' I fixed it two ways: reordered the reaper to commit Postgres first, and — more
> importantly — hardened the worker so a rejected claim on a non-terminal job gets requeued instead
> of discarded, since reordering alone can't fully close a race between two systems with no shared
> transaction. Reran the benchmark and got 9/9, 100%, repeatably. Full writeup with the actual
> debugging steps: `docs/failure-analysis/02-reaper-requeue-race-condition.md`."

### Q5b — "Why did your throughput numbers change between benchmark runs?"

> "Run-to-run variance is expected on a shared dev host — Docker on WSL2 is sensitive to page
> cache state, host CPU contention from other processes, and whether the Docker daemon is cold
> or warm. An early 9-job run showed ~5 jobs/sec; a later 9-job run of the same scenario showed
> ~3.95 jobs/sec. That's exactly why n=9 isn't a reliable sample on its own — it's why I added the
> 500-job sustained-load scenario. Over 500 jobs and 114 seconds, that variance averages out, and
> the result that matters is that p95 (925ms) tracks p50 (714ms) tightly the entire time — no
> drift, no memory-leak signature, no queue starvation building up under sustained load. That's a
> claim I can defend with data; a single small run's throughput number is not."

### Q5c — "Your DB write is 2.6ms — is that realistic?"

> "That number is accurate for what it measures: a local Postgres instance on the same host as the
> worker, no network hop. It's a fair measurement of the database's own commit cost, but it
> understates what a production deployment would see — a managed Postgres (RDS, Cloud SQL) on a
> separate host adds real network round-trip latency on top of that. I'd expect a few extra
> milliseconds in a real deployment, not a fundamentally different number, since 2.6ms is Postgres
> doing genuinely small work (one INSERT, one UPDATE, both indexed by primary key)."

### Q5d — "Why specifically a 2-second sleep in the crash-recovery test?"

> "It's a deliberate choice, not an arbitrary one. The test needs the killed worker to be
> genuinely mid-execution — not still queued, not already finished — at the exact moment
> `docker kill` fires, so the benchmark actually exercises the orphan-recovery path instead of
> getting lucky or unlucky with timing. A 1.5-second delay before the kill, combined with a
> 2-second job runtime, gives a reliable window where the worker has already claimed the job and
> is actively running it. Short enough to keep the benchmark fast, long enough to be deterministic
> across repeated runs — I wasn't willing to rely on a race with the job's actual completion time."

### Q5 — "How do your memory metrics work? Are they accurate?"

> "Yes, they are highly accurate and race-free. In the initial prototype, we polled `docker stats --no-stream` 
> immediately after container shutdown, but this frequently failed (returned null) for fast-running 
> ephemeral containers due to a race condition with container auto-removal (`--rm`). We resolved this by 
> wrapping the user execution inside the sandboxes with an unprivileged wrapper (`runner-wrapper.sh`) 
> that reads the Linux kernel Cgroups peak memory metrics (`/sys/fs/cgroup/memory.peak` on Cgroups v2, 
> or `/sys/fs/cgroup/memory/memory.max_usage_in_bytes` on Cgroups v1) immediately upon termination. The 
> wrapper outputs a special token (`___MEM_PEAK___: <bytes>`), which the worker parses to populate 
> the DB result, and cleanly strips from the stream before fanning it out to clients."

---

## 3 Tradeoffs to Defend Proactively

| Tradeoff | What to Say |
|---|---|
| **At-least-once delivery** | "Idempotent result inserts guard against duplicate writes. Exactly-once needs a transactional outbox — out of scope, but I know how it works." |
| **Docker socket mount** | "Previously, mounting `/var/run/docker.sock` gave workers root-equivalent access to the host (sibling container escape risk). We solved this by routing all worker requests over a secure internal TCP network to an unprivileged **Docker Socket Proxy** (`tecnativa/docker-socket-proxy`). The proxy filters requests and blocks all dangerous operations (volume binds, image deletions, swarm settings) without adding complex VM isolation." |
| **Single Redis node** | "If Redis goes down, queue, pub/sub, and heartbeats all fail simultaneously. Worker reconnection logic is in place, but in-memory queue state is lost — jobs not yet written to Postgres must be re-submitted. Production fix: Redis Sentinel or ElastiCache with AOF persistence." |

---

## What Would You Build Next?

> "The highest-value next step is replacing per-job Docker spawning with a pre-warmed container
> pool. I measured this precisely — container spawn averages 374.7ms and accounts for 82.7% of
> total execution time per job, versus 65ms for the actual code and 2.6ms for the DB write. A pool
> of idle containers eliminates that latency entirely. Every other improvement — Redis Sentinel,
> distributed tracing, better memory metrics — is operational hardening. The
> container pool is the one thing that directly improves user-perceived performance."

---

## Data Flow Narrative (For Whiteboard)

```
Client
  │  POST /submissions  {code, language}   X-API-Key: ...
  ▼
API Gateway (Fastify)
  ├─ Auth hook: validate X-API-Key (fail-secure — 500 if key not configured)
  ├─ Rate limit: 30 req/min/IP — counters in Redis (shared across instances)
  ├─ Schema validation: code length, language enum
  ├─ INSERT submissions (status=PENDING) → Postgres
  ├─ LPUSH jobs:queue:pending → Redis
  └─ 201 {jobId, status: PENDING}

Redis Queue (jobs:queue:pending)
  │  BRPOPLPUSH  (atomic, blocking, 2s timeout)
  ▼
Execution Worker
  ├─ Atomically moves job → jobs:queue:processing:{workerId}
  ├─ UPDATE submissions SET status=RUNNING WHERE status=PENDING  (optimistic lock)
  ├─ Measures queue wait time (now - submittedAt) → Prometheus histogram
  ├─ docker run -i --rm --memory=128m --pids-limit=50 --tmpfs /tmp:rw,size=32m,mode=1777
  │     ├─ Worker streams code over stdin -> written to /tmp inside container RAM
  │     └─ Streams stdout/stderr → PUBLISH jobs:streams:{jobId}
  ├─ BEGIN TRANSACTION
  │     INSERT submission_results ... ON CONFLICT DO NOTHING
  │     UPDATE submissions SET status={COMPLETED|FAILED|TIMEOUT}
  │   COMMIT
  ├─ LREM jobs:queue:processing:{workerId}  (acknowledge)
  └─ PUBLISH jobs:streams:{jobId}  {type:system, data:EXECUTION_COMPLETE}

API Gateway (subscriber)
  ├─ PSUBSCRIBE jobs:streams:*
  ├─ Forwards chunks → WebSocket → Client
  └─ On EXECUTION_COMPLETE: socket.close(1000)

System Monitor (reaper loop, every 10s)
  ├─ Scan all worker heartbeat keys
  ├─ Find workers with expired TTL (dead)
  └─ BRPOPLPUSH jobs:queue:processing:{deadWorker} → jobs:queue:pending
       (recover orphaned jobs)
```

---

## Quick Numbers to Have Ready

| Metric | Value |
|---|---|
| Memory limit per container | 128 MB |
| Execution timeout | 5 seconds |
| Process limit (pids-limit) | 50 |
| Output cap | 1 MB |
| Max retry count before DLQ | 3 |
| Heartbeat TTL | 15 seconds |
| Heartbeat interval | 5 seconds |
| Rate limit | 30 req/min/IP |
| Docker container spawn (measured, avg) | 374.7 ms — **82.7%** of total execution time |
| Code runtime (measured, avg) | 65.0 ms — 14.3% of total execution time |
| DB transaction commit (measured, avg) | 2.6 ms — 0.6% of total execution time |
| Sustained throughput (3 workers, 500-job run) | ~4.3 jobs/sec, p95 = 925 ms |
| Worker-crash recovery (measured) | 19.0 s (theoretical worst case ~25s), 100% success rate |

---

## What This Project Is (And Is Not)

**It is:** A production-style learning prototype demonstrating distributed systems concepts —
queuing, worker pools, fault tolerance, real-time streaming, and observability.

**It is not:** A hardened multi-tenant production system. The single-node Redis, host kernel sharing,
and lack of real unit tests are documented tradeoffs, not unknown bugs. (Note: the raw Docker socket risk has 
been mitigated via the Docker Socket Proxy, and memory stats races resolved via direct Cgroup telemetry).

**The right framing for an interviewer:**
> "This is a working distributed system with correct failure isolation, unprivileged socket filtering,
> Cgroups peak metrics, and documented limitations. I can explain every tradeoff and what it would take to fix it."
