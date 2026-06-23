# Architecture Deep Dive

This document explains how the Distributed Code Execution Platform works internally. It is written for someone who wants to understand the system design, not just run the project.

---

## 1. High-Level Goal

The platform executes untrusted Python and JavaScript code safely.

The main engineering challenges are:

- code may be malicious or buggy,
- code must not damage the host machine,
- jobs should not be lost if a worker crashes,
- users should see output while the program is running,
- final results must be saved durably,
- the system should support multiple workers,
- failures should be observable and testable.

The solution uses a distributed worker architecture with Redis, PostgreSQL, Docker, WebSockets, and a monitor service.

---

## 2. Component Overview

```text
Client
  |
  v
API Gateway
  |
  +--> PostgreSQL       stores submissions and results
  |
  +--> Redis            stores queue, streams, heartbeats
          |
          v
    Execution Workers
          |
          v
    Docker Sandboxes

System Monitor watches Redis heartbeats and processing queues.
Prometheus and Grafana observe the system.
```

### API Gateway

The API Gateway is the public entrypoint.

Responsibilities:

- authenticate requests using `X-API-Key`,
- validate request bodies and query params,
- create submissions,
- enqueue jobs,
- return job status/results,
- serve WebSocket output streams,
- replay recent output for late WebSocket clients,
- expose Prometheus metrics.

### PostgreSQL

PostgreSQL is the durable source of truth.

It stores:

- submission metadata,
- source code,
- status,
- retry count,
- stdout/stderr,
- error category,
- execution time,
- memory usage,
- output truncation flags.

PostgreSQL is used because final results need durability and transactional consistency.

### Redis

Redis is the fast coordination layer.

It stores:

- pending jobs,
- per-worker processing queues,
- dead-letter jobs,
- worker heartbeats,
- replayable output streams.

Redis is used because it provides fast atomic list operations and lightweight stream/pub-sub primitives.

### Execution Worker

Workers execute jobs.

Each worker:

- has a unique `workerId`,
- sends heartbeat keys to Redis,
- claims jobs atomically,
- starts Docker sandbox containers,
- streams output,
- writes final results,
- acknowledges completed jobs.

Workers are stateless. You can run multiple replicas.

### System Monitor

The System Monitor is the recovery service.

It periodically checks:

- which workers are alive,
- which processing queues exist,
- whether any processing queue belongs to a dead worker.

If a worker died with a job in progress, the monitor requeues that job.

### Docker Sandbox

The sandbox is where user code runs.

Each submitted job gets a fresh container with strict limits:

- no network,
- memory limit,
- process limit,
- CPU limit,
- read-only filesystem,
- non-root user,
- no Linux capabilities,
- writable `/tmp` only.

---

## 3. Submission Lifecycle

### Step 1: Client submits code

```http
POST /submissions
X-API-Key: test-api-key
Content-Type: application/json

{
  "language": "python",
  "code": "print('hello')"
}
```

### Step 2: API stores submission

The API inserts a row into PostgreSQL:

```text
status = PENDING
retry_count = 0
```

### Step 3: API enqueues job

The API pushes a JSON job payload into Redis:

```text
jobs:queue:pending
```

### Step 4: Worker claims job

A worker waits for a job using `BRPOPLPUSH`.

The job moves from:

```text
jobs:queue:pending
```

to:

```text
jobs:queue:processing:<workerId>
```

### Step 5: Worker marks job running

The worker updates PostgreSQL:

```text
PENDING -> RUNNING
```

### Step 6: Worker runs Docker sandbox

The worker starts a sandbox container and sends the code through stdin.

Inside the container:

1. `runner-wrapper.sh` reads stdin,
2. writes the code to `/tmp/code.py` or `/tmp/code.js`,
3. executes it,
4. reads cgroup memory usage,
5. prints a memory token for the worker to parse.

### Step 7: Output streaming

When code prints to stdout/stderr:

1. worker receives output chunk,
2. worker stores chunk in Redis Stream,
3. worker publishes chunk live,
4. API Gateway forwards chunk to WebSocket clients.

