# Design Decisions

This document explains every significant architectural choice in the platform, including the reasoning, the alternatives considered, and the tradeoffs accepted. These are the questions you will be asked in interviews.

---

## 1. Why Redis for the Job Queue?

**Decision:** Use Redis Lists as the job queue and Redis Streams + Pub/Sub for output delivery.

**Alternatives considered:**
- RabbitMQ — mature message broker with explicit ack/nack semantics
- Kafka — distributed log, excellent for high-throughput replay
- PostgreSQL SKIP LOCKED — use the DB itself as a queue

**Why Redis won:**
- Single dependency covers four different needs: queue (List), live streaming (Pub/Sub), replay (Streams), worker heartbeats (String with TTL). One `docker compose` service, zero extra operational overhead.
- `BRPOPLPUSH` gives atomic crash-safe job claiming in a single command — no custom locking needed.
- Simple operational visibility: `redis-cli llen jobs:queue:pending` gives queue depth instantly.
- Appropriate for this throughput scale (hundreds of concurrent jobs). Kafka's overhead is unjustified.

**Tradeoffs accepted:**
- Redis is in-memory. Mitigated by: AOF persistence (appendonly yes, appendfsync everysec), PostgreSQL as the durable source of truth, and startup queue recovery that re-hydrates Redis from the DB.
- No built-in Dead Letter Queue — implemented manually as a Redis List.
- Pub/Sub doesn't persist messages — mitigated by Redis Streams for replay.

---

## 2. Why `BRPOPLPUSH` Instead of `RPOP`?

**Decision:** Workers claim jobs with `BRPOPLPUSH(pending_queue, processing_queue, timeout)`.

**The problem with RPOP:**
```
Worker A: RPOP → gets job, job is gone from queue
Worker A: [crashes here]
Job: lost forever
```

**Why BRPOPLPUSH is correct:**
```
Worker A: BRPOPLPUSH → job moves pending → processing:worker-A atomically
Worker A: [crashes here]
Job: still visible in processing:worker-A
System Monitor: detects dead heartbeat, reads processing:worker-A, re-enqueues job
```

The key property: the job is never in a state where it belongs to no one. It is either in `pending` (waiting) or in `processing:{workerId}` (owned). There is no moment where a crash loses the job.

`BRPOPLPUSH` is also blocking — the worker sleeps until a job arrives. Zero CPU spin on an idle queue.

---

## 3. Why `spawn()` Instead of `exec()`?

**Decision:** `child_process.spawn()` is used to invoke Docker, not `exec()`.

**The problem with `exec()`:**
- Buffers all stdout + stderr in memory until the process exits — no real-time streaming.
- Crashes with `Error: maxBuffer exceeded` if output is large, before we can apply our own cap.
- Shell injection surface: `exec('docker run ' + userInput)` is exploitable.

**Why `spawn()` is correct:**
- Streams stdout/stderr as chunks arrive — enables real-time WebSocket delivery.
- No shell: `spawn('docker', ['run', '--memory', '128m', ...])` passes arguments as an array, bypassing shell parsing entirely. Immune to injection.
- We implement our own 1 MB stream cap and can kill the container the moment it's exceeded.

---

## 4. Why Docker Instead of Virtual Machines or nsjail?

**Decision:** Each code submission runs in a Docker container with strict resource flags.

**Alternatives considered:**
- Virtual machines (QEMU, Firecracker) — stronger isolation, heavier startup (~1–2 seconds per VM vs ~200–500ms per container)
- nsjail — Linux namespace sandboxing without Docker overhead, but requires complex setup and root/CAP_SYS_ADMIN
- gVisor — kernel syscall interception, strong isolation, more complex to deploy

