# Architecture — Distributed Code Execution Platform

## Overview

This platform is a backend infrastructure system that securely executes untrusted user-submitted code inside isolated Docker sandboxes using distributed workers, Redis-based job queues, real-time WebSocket streaming, and fault recovery systems.

Think: mini LeetCode execution engine backend.

---

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                        Client (HTTP/WS)                      │
└───────────────────────────┬─────────────────────────────────┘
                            │  REST  /  WebSocket
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      API Gateway :8000                       │
│  • Fastify HTTP server                                       │
│  • Input validation (JSON schema)                            │
│  • Submission creation (PostgreSQL INSERT)                   │
│  • Redis enqueue (LPUSH)                                     │
│  • WebSocket -> Redis pub/sub bridge                         │
│  • Prometheus metrics :9100                                  │
└────────────┬───────────────────────┬────────────────────────┘
             │ LPUSH                 │ SUBSCRIBE
             ▼                       ▼
┌─────────────────────────┐  ┌───────────────────────────────┐
│  Redis (Queue + PubSub) │  │  Redis Pub/Sub                │
│                         │  │  jobs:streams:{jobId}         │
│  jobs:queue:pending     │  │  (stdout/stderr chunks)       │
│  jobs:queue:processing  │  └───────────────────────────────┘
│    :{workerId}          │              ▲
│  jobs:queue:dead-letter │              │ PUBLISH
│  worker:heartbeat:*     │  ┌───────────┴───────────────────┐
└────────────┬────────────┘  │      Execution Worker          │
             │ BRPOPLPUSH    │                               │
             ▼               │  • BRPOPLPUSH (atomic dequeue) │
┌─────────────────────────┐  │  • Heartbeat (5s, TTL 15s)   │
│    Execution Worker     │  │  • Docker sandbox spawn        │
│      (1..N workers)     │  │  • stdout/stderr publish       │
│                         │  │  • DB result write             │
│  :9101 (metrics)        │  │  • Retry with backoff          │
└────────────┬────────────┘  │  • DLQ routing                 │
             │               │  • :9101 (metrics)             │
             ▼               └───────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                        PostgreSQL                            │
│  • submissions table (status state machine)                  │
│  • submission_results table (idempotent, UNIQUE job_id)      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│               System Monitor / Reaper :9102                  │
│                                                             │
│  • Scans worker:heartbeat:* keys every 10s                  │
│  • Detects dead workers (missing heartbeat)                 │
│  • Reads jobs:queue:processing:{deadWorker}                 │
│  • Re-enqueues orphans OR sends to DLQ                      │
│  • Prometheus metrics :9102                                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              Observability Stack                             │
│  Prometheus :9090  ←  scrapes gateway, worker, monitor      │
│  Grafana     :3000  ←  dashboards (auto-provisioned)        │
└─────────────────────────────────────────────────────────────┘
```

---

## Submission Lifecycle (State Machine)

```
Client
  → POST /submissions
  → DB INSERT status=PENDING
  → Redis LPUSH jobs:queue:pending
  → Worker BRPOPLPUSH → jobs:queue:processing:{workerId}
  → DB UPDATE status=RUNNING
  → Docker sandbox spawn
  → stdout/stderr → Redis PUBLISH jobs:streams:{jobId}
  → WebSocket clients receive live stream
  → Container exits
  → DB INSERT submission_results (ON CONFLICT DO NOTHING)
  → DB UPDATE status=COMPLETED|FAILED|TIMEOUT
  → Redis LREM (remove from processing queue)