### Step 8: Result persistence

When the container exits, the worker writes the result in PostgreSQL:

```text
status = COMPLETED | FAILED | TIMEOUT
stdout = ...
stderr = ...
exit_code = ...
execution_time_ms = ...
```

The result insert and status update happen in a transaction.

### Step 9: Queue acknowledgement

After the database transaction succeeds, the worker removes the job from its processing queue.

This is the acknowledgement step.

---

## 4. Redis Queue Design

Redis keys used by the queue:

| Key | Purpose |
|---|---|
| `jobs:queue:pending` | Jobs waiting to be executed |
| `jobs:queue:processing:<workerId>` | Jobs currently owned by a worker |
| `jobs:queue:dead-letter` | Jobs that exhausted retry recovery |
| `worker:heartbeat:<workerId>` | Worker liveness marker |
| `jobs:streams:<jobId>` | Replayable stdout/stderr stream |

---

## 5. What BRPOPLPUSH Means

`BRPOPLPUSH` is a Redis command.

Breakdown:

- `B` = blocking: wait until an item exists,
- `RPOP` = remove item from the right side of a list,
- `LPUSH` = push item to the left side of another list.

In this project:

```text
BRPOPLPUSH jobs:queue:pending jobs:queue:processing:<workerId> 2
```

This means:

```text
Wait up to 2 seconds for a pending job.
When one exists, atomically move it into this worker's processing queue.
```

Why this is important:

A naive queue might do this:

```text
1. remove job from pending
2. run job
```

If the worker crashes after step 1, the job is gone.

This platform does this instead:

```text
1. move job from pending to processing:<workerId>
2. run job
3. remove from processing only after result is saved
```

If the worker crashes during execution, the job is still in Redis and can be recovered.

---

## 6. Worker Crash Recovery

Each worker sends a heartbeat every few seconds:

```text
worker:heartbeat:<workerId>
```

The key has a TTL. If the worker dies, the key expires automatically.

The System Monitor scans:

```text
worker:heartbeat:*
jobs:queue:processing:*
```

If it finds this situation:

```text
processing queue exists
but matching heartbeat does not exist
```

then it knows:

```text
that worker died while owning a job
```

The monitor then:

1. reads the job from the dead worker processing queue,
2. checks whether the database status is already terminal,
3. increments retry count,
4. pushes the job back to `jobs:queue:pending`,
5. deletes the dead processing queue.

A surviving worker then picks up the job and runs it.

The failure test `05-worker-crash.py` verifies this behavior by killing the exact worker container that claimed a job.

---

## 7. Status Model

Submissions move through this state machine:

```text
PENDING -> RUNNING -> COMPLETED
                   -> FAILED
                   -> TIMEOUT
```

Terminal statuses:

```text
COMPLETED
FAILED
TIMEOUT
```

A terminal job should not be requeued.

---

## 8. Docker Sandbox Security

User code is dangerous. It may try to:

- run forever,
- allocate unlimited memory,
- spawn unlimited processes,
- print unlimited output,
- access the network,
- write files,
- escalate privileges.

The sandbox blocks or limits these behaviors.

| Risk | Mitigation |
|---|---|
| Infinite loop | Worker timeout |
| Memory exhaustion | Docker memory limit |
| Fork bomb | Docker PID limit |
| Network abuse | `--network none` |
| Filesystem writes | `--read-only` plus writable tmpfs only |
| Privilege escalation | non-root user, dropped capabilities, no-new-privileges |
| Infinite output | stream cap and DB output cap |

Sandbox flags:

```text
--network none
--cpus 1
--memory 128m
--memory-swap 128m
--pids-limit 50
--read-only
--tmpfs /tmp:rw,size=32m,mode=1777
--user runner
--cap-drop ALL
--security-opt no-new-privileges
```

---

## 9. Docker Socket Proxy

The execution worker needs to ask Docker to start containers.

A dangerous approach would be to mount this directly into the worker:

```text
/var/run/docker.sock
```

That socket is powerful. A compromised worker with raw Docker socket access could control the host.

