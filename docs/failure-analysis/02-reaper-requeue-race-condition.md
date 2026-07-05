# Failure Analysis: The Reaper Requeue Race Condition

**Date**: 2026-07-05
**Severity**: High (silent job loss under a specific timing window)
**Component**: System Monitor (reaper), Execution Worker (state-machine claim)
**Status**: Resolved — verified with 100% success across repeated failure benchmarks
**How it was found**: Automated worker-crash-recovery benchmarking (`failure-benchmark.js`), not manual testing or code review

---

## Why this doc exists

This is written the way I'd actually explain it in an interview: what I observed, what I *thought* was happening at each stage, what turned out to be wrong, and how I eventually pinned down the real cause. Debugging distributed race conditions is mostly about disciplined elimination, not intuition — I want the story to show that process, not just the final fix.

---

## 1. The Symptom

I had just finished implementing worker-crash recovery (heartbeats + reaper + orphan job requeueing) and wrote a benchmark to prove it worked end-to-end: submit 9 jobs, kill one worker mid-execution with `docker kill`, then poll every job until it reaches a terminal state.

First run: **8/9 completed, 1 timed out** after 60 seconds. I assumed it was a fluke — maybe the kill happened at an unlucky moment relative to the heartbeat cycle — and reran it.

Second run: **8/9 again.** Different job index, same failure pattern. That ruled out "unlucky one-off" and told me this was a real, reproducible bug — something structural, not random noise.

---

## 2. Building the Mental Model Before Touching Code

Before changing anything, I wanted to know exactly which stage of the recovery pipeline the job was getting lost in. The recovery pipeline has four independent systems that all have to agree: the killed worker (dead), Redis (the queue), Postgres (the source of truth for status), and a surviving worker (the one that should pick the job back up). A silent failure could be hiding in any handoff between them.

So instead of guessing, I checked each system's view of the stuck job in order:

**Step 1 — What does the API say?**
```
GET /submissions/{stuckJobId}
→ { "status": "PENDING", "retryCount": 1, ... }
```
This was the first useful signal. `retryCount: 1` and `status: PENDING` meant the reaper *had* run and *had* recovered this job — this wasn't a case of the reaper failing to detect the dead worker. Something went wrong *after* recovery.

**Step 2 — Is the job actually sitting in the Redis queue, waiting to be picked up?**
```
redis-cli LLEN jobs:queue:pending
→ 0
```
Empty. So the job wasn't stuck waiting in the queue either. Something had already taken it out of Redis. Combined with step 1 (DB still shows PENDING, not RUNNING or COMPLETED), this was the key clue: **a worker touched this job and then didn't finish processing it, and didn't leave it in a recoverable state.**

**Step 3 — Confirm the reaper's own account of what it did.**
```
docker logs execution_system_monitor | grep <jobId>
→ "Orphan job recovered — requeued (attempt 1 of 3)"
```
Confirmed: the reaper found the dead worker's orphaned job and pushed it back onto the pending queue exactly as designed.

**Step 4 — What did a surviving worker actually do with it?**
```
docker logs infra-execution-worker-3 | grep <jobId>
→ "Dequeued job for processing"
→ "Job already claimed, processed, or in invalid state. Skipping."
```

This was the moment the bug became visible. A surviving worker *did* pick the job up off Redis — but its own claim logic then rejected it and threw it away, logging a message that implied the job was already handled by someone else. It wasn't. This confirmed silent job loss, and pointed straight at the worker's claim-acquisition code as the place to look next, rather than anything in Redis or the reaper's detection logic.

---

## 3. Finding the Root Cause

The worker's claim step looks like this:

```typescript
const dbResult = await pool.query(
  `UPDATE submissions
   SET status = 'RUNNING', updated_at = NOW()
   WHERE id = $1 AND status = 'PENDING'
   RETURNING status`,
  [job.jobId]
);

if (dbResult.rows.length === 0) {
  // "someone else must have already claimed this" — DISCARD
}
```

This is a standard optimistic-locking pattern: only transition to `RUNNING` if the row is currently `PENDING`. It's correct in the common case — it's exactly what prevents two workers from double-executing the same job. But it silently assumes that **0 rows matched means another worker legitimately got there first.** That assumption is only safe if the row's status in Postgres is guaranteed to already reflect reality by the time this query runs.

Then I looked at the reaper's requeue code and found the actual ordering bug:

```typescript
// recoverJobsFromDeadWorker() — BEFORE the fix
await redis.lpush(QUEUE_KEYS.PENDING, JSON.stringify(requeued));   // (1) job visible to workers NOW
await pool.query(`UPDATE submissions SET status = 'PENDING' ...`); // (2) DB catches up ~1-2ms later
```

The reaper pushes the job onto Redis *before* telling Postgres the job is `PENDING` again. Between those two lines, the job's row in Postgres still says `RUNNING` — its state from before the original worker was killed.

Meanwhile, surviving workers are sitting in a tight `BRPOPLPUSH` polling loop against Redis. The moment step (1) runs, a worker can immediately pop the job and race straight into its claim query — landing in the gap before step (2) commits. Its `WHERE status = 'PENDING'` clause finds the row still `RUNNING`, matches 0 rows, and the worker (correctly, by its own logic) assumes someone else already claimed it — and discards the job. This is fundamentally a **race condition between recovery ordering and worker claim timing**: the order in which the reaper updates its two backing stores determines whether a fast worker sees a consistent view of the job's state.

This isn't a bug in either piece of code in isolation. The reaper's requeue logic looks fine on its own. The worker's optimistic-lock claim looks fine on its own. The bug only exists in the **interaction** between two independent systems (Redis and Postgres) with no shared transaction between them — a classic distributed-systems failure mode, not a typo or off-by-one.

---

## 4. The Fix — Two Layers, Not One

**Layer 1 — Reorder the producer.** Swap the reaper so Postgres is updated *before* Redis is pushed:

```typescript
// recoverJobsFromDeadWorker() — AFTER the fix
await pool.query(`UPDATE submissions SET status = 'PENDING', retry_count = $2 ... WHERE id = $3`);
await redis.lpush(QUEUE_KEYS.PENDING, JSON.stringify(requeued));
```

This closes the window for the overwhelmingly common case: by the time a worker can possibly see the job in Redis, Postgres already reflects `PENDING`.

**Layer 2 — Harden the consumer.** I initially assumed reordering alone would fix it. It didn't — the benchmark still occasionally lost a job after this change (see §5 below on the deployment complication that initially masked this). The real fix required accepting that **no ordering of two separate network calls to two independent systems can ever fully close a race window without a distributed transaction** (which I explicitly decided was out of scope for this project — see [design-decisions.md](../design-decisions.md)). So instead of trying to make the race window zero, I made the failure mode safe:

```typescript
if (dbResult.rows.length === 0) {
  const statusCheck = await pool.query('SELECT status FROM submissions WHERE id = $1', [job.jobId]);
  const currentStatus = statusCheck.rows[0]?.status;
  const isTerminal = currentStatus === 'COMPLETED' || currentStatus === 'FAILED' || currentStatus === 'TIMEOUT';

  if (!isTerminal) {
    // Not actually done — this was a race, not a legitimate double-claim. Give it back.
    await redis.lpush(QUEUE_KEYS.PENDING, rawJob);
  }
  // else: genuinely already finished by someone else — safe to drop.
}
```

The worker now distinguishes between two situations that used to look identical (0 rows matched): "someone else legitimately already finished this job" (safe to discard) versus "I lost a timing race and this job is still incomplete" (must not discard — put it back). This turns any remaining race window, however small, into a harmless extra queue hop instead of silent data loss.

---

## 5. A Second, Unrelated Bug the First Fix Exposed

After deploying layer 1 and layer 2, I reran the benchmark expecting 9/9 — and still saw 1/9 fail, with the exact same worker log message as before (`"Job already claimed, processed, or in invalid state. Skipping."`) and none of the new logging I'd just added. That was the tell: **if new code is deployed, its new log lines should appear.** They didn't, which meant the new code wasn't actually running, regardless of how confident I was in the fix.

I verified directly instead of continuing to guess:

```bash
docker exec infra-execution-worker-2 grep -c currentStatus /app/services/execution-worker/dist/index.js
→ 0
```

Zero matches. The container was running compiled JavaScript from *before* my source edit. The root cause: this project's `Dockerfile` copies a pre-built `dist/` folder from the host into the image — it does not run `tsc` inside the Docker build:

```dockerfile
COPY services/execution-worker/dist ./services/execution-worker/dist
CMD ["node", "dist/index.js"]
```