```

### Allowed State Transitions

```
PENDING  →  RUNNING
RUNNING  →  COMPLETED | FAILED | TIMEOUT
```

Transitions are coordinated at the database level by comparing states (e.g. status comparison guards), ensuring only valid status progressions are saved.

---

## Queue Architecture

| Queue Key | Purpose |
|---|---|
| `jobs:queue:pending` | All waiting jobs |
| `jobs:queue:processing:{workerId}` | Jobs owned by a specific worker |
| `jobs:queue:dead-letter` | Permanently failed jobs (exceeded retries) |

### BRPOPLPUSH — Why This Matters

The atomic `BRPOPLPUSH` (or `BLMOVE`) command moves a job from `pending` to `processing:{workerId}` in a single atomic Redis operation.

This means:
- If the worker crashes **before** completing the job, the job is still in `processing:{workerId}`
- The System Monitor can detect the dead worker's heartbeat expiry
- The job can be recovered and re-enqueued, without losing the job; duplicate results are guarded by idempotent inserts

---

## Sandbox Security

Each code submission runs inside a Docker container with these mandatory restrictions:

| Flag | Value | Purpose |
|---|---|---|
| `--network` | `none` | Prevents all outbound network access |
| `--memory` | `128m` | Hard memory limit |
| `--memory-swap` | `128m` | Prevents swap usage (= disable swap) |
| `--pids-limit` | `50` | Prevents fork bombs |
| `--read-only` | — | Filesystem is read-only |
| `--user` | `runner` | Non-root execution |
| `--tmpfs /tmp` | — | Writable temp directory only |
| `--rm` | — | Auto-removes container on exit |

### Host Socket Protection (Security Proxy)

Rather than mounting the raw Unix socket `/var/run/docker.sock` in the execution workers—which creates a sibling-container container escape privilege escalation vulnerability—the workers communicate with a secure, unprivileged **Docker Socket Proxy** (`tecnativa/docker-socket-proxy`) over a restricted internal TCP network (`DOCKER_HOST="tcp://docker-proxy:2375"`).

The proxy exposes only the necessary endpoints (`POST /containers/create`, `POST /containers/start`, `POST /containers/kill`, `POST /containers/wait`) and blocks all other management operations (volumes, host network binds, image deletions, etc.).

### Accurate Memory Metrics via Linux Cgroups

Instead of using race-prone `docker stats` polling which frequently returns `null` for fast-running ephemeral containers, sandbox containers run under an unprivileged wrapper script (`runner-wrapper.sh`) which retrieves peak execution memory directly from the Linux kernel Cgroup interface:
- **Cgroup v2:** `/sys/fs/cgroup/memory.peak`
- **Cgroup v1:** `/sys/fs/cgroup/memory/memory.max_usage_in_bytes`

The metric is printed inside the stream as a token (`___MEM_PEAK___: <bytes>`), which is intercepted, parsed, and cleanly stripped by the worker before the client websocket fans out.

### Stdin Code Piping (Decoupled RAM Execution)

Rather than writing code files to the host disk (polluting `/temp` directories) and mounting them into sandboxes via local volume mounts—which couples the worker process to the same host VM as the Docker daemon—the platform streams the code string directly to the container over **standard input (stdin)** in interactive mode (`-i`).

The unprivileged wrapper script `runner-wrapper.sh` inside the container intercepts the code stream on `stdin`, writes it into `/tmp` (which is configured as an isolated, memory-backed `--tmpfs /tmp:rw,size=32m,mode=1777`), and executes it. This:
- **Enables True Distributed Scaling:** Decouples the worker entirely from the host VM. Workers can run on separate machines and talk to the Docker daemon over the TCP proxy.
- **Eliminates Disk I/O Overhead:** No files hit physical SSD/HDD writes. Execution is entirely RAM-bound.
- **Hardens Security:** Zero file trace is left on the host system.

---

## Heartbeat System

```
Worker publishes:  worker:heartbeat:{workerId}  TTL=15s  every 5s
```

- If a worker crashes, its heartbeat key expires within 15 seconds
- System Monitor scans all `worker:heartbeat:*` keys every 10 seconds
- Any `jobs:queue:processing:{workerId}` without a matching heartbeat = dead worker

---

## Idempotency Strategy

**Problem**: Worker crashes after writing the DB result but before removing the job from the processing queue. On recovery, the job is retried, causing a potential duplicate write.

**Solution**:

```sql
INSERT INTO submission_results (job_id, ...)
VALUES (...)
ON CONFLICT (job_id) DO NOTHING;
```

The `UNIQUE(job_id)` constraint on `submission_results` means the second write is silently ignored. The final `UPDATE submissions SET status=...` is also idempotent.

---

## Retry Strategy

| Retry | Delay Before Requeue |
|---|---|
| 1st retry | 2 seconds |
| 2nd retry | 4 seconds |
| 3rd retry | 8 seconds |
| > 3 retries | → Dead Letter Queue |

---

## Technology Stack

| Component | Technology | Why |
|---|---|---|
| Backend | Node.js + TypeScript | Async-friendly, productive |
| HTTP Framework | Fastify | Lower overhead than Express |
| Queue | Redis (ioredis) | Atomic operations, pub/sub |
| Database | PostgreSQL | ACID transactions, UNIQUE constraints |
| Sandboxing | Docker | Process isolation, resource limits |
| Logging | Pino | Structured JSON logging |
| Metrics | Prometheus + prom-client | Industry-standard observability |
| Dashboards | Grafana | Pre-built, provisioned dashboards |
| Load Testing | k6 | Scripted concurrency scenarios |