This project uses a Docker Socket Proxy:

```text
worker -> docker-proxy -> Docker daemon
```

The proxy limits what Docker operations the worker can perform.

This is safer than giving every worker direct Docker socket access.

---

## 10. Output Streaming And Replay

The platform supports live output streaming.

Output path:

```text
sandbox stdout/stderr
  -> worker
  -> Redis Stream + Redis pub/sub
  -> API Gateway
  -> WebSocket client
```

Redis pub/sub is used for live delivery.

Redis Streams are used for replay. If a client connects after a job has already finished, the API Gateway can replay recent chunks from:

```text
jobs:streams:<jobId>
```

The stream also includes a final system message:

```json
{
  "type": "system",
  "data": "EXECUTION_COMPLETE"
}
```

---

## 11. Output Caps

The platform has two output limits:

| Limit | Purpose |
|---|---|
| 64 KB persisted output | Prevents database bloat |
| 1 MB stream output | Prevents Redis/WebSocket overload |

If output exceeds the stream cap, the worker kills the sandbox and marks:

```text
streamOutputLimitExceeded = true
outputTruncated = true
```

This protects the infrastructure from programs that print forever.

---

## 12. PostgreSQL Transactions

The worker writes results using a transaction.

Conceptually:

```sql
BEGIN;
INSERT OR UPDATE submission_results;
UPDATE submissions SET status = final_status;
COMMIT;
```

Why this matters:

- result and status should agree,
- a crash midway should not leave half-written state,
- retries should not create duplicate result rows.

The `submission_results.job_id` column is unique, so repeated writes for the same job update the same result record.

---

## 13. Dead Letter Queue

If infrastructure recovery keeps failing, the job eventually goes to:

```text
jobs:queue:dead-letter
```

This prevents infinite retry loops.

The DLQ can be inspected through:

```http
GET /dlq
```

---

## 14. Observability

The services expose Prometheus metrics:

| Service | Port | Examples |
|---|---|---|
| API Gateway | `9100` | rate-limit hits, active WebSockets, queue depth |
| Execution Worker | `9101` | job counts, execution duration, queue wait time |
| System Monitor | `9102` | dead worker recoveries, DLQ jobs |

Grafana is available at:

```text
http://localhost:3000
```

Prometheus is available at:

```text
http://localhost:9090
```

---

## 15. Failure Test Coverage

The live test suite is intentionally focused on meaningful systems behavior.

Run:

```bash
npm run test:failure
```

Current tests:

| Test | Scenario | Expected |
|---|---|---|
| 1 | Infinite loop | `TIMEOUT` |
| 2 | Fork bomb | contained by PID limit |
| 3 | Memory exhaustion | killed by memory limit |
| 4 | Infinite output | killed by stream cap |
| 5 | Worker crash | job requeued and completed |
| 6 | API/WebSocket regression | auth, replay, validation, output flags |

This suite proves the system handles both normal operation and important failure cases.

---

## 16. Design Tradeoffs

### Fresh container per job

Each job gets a new container.

Pros:

- strong isolation,
- no state leakage between jobs,
- simple cleanup model.

Cons:

- Docker startup adds latency.

### At-least-once execution

The queue design guarantees jobs are not lost during worker crashes, but a recovered job may run again.

The database result design handles this by writing results idempotently by `job_id`.

### Single Redis and Postgres in local demo

For a local SDE project, one Redis and one PostgreSQL container are enough.

A production deployment would add replication, backups, secret management, and stronger multi-node operations.

### Single-file submissions

The platform currently supports one code string per submission.

A future version could support multi-file projects by uploading a tar archive and unpacking it in the sandbox.

---

## 17. Why This Architecture Is Meaningful

This project demonstrates more than API routing.

It shows:

- safe execution of untrusted code,
- distributed workers,
- atomic Redis queue operations,
- crash recovery through heartbeats,
- Docker resource isolation,
- live WebSocket streaming,
- durable result persistence,
- metrics and dashboards,
- failure-oriented testing.

These are backend/platform engineering concepts that appear in real infrastructure systems.