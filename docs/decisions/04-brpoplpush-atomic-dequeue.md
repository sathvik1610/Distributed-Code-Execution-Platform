# Decision: BRPOPLPUSH for Atomic Job Dequeue

**Date**: 2026-05-21  
**Status**: Accepted  
**Component**: Execution Worker — Queue Consumption

---

## Context

Workers need to consume jobs from the Redis pending queue and execute them. A naive approach would be:

```
1. RPOP job from pending queue
2. Process the job
3. If crash between step 1 and 2: job is GONE FOREVER
```

This is the classic "at-most-once" delivery pattern — unacceptable for a reliability-focused system.

We needed **at-least-once** delivery with crash recovery.

---

## Decision

We use **`BRPOPLPUSH`** (blocking pop and push to another list) to atomically dequeue jobs.

In modern Redis (≥6.2), this is `BLMOVE` with `LEFT` and `RIGHT` directions, but `BRPOPLPUSH` works identically and is still supported.

---

## How It Works

```
BRPOPLPUSH  source           destination           timeout
            jobs:queue:pending  jobs:queue:processing:{workerId}  2

This command:
  1. Blocks until a job appears in `pending` (or timeout expires)
  2. Pops the job from the tail of `pending`
  3. Pushes it onto the head of `processing:{workerId}`
  4. Returns the job payload
  5. All of this happens ATOMICALLY — no gap between pop and push
```

### Queue State After Dequeue

```
Before:  pending=[job1, job2, job3]    processing:worker-A=[]
After:   pending=[job1, job2]          processing:worker-A=[job3]
```

### If Worker Crashes

```
Worker dies mid-execution.
pending=[]
processing:worker-A=[job3]   ← job is STILL HERE

System Monitor (Reaper) detects:
  - worker:heartbeat:worker-A key has EXPIRED
  - processing:worker-A is NOT empty
  → Reads job3 from processing:worker-A
  → Re-enqueues in pending (with retryCount++)
  → Deletes processing:worker-A
```

The job is recovered without data loss.

---

## Why Not RPOP + LPUSH (Non-Atomic)?

```
t=0: Worker A: RPOP job from pending        ← job3 is removed from pending
t=1: [Worker A crashes before LPUSH]        ← job3 is LOST FOREVER
t=2: Job3 never appears in any queue
```

A non-atomic pop-then-push has a race window. `BRPOPLPUSH` eliminates this race entirely because it's a single Redis command executed within the server's single-threaded command loop.

---

## Blocking vs Polling

`BRPOPLPUSH` **blocks** the Redis connection for up to `timeout` seconds waiting for a job. This means:

- **Zero CPU spin-wait** — the worker sleeps at the OS level while waiting
- **Zero Redis polling overhead** — no `RPOP; sleep(1); RPOP; sleep(1)...` loop
- **Low latency** — job is picked up within milliseconds of enqueue

We use a 2-second timeout. If no job arrives in 2 seconds, the command returns `null` and the loop continues. This allows for clean shutdown checks (the `shouldRun` flag is checked at the top of each loop iteration).

---

## Code Pattern

```typescript
while (shouldRun) {
  // Blocks for up to 2 seconds. Returns job or null.
  const rawJob = await redis.brpoplpush(
    'jobs:queue:pending',
    `jobs:queue:processing:${workerId}`,
    2
  );

  if (!rawJob) continue;  // Timeout — loop again

  // Job is safely in processing queue even if we crash here
  const job = JSON.parse(rawJob);
  await executeJob(job);

  // Acknowledge: remove from processing queue only AFTER success
  await redis.lrem(`jobs:queue:processing:${workerId}`, 1, rawJob);
}
```

---

## Conclusion

`BRPOPLPUSH` is a simple reliable Redis-list pattern for this scope to implement a distributed job queue in Redis. It is one of the most important engineering decisions in this project and directly enables the crash recovery behavior of the System Monitor.

This pattern is used by Bull (the popular Redis job queue library) internally. We implement it directly to demonstrate deep understanding of the mechanism.
