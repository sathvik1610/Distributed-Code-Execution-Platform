# How The System Works

A step-by-step walkthrough of a submission's full lifecycle, from HTTP request to recovered crash.

---

## 1. Submission

The client sends code to:

```http
POST /submissions
```

The API Gateway creates a row in PostgreSQL with status:

```text
PENDING
```

Then it pushes a job payload into Redis:

```text
jobs:queue:pending
```

## 2. Queueing With Redis

Redis is used as a fast queue and coordination layer.

The main queue is:

```text
jobs:queue:pending
```

Each worker also has its own in-flight queue:

```text
jobs:queue:processing:<workerId>
```

This matters because jobs should not disappear if a worker crashes.

## 3. Atomic Job Claim With BRPOPLPUSH

Workers claim jobs using Redis `BRPOPLPUSH`.

In simple terms, `BRPOPLPUSH` means:

```text
Wait until a job exists,
remove it from the pending queue,
place it into this worker's processing queue,
do that move atomically.
```

The job moves from:

```text
jobs:queue:pending
```

to:

```text
jobs:queue:processing:<workerId>
```

Why this is important:

- If a worker uses a normal pop and then crashes, the job can be lost.
- With `BRPOPLPUSH`, the job is still visible in the processing queue.
- The System Monitor can recover it later.

This gives the platform at-least-once job delivery.

## 4. Worker Execution

Once a worker claims a job, it:

1. updates the database status to `RUNNING`,
2. starts a Docker sandbox container,
3. sends the user code into the container through stdin,
4. listens for stdout/stderr,
5. stores output chunks in Redis Streams,
6. publishes chunks live to WebSocket clients,
7. saves the final result in PostgreSQL,
8. removes the job from its processing queue.

## 5. Docker Sandbox

User code is never run directly on the host machine.

It runs inside a Docker container with restrictions:

| Restriction | Purpose |
|---|---|
| `--network none` | Code cannot access the network |
| `--memory 128m` | Code cannot consume unlimited memory |
| `--memory-swap 128m` | Swap is disabled |
| `--pids-limit 50` | Fork bombs are contained |
| `--cpus 1` | CPU usage is bounded |
| `--read-only` | Root filesystem cannot be modified |
| `--user runner` | Code runs as a non-root user |
| `--cap-drop ALL` | Linux capabilities are removed |
| `--security-opt no-new-privileges` | Prevents privilege escalation |
| `--tmpfs /tmp` | Only `/tmp` is writable and memory-backed |

The code is sent over stdin and written to `/tmp` inside the container. No source file needs to be staged on the host filesystem.

## 6. Live Output Streaming

When the sandbox prints output, the worker sends chunks to Redis.

The API Gateway forwards those chunks to WebSocket clients connected to:

```http
GET /stream/:jobId
```

The platform also stores recent chunks in Redis Streams, so a client that connects late can replay previous output and still receive the completion marker.

## 7. Result Persistence

PostgreSQL stores the final result:

- exit code,
- stdout,
- stderr,
- error message,
- error category,
- execution time,
- memory used,
- output truncation flags.

The result write and status update happen inside a database transaction. This keeps submission state and execution output consistent.

## 8. Worker Heartbeats And Crash Recovery

Each worker writes a heartbeat key to Redis:

```text
worker:heartbeat:<workerId>
```

The heartbeat has a short TTL and is refreshed regularly.

The System Monitor scans:

```text
worker:heartbeat:*
jobs:queue:processing:*
```

If it sees a processing queue whose worker heartbeat is gone, it knows that worker died.

Then it:

1. reads the orphaned job,
2. increments `retryCount`,
3. moves the job back to the pending queue,
4. lets another worker execute it.

If a job exceeds the retry limit, it goes to the Dead Letter Queue.

## 9. Dead Letter Queue

The Dead Letter Queue stores jobs that failed too many infrastructure recovery attempts.

Redis key:

```text
jobs:queue:dead-letter
```

This prevents broken jobs from being retried forever.

---

See also: [design-decisions.md](design-decisions.md) for *why* each of these choices was made, and [failure-analysis/](failure-analysis/) for a real bug found in this recovery path and how it was fixed.