**Why Docker won:**
- First-class resource limiting via CLI flags: `--memory`, `--pids-limit`, `--cpus`, `--network none`, `--cap-drop`, `--read-only` — exactly what we need, one flag per restriction.
- Multi-language support: swap the image, everything else stays the same.
- ~375ms average container spawn time, measured directly (see [BENCHMARK_RESULTS.md](../BENCHMARK_RESULTS.md)'s Docker spawn profiling) — acceptable for a sandbox with a 5-second timeout. This is on WSL2/Docker Desktop; expect faster spawn on bare-metal Linux.
- No kernel-level setup — runs on any Docker host without special privileges.

**Security gaps acknowledged:**
- No seccomp profile applied — a malicious program could call dangerous syscalls not blocked by capability drops.
- No AppArmor/SELinux profile.
- For production, seccomp + AppArmor would be the next hardening step.

---

## 5. Why Heartbeat TTL = 15 Seconds?

**Decision:** Workers send a heartbeat every 5 seconds with a 15-second TTL. The reaper scans every 10 seconds.

**The math:**
- TTL = 3 × heartbeat interval → survives 2 consecutive missed heartbeats (transient network hiccup, GC pause, brief overload)
- 10-second reaper interval: worst-case recovery = 15s (heartbeat expiry) + 10s (next scan) = 25 seconds
- 10-second TTL: too sensitive — 1 missed heartbeat declares worker dead, high false-positive rate
- 30-second TTL: 25s extra delay before recovery, too slow

The 5s/15s/10s triad gives: fault tolerance against transient failures + ~25s worst-case recovery time.

---

## 6. Why Separate `submissions` and `submission_results` Tables?

**Decision:** Job metadata (status, retry_count) and execution output (stdout, stderr, exit_code) are in separate tables.

**Alternatives considered:**
- Single wide table with all columns

**Why separate tables:**
- `submissions` is written immediately on POST (before execution). `submission_results` is written only after execution. Keeping them separate avoids nullable columns with complex invariants.
- The `ON CONFLICT (job_id) DO UPDATE` idempotency pattern requires `job_id` to be UNIQUE in `submission_results` — clean as a standalone table.
- Status queries (`WHERE status = 'PENDING'`) don't need to JOIN large text fields (stdout, source_code). Separate tables keep those queries fast.

---

## 7. Why PostgreSQL Instead of MongoDB?

**Decision:** Job metadata, status, and results live in PostgreSQL, not a document store.

**Alternatives considered:**
- MongoDB — flexible schema, easy to add fields like `errorCategory` without a migration
- DynamoDB — managed, scales horizontally with no ops burden

**Why PostgreSQL won:**
- **The core requirement is a correctness guarantee, not schema flexibility.** The job state machine (`PENDING → RUNNING → COMPLETED/FAILED/TIMEOUT`) needs atomic, all-or-nothing writes when a job finishes — the transaction described below writes the result row and updates status together, or neither happens. MongoDB has multi-document transactions now, but they're bolted on to a model designed around single-document atomicity; PostgreSQL transactions are the native, well-understood default.
- **`ON CONFLICT (job_id) DO UPDATE`** is a single-statement, race-free idempotent upsert — exactly what's needed when the reaper's retried job and the original (crashed) worker could theoretically both try to write a result. The equivalent in MongoDB (`updateOne` with `upsert: true`) works too, but the guarantee is less central to the database's design.
- **The schema is genuinely fixed and relational**, not evolving: `submissions` and `submission_results` have known columns from day one, and they're joined by `job_id` — a textbook relational shape. MongoDB's flexible schema solves a problem (unpredictable/evolving document shape) this project doesn't have.
- **SQL queries for status filtering** (`WHERE status = 'PENDING' ORDER BY created_at`) used in startup recovery are simple, indexable, and don't need MongoDB's aggregation pipeline.

**Tradeoff accepted:** less flexibility if the schema needs to change later (e.g., adding per-language metadata with wildly different shapes) — a proper migration is required, whereas MongoDB would just accept a new field. For this project's stable, well-understood schema, that flexibility isn't worth trading away transactional guarantees for.

---

## 8. Why the PostgreSQL Transaction?

**Decision:** Result INSERT and status UPDATE are wrapped in `BEGIN`/`COMMIT`.

**The split-brain problem without a transaction:**
```
Worker: INSERT submission_results (stdout="hello") ← committed
Worker: [crashes here]
Worker: UPDATE submissions SET status='COMPLETED' ← never runs
State: result exists in DB, status stuck at RUNNING forever
```

**With a transaction:**
- Both succeed together, or neither does.
- If the worker crashes mid-transaction, PostgreSQL rolls back automatically.
- The job stays in `processing:{workerId}`, the reaper recovers it, and the retry re-runs cleanly.
- The `ON CONFLICT DO UPDATE` on `submission_results` makes repeated retries idempotent — the second attempt overwrites the first row safely.

---

## 9. Why Redis Streams AND Pub/Sub Together?

**Decision:** Output chunks are written to both a Redis Stream (`XADD`) and a Pub/Sub channel (`PUBLISH`) simultaneously.

**Why not just Pub/Sub?**
- Pub/Sub is fire-and-forget. A client connecting 2 seconds after execution starts misses the first 2 seconds of output — no history.

**Why not just Streams?**
- Streams require polling (`XREAD BLOCK`) — adds latency per poll cycle.

**Combined approach:**
- Live clients receive chunks instantly via Pub/Sub subscription (zero poll latency).
- Late-joining clients replay all chunks from the Stream (`XRANGE - +`), then subscribe to Pub/Sub for the remainder.
- Stream TTL = 1 hour. Stream entries capped at 1000 (`MAXLEN ~`). Both limits prevent unbounded growth.

---

## 10. Why a Docker Socket Proxy?

**Decision:** Only the `docker-proxy` container mounts `/var/run/docker.sock`. Workers connect to it via TCP (`tcp://docker-proxy:2375`).

**The problem with raw socket access:**
- `/var/run/docker.sock` is effectively root. A compromised worker with raw socket access could: read all containers, spawn privileged containers, mount host filesystem, escape the sandbox entirely.

**The fix:**
- `tecnativa/docker-socket-proxy` exposes only a restricted subset of the Docker API.
- Workers can only perform container lifecycle operations (`CONTAINERS=1, POST=1, GET=1`).
- Cannot list volumes, networks, images, or exec into containers.

---

## 11. What Happens if Redis Crashes?

**Before (no persistence):** All pending jobs lost. Jobs with status PENDING or RUNNING in PostgreSQL are stuck forever — no worker will ever pick them up.

**After (AOF persistence + startup recovery):**
1. AOF (`appendonly yes --appendfsync everysec`) syncs every write to disk every second. At most 1 second of data loss on a hard crash.
2. On restart, Redis replays the AOF log — queue is restored.
3. On system-monitor startup: `recoverOrphanedJobsOnStartup()` resets any RUNNING jobs to PENDING and re-hydrates the Redis queue from DB if it's empty. This covers the case where AOF didn't have a chance to flush.

---

## 12. What Happens if the System Monitor Crashes?

**The gap:** If the system-monitor process crashes, no one is watching for dead workers. Jobs belonging to dead workers stay orphaned in `processing:{workerId}` indefinitely.

**Current mitigation:**
- `restart: always` in Docker Compose ensures the monitor restarts automatically.
- On restart, `recoverOrphanedJobsOnStartup()` immediately recovers any stuck jobs.

**Production improvement:**
- Kubernetes `restartPolicy: Always` with liveness probes.
- Multiple monitor replicas — the distributed reaper lock (`reaper:lock` with `SET NX`) ensures only one runs the scan at a time, preventing double-recovery.

---

## 13. What Happens if Two Monitor Instances Run?

**The race condition without a lock:**
```
Monitor A: SCAN → finds dead worker-xyz
Monitor B: SCAN → finds dead worker-xyz (same scan, same second)
Monitor A: re-enqueues job-abc → pending queue
Monitor B: re-enqueues job-abc → pending queue (duplicate!)
Two workers claim job-abc.
Worker 1: UPDATE WHERE status=PENDING → 1 row, proceeds
Worker 2: UPDATE WHERE status=PENDING → 0 rows (already RUNNING), skips
Result: no double execution, but job-abc was in the queue twice — wasted work.
```

**Fix (implemented):** `SET reaper:lock {uuid} NX PX 15000` at the top of each scan. Only one monitor acquires the lock; the other skips. Lock is released via Lua script that checks ownership before deleting — prevents a crashed monitor from releasing a lock re-acquired by another instance.

---

## 14. Why Rate Limit Per IP, Not Per User?

**Current:** 30 requests/minute per IP via Redis atomic counters (`@fastify/rate-limit`).

**Why IP-based:**
- No per-user auth system exists (single API key). Per-user rate limiting requires user identity.
- IP-based is correct for public APIs where you don't trust the caller.

**What production would look like:**
- JWT or per-user API keys. Rate limit key = `user_id` extracted from token.
- Per-user quotas stored in DB, enforced in middleware.

---

## Known Production Gaps (be ready to name these yourself)

| Gap | Impact | Fix |
|---|---|---|
| Single API key | No per-user isolation | JWT / per-user keys |
| No seccomp profile | Syscall abuse possible | Add `--security-opt seccomp=profile.json` |
| Single Redis instance | SPOF for queue | Redis Sentinel or Cluster |
| Single PostgreSQL | SPOF for results | Streaming replication + read replica |
| No job cancellation | Runaway jobs must timeout | `DELETE /submissions/:id` + worker cancel check |
| No autoscaling | Manual `--scale` | Kubernetes HPA on queue depth metric |
