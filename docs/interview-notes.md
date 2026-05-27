# Interview Notes — Distributed Code Execution Platform

Study this before any backend/SDE interview where you mention this project.
These answers are technically precise. Say them calmly, not defensively.

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

### Q5 — "How do your memory metrics work? Are they accurate?"

> "Best-effort. The worker calls `docker stats --no-stream` on the container after execution,
> parses the memory field, and stores it. The problem is that `docker stats` on a very short-lived
> container — one that finishes and gets `--rm`'d in under a second — can return null because
> the container is already gone by the time the kernel exposes the cgroup stats. So
> `memory_used_bytes` can be null for fast jobs. The production fix is to read cgroup v2 files
> directly (`/sys/fs/cgroup/memory.peak`) inside the container before it exits, or use
> `docker inspect` with a lifecycle hook. I've documented this as a known limitation."

---

## 3 Tradeoffs to Defend Proactively

| Tradeoff | What to Say |
|---|---|
| **At-least-once delivery** | "Idempotent result inserts guard against duplicate writes. Exactly-once needs a transactional outbox — out of scope, but I know how it works." |
| **Docker socket mount** | "Mounting `/var/run/docker.sock` gives the worker process root-equivalent access to the host. In production you'd use rootless Docker, gVisor, or Firecracker. I've documented this. It's acceptable for a prototype; it would be a hard blocker in a real multi-tenant system." |
| **Single Redis node** | "If Redis goes down, queue, pub/sub, and heartbeats all fail simultaneously. Worker reconnection logic is in place, but in-memory queue state is lost — jobs not yet written to Postgres must be re-submitted. Production fix: Redis Sentinel or ElastiCache with AOF persistence." |

---

## What Would You Build Next?

> "The highest-value next step is replacing per-job Docker spawning with a pre-warmed container
> pool. Every job currently pays 100–300ms just to boot a container before a single line of user
> code runs. A pool of idle containers eliminates that latency entirely. Every other improvement —
> Redis Sentinel, distributed tracing, better memory metrics — is operational hardening. The
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
  ├─ docker run --rm --memory=128m --pids-limit=50 --timeout=5s
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
| Container cold-start overhead | ~100–300 ms |

---

## What This Project Is (And Is Not)

**It is:** A production-style learning prototype demonstrating distributed systems concepts —
queuing, worker pools, fault tolerance, real-time streaming, and observability.

**It is not:** A hardened multi-tenant production system. The Docker socket risk, single-node
Redis, and lack of real unit tests are documented tradeoffs, not unknown bugs.

**The right framing for an interviewer:**
> "This is a working distributed system with correct failure isolation and documented limitations.
> I can explain every tradeoff and what it would take to fix it."