I had edited the `.ts` source and run `docker compose build`, but never ran `npm run build` first. The Docker build succeeded, the container started cleanly, health checks passed — nothing indicated anything was wrong. It just silently packaged stale JavaScript. After running `npm run build` and rebuilding the images, `grep`-verifying the fix was actually present inside the running container, and re-testing: **9/9, 100% success.**

**Why this matters for the story:** the first "fix didn't work" result could easily have sent me back into more (unnecessary) theorizing about timing windows, connection pooling, or Postgres isolation levels. Instead of trusting that a green build meant the fix was live, I verified the actual artifact running inside the container before drawing any more conclusions. That's the habit that mattered more than the specific bug.

---

## 6. Verification

Reran `failure-benchmark.js` with both fixes correctly deployed:

```
Total jobs     : 9
Completed      : 9 ✅
Failed/Timeout : 0 ❌
Success rate   : 100.0%
Retried jobs   : 1
Recovery time  : 19,027 ms (within the ~25s theoretical worst case)
```

Full raw numbers: [BENCHMARK_RESULTS.md](../../BENCHMARK_RESULTS.md) (Worker Crash Recovery section), plus resume bullets and interview framing in [ALL_BENCHMARKS.md](../ALL_BENCHMARKS.md).

---

## 7. How I'd Tell This Story in an Interview (60–90 seconds)

> "While benchmarking my worker-crash recovery path, I noticed it reliably lost 1 out of 9 jobs — not randomly, the same failure pattern every run. Instead of guessing, I traced the job through every system that touches it: the API showed it stuck in `PENDING` with `retryCount=1`, meaning the reaper *had* recovered it; Redis's queue was empty, meaning a worker *had* picked it up; but the worker's own logs showed it dequeued the job and immediately discarded it as 'already claimed.' That told me the bug was in the worker's claim logic, not the detection or requeue logic.
>
> The actual cause was a race between two systems that don't share a transaction: the reaper pushed the job to Redis before updating its status in Postgres, so a fast worker could pop it from Redis and query Postgres in the small gap before that status update committed — seeing a stale `RUNNING` row and wrongly concluding someone else already had it.
>
> I fixed it two ways: reordered the reaper to commit Postgres first, which closes most of the window, and — more importantly — changed the worker so a rejected claim on a non-terminal job gets put back on the queue instead of discarded. That second part matters because you can't fully close a race between two independent systems without a distributed transaction, which was out of scope here. So instead of chasing a zero-probability race window, I made the failure mode safe. Reran the benchmark and got 9/9, 100%, repeatably."

**If asked "why didn't reordering alone fix it?"**
> "Because Redis and Postgres are two separate network round-trips with no shared commit. Reordering shrinks the race window from 'the entire requeue operation' down to whatever the network latency is between two calls — it doesn't make it zero. The only way to truly eliminate it would be something like a transactional outbox pattern or two-phase commit, which is real operational complexity for a race that, empirically, was already rare. Hardening the consumer to fail safe was the pragmatic fix for that residual window."

**If asked "how would you catch this earlier next time?"**
> "This is exactly the kind of bug that's nearly invisible in code review — both pieces of code look individually correct — and only shows up under real concurrent load. That's why I built the failure benchmark in the first place rather than relying on manual testing: it exercises the actual timing behavior between the reaper and worker under a real Docker-kill, not a mocked one. Going forward, I'd want a test that intentionally injects a delay in the reaper's Postgres write to force this race deterministically, rather than relying on it happening to occur under load."

---

## 8. Lessons Learned

1. **Silent failure paths are the most dangerous ones.** The worker's "already claimed" branch looked like defensive, correct code — it's the kind of guard you'd approve in review. The bug wasn't a missing check; it was an incomplete distinction between two situations that produce identical symptoms (0 rows matched).

2. **Trace the data, not the code, first.** Checking the job's state in the API, Redis, and the DB logs *before* reading any application code turned an open-ended "why did this fail" into a precise "which specific handoff is broken."

3. **A race between two independent systems can't be fixed by ordering alone.** Reordering reduces probability; it doesn't guarantee correctness. The consumer has to be defensive regardless of how carefully the producer is sequenced.

4. **A green build is not proof that your fix is running.** Verify the actual artifact (`grep` the compiled output inside the running container) before spending more time theorizing about why a fix "isn't working."

5. **This bug was only found because of purpose-built failure testing.** It never surfaced in normal operation or manual testing — it needed a benchmark that actually kills a worker under real concurrent load to expose it.
