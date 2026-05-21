# Failure Analysis: Worker Crash & Job Recovery

**Date**: 2026-05-21  
**Severity**: Critical  
**Component**: Execution Worker, System Monitor  
**Status**: Resolved with automated recovery

---

## Issue

During development, we observed that when an execution worker process crashed or was killed (via `kill -9` or `SIGKILL`) while actively processing a job, the job would remain **stuck in `RUNNING` state in the database forever**.

Additionally, the job payload remained in `jobs:queue:processing:{workerId}` in Redis with no process to process it — effectively an orphaned job.

---

## Root Cause

### How BRPOPLPUSH Creates the Crash Window

When a worker calls `BRPOPLPUSH`, the job moves:
```
jobs:queue:pending → jobs:queue:processing:{workerId}
```

The job is only removed from `processing:{workerId}` **after** successful completion:
```typescript
await redis.lrem(processingQueue, 1, rawJob);  // Acknowledgement
```

If the worker crashes at ANY point between the `BRPOPLPUSH` and the `LREM`, the job is:
1. No longer in `pending` (it was popped)
2. Still in `processing:{workerId}` (never acknowledged)
3. Its DB status is stuck at `RUNNING`

This is a **two-phase commit problem** in distributed systems.

### Why Heartbeats Are Necessary

Without heartbeats, there is no way to distinguish between:
- A worker that is alive and actively processing a long job
- A worker that has crashed

The heartbeat TTL key `worker:heartbeat:{workerId}` (refreshed every 5 seconds, expires in 15 seconds) provides a signal: **if the key is gone, the worker is dead**.

---

## Impact

| Scenario | Without Recovery | With Recovery |
|---|---|---|
| Worker crashes mid-execution | Job stuck in RUNNING forever | Job requeued by System Monitor |
| Worker OOM killed | Job lost | Job recovered within 10-15s |
| Network partition to Redis | Heartbeat expires | Job recovered within 15-25s |
| Docker daemon restart | All workers die | All processing queues scanned |

---

## Fix

### Part 1: Heartbeat System (Execution Worker)

```typescript
async function sendHeartbeat() {
  await redis.set(
    `worker:heartbeat:${workerId}`,
    'alive',
    'EX', 15  // TTL: 15 seconds
  );
}

// Send immediately on startup, then every 5 seconds
await sendHeartbeat();
setInterval(sendHeartbeat, 5000);
```

### Part 2: System Monitor / Reaper

The System Monitor runs a scan every 10 seconds:

```typescript
async function runReaperScan() {
  // 1. Find all processing queues
  const processingQueues = await scanKeys('jobs:queue:processing:*');

  // 2. Find all alive workers
  const aliveHeartbeats = await scanKeys('worker:heartbeat:*');
  const aliveWorkers = new Set(aliveHeartbeats.map(extractWorkerId));

  // 3. Dead = has processing queue but no heartbeat
  const deadWorkers = processingQueues
    .map(extractWorkerId)
    .filter(id => !aliveWorkers.has(id));

  // 4. Recover each dead worker's jobs
  for (const deadWorkerId of deadWorkers) {
    await recoverJobsFromDeadWorker(deadWorkerId);
  }
}
```

### Part 3: Idempotent DB Write (Prevents Duplicate Results)

After recovery, a job may be retried by a different worker. If the original worker had already written the result to the DB before crashing (and before the LREM), the retry must not create a duplicate row.

```sql
INSERT INTO submission_results (job_id, exit_code, stdout, stderr, ...)
VALUES ($1, $2, $3, $4, ...)
ON CONFLICT (job_id) DO NOTHING;
```

The `UNIQUE(job_id)` constraint on `submission_results` makes the second insert a no-op. The final `UPDATE submissions SET status = ...` is also safe to repeat.

### Part 4: Non-Blocking SCAN (Not KEYS)

When scanning for heartbeat/processing keys in Redis, we use `SCAN` with a cursor pattern:

```typescript
async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== '0');
  return keys;
}
```

**Why not `KEYS *`?** The `KEYS` command blocks the Redis event loop for the entire duration of the scan. On a production Redis instance with thousands of keys, this can block for hundreds of milliseconds, stalling all other operations. `SCAN` iterates non-destructively and does not block.

---

## Lessons Learned

1. **`BRPOPLPUSH` is necessary but not sufficient.** The atomic dequeue prevents job loss at the Redis level, but you still need a recovery mechanism for in-flight jobs when workers die.

2. **Heartbeats must have a shorter refresh interval than TTL.** Our configuration: 5s refresh, 15s TTL. This means a heartbeat failure of up to 10 seconds (two missed sends) is tolerated before the key expires.

3. **Idempotency must be designed in from the start.** It cannot be bolted on. The `UNIQUE(job_id)` constraint and `ON CONFLICT DO NOTHING` pattern must be there before any retry mechanism is added.

4. **`KEYS` in production Redis is dangerous.** Always use `SCAN`.

5. **Dead worker recovery must also handle the DLQ case.** A job recovered and retried three times that still fails must be moved to the dead-letter queue — not retried indefinitely. Infinite retries can mask systemic problems.

---

## Recovery Timeline

```
t=0s   Worker processes job → sends heartbeat
t=5s   Worker sends heartbeat (TTL reset to 15s)
t=7s   Worker process KILLED
t=22s  Heartbeat key expires (7s + 15s TTL)
t=30s  System Monitor scan runs → detects dead heartbeat
t=30s  Reaper reads jobs:queue:processing:{deadWorker}
t=30s  Job requeued in jobs:queue:pending with retryCount=1
t=31s  Active worker picks up job via BRPOPLPUSH
t=35s  Job completes successfully
```

**Total downtime for the job: ~25 seconds** in the worst case.
