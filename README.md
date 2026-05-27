# Distributed Code Execution Platform

[![CI](https://github.com/sathvik-pilyanam/Distributed-Code-Execution-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/sathvik-pilyanam/Distributed-Code-Execution-Platform/actions/workflows/ci.yml)

A queue-based multi-worker code execution system built with **Node.js**, **TypeScript**, **Redis**, **PostgreSQL**, and **Docker**. Accepts code submissions via HTTP, executes them in isolated containers with Docker runtime restrictions suitable for a learning prototype, streams real-time output over WebSockets, and recovers from worker crashes automatically.

---

## Architecture

```
Client
  │
  │  POST /submissions  (X-API-Key required, rate-limited)
  ▼
┌─────────────────────────────────┐
│           API Gateway            │  :8000 HTTP + WebSocket
│    Fastify • Rate-limited        │  :9100 Prometheus
│    Auth • Input validation       │
└──────────────┬──────────────────┘
               │  LPUSH → jobs:queue:pending
               ▼
┌─────────────────────────────────┐
│              Redis               │  :6379
│    Queue • Pub/Sub • Heartbeats  │
└──────────────┬──────────────────┘
               │  BRPOPLPUSH → jobs:queue:processing:<workerId>
               ▼
┌─────────────────────────────────┐   ×N  (stateless, run as many as needed)
│       Execution Worker(s)        │  :9101 Prometheus
│    Docker spawner • Heartbeat    │
└──────────────┬──────────────────┘
               │  docker run --rm --network none --cap-drop ALL ...
               ▼
┌─────────────────────────────────┐
│       Sandbox Container          │
│   runner-python / runner-js      │
└──────────────┬──────────────────┘
               │  stdout/stderr → Redis Pub/Sub: jobs:streams:<jobId>
               │  ◄── API Gateway global subscriber fans out to clients
               ▼
         PostgreSQL :5432  (PostgreSQL-backed submission state and transactional result writes)

┌─────────────────────────────────┐
│        System Monitor            │  :9102 Prometheus
│  Reaper scan every 10s           │
│  Dead worker detection           │
│  Orphan job recovery + DLQ       │
└─────────────────────────────────┘
```

---

## Key Engineering Decisions

| Decision | Rationale |
|---|---|
| **`BRPOPLPUSH`** instead of BLPOP | Jobs land in a per-worker processing queue atomically. If the worker dies, the System Monitor reads the queue and recovers the job. BLPOP would lose it. |
| **`BEGIN/COMMIT`** wrapping results + status | Prevents split-brain: without a transaction, a crash between the two writes leaves `submissions.status = RUNNING` forever while `submission_results` already has output. |
| **`ON CONFLICT DO NOTHING`** on result insert | Idempotency: if a worker crashes after writing results but before removing the job from its queue, a retry may re-execute the job; duplicate result rows are ignored. |
| **Shared Redis Subscriber with Pattern Subscription** | Avoids creating a new Redis subscriber client per WebSocket connection. A single global Redis subscriber subscribes to `jobs:streams:*` on boot to prevent file descriptor exhaustion under high connection loads. |
| **`child_process.spawn`** not exec | exec buffers all output in memory. spawn streams chunks — required for real-time output and to avoid OOM on large outputs. |
| **Shared WebSocket Streams Map (`activeStreams`)** | The global subscriber intercepting message events uses an in-memory `activeStreams` map (`Map<string, Set<WebSocket>>`) to fan out messages directly to the correct client WebSockets. |
| **Heartbeat TTL = 15s, refreshed every 5s** | Three missed heartbeats before a worker is declared dead. Prevents false positives from network blips while detecting real crashes within 15 seconds. |
| **Static `X-API-Key` auth** | JWT adds token refresh/signing complexity unrelated to this system's core value. A static key proves the auth concept cleanly. |
| **`EXECUTION_COMPLETE` pub/sub signal** | Worker publishes a system chunk after the DB commit. The gateway uses this to close the WebSocket cleanly, preventing clients from hanging indefinitely. |
| **Reaper DB Guard status pre-check** | Prevents double execution: If a worker crashed AFTER transactionally committing results to the database but BEFORE clearing it from its processing queue, the reaper status check skips requeuing the job since the DB already shows it as COMPLETED or FAILED. |

---

## Security Sandbox

Every submission runs in a Docker container with these runtime constraints:

| Flag | Protects Against |
|---|---|
| `--network none` | Data exfiltration, outbound requests |
| `--memory 128m --memory-swap 128m` | RAM exhaustion / OOM attacks |
| `--pids-limit 50` | Fork bombs (`os.fork()` loops) |
| `--read-only` | Filesystem tampering |
| `--tmpfs /tmp:rw,size=32m` | Unlimited tmpfs growth (capped at 32 MB) |
| `--cap-drop ALL` | All Linux capabilities removed |
| `--security-opt no-new-privileges` | Prevents setuid binary escalation |
| `--user runner` | No root access inside the container |
| 1 MB pub/sub output cap | Infinite-output attacks flooding Redis |

---

## Error Classification

The `errorCategory` field in `GET /submissions/:id` breaks down `FAILED` into actionable categories:

| Category | Condition |
|---|---|
| `SYNTAX_ERROR` | stderr contains `SyntaxError`, `IndentationError`, etc. |
| `RUNTIME_ERROR` | Non-zero exit for other reasons |
| `OOM` | Exit code 137 without a timeout signal |
| `TIMEOUT` | Killed by the 5-second execution timer |
| `WORKER_CRASH` | Job recovered from a dead worker (DLQ path) |
| `UNKNOWN` | Catch-all for undefined errors |

---

## Observability

Each service exposes a Prometheus `/metrics` endpoint:

| Service | Port | Key Metrics |
|---|---|---|
| API Gateway | `:9100` | `code_execution_queue_depth`, `code_execution_websocket_connections_active`, `code_execution_rate_limit_hits_total` |
| Execution Worker | `:9101` | `code_execution_active_workers`, `code_execution_duration_ms` (histogram by language+status), `code_execution_worker_jobs_total` |
| System Monitor | `:9102` | `code_execution_dead_worker_recoveries_total`, `code_execution_dead_letter_jobs_total` |

Grafana dashboards are pre-provisioned at **http://localhost:3000** (admin/admin).

> **Distributed tracing:** OpenTelemetry across 3 services is not implemented. Correlation IDs via `jobId` (present in every log line) are the current span boundary.

---

## Known Limitations & Production Roadmap

These are intentional tradeoffs, not unknown bugs:

| Limitation | Production Fix |
|---|---|
| Docker boot latency (100–300ms/job) | Firecracker MicroVMs or pre-warmed container pools |
| **Redis is a single node** | Redis Sentinel or ElastiCache with AOF persistence. If Redis goes down, the queue, pub/sub, and heartbeats all fail simultaneously. Worker reconnection logic is in place, but in-memory queue state is lost — any pending jobs not yet persisted to Postgres must be re-submitted. |
| Shared host kernel | gVisor or Kata Containers for hardware-level isolation |
| No distributed tracing | OpenTelemetry across gateway → worker → DB |
| No Grafana alerting rules | Alertmanager with on-call pages for DLQ spikes and p99 latency thresholds |

---

## Setup & Running

### Prerequisites
- Docker & Docker Compose
- Node.js v20+
- Linux / macOS / WSL2 on Windows

---

### Option A — Quick Start (single command)

```bash
# 1. Install dependencies
npm ci

# 2. Build shared packages and all services
npm run build:shared && npm run build

# 3. Build sandbox runner images
npm run docker:build:runners

# 4. Configure API Key & Start everything (infra + all 3 services)
export API_KEY=test-api-key
npm run start:all

# To run 3 parallel workers (demonstrates horizontal scaling):
npm run start:all:scaled

# Stop everything
npm run stop:all
```

---

### Option B — Development (3 terminals, with hot-reload)

```bash
# Terminal 0: infrastructure only
npm run infra:up

# Terminal 1
npm run dev:gateway

# Terminal 2 (needs Docker access — see note below)
npm run dev:worker

# Terminal 3
npm run dev:monitor
```

**Docker access note:** The worker spawns Docker containers. Instead of `sudo npm start`, add your user to the `docker` group:

```bash
sudo usermod -aG docker $USER
# Log out and back in for the change to take effect
```

> ⚠️ Being in the `docker` group is functionally equivalent to root on the host — a container can mount `/` and modify host files. In production, use rootless Docker or a dedicated Docker daemon.

---

## API Reference

### Submit Code
```
POST /submissions
X-API-Key: <your-key>
Content-Type: application/json

{ "code": "print('hello')", "language": "python", "userId": "optional" }
```
- `code` max: **64 KB**
- Languages: `python`, `javascript`
- Returns: `{ jobId, status: "PENDING" }`

### Stream Real-Time Output
```
WS ws://localhost:8000/stream/<jobId>
```
Receives `StreamChunk` messages. Connection closes automatically on `EXECUTION_COMPLETE`:
```json
{"type":"stdout","data":"hello\n","timestamp":1779363738000}
{"type":"system","data":"EXECUTION_COMPLETE","timestamp":1779363740000}
```

### Get Submission Result
```
GET /submissions/<jobId>
X-API-Key: <your-key>
```
Returns full result including `errorCategory`, `memoryUsedBytes` (collected via peak `docker stats` sampling; may return `null` for extremely fast/ephemeral executions), and `executionTimeMs`.

### List Submissions
```
GET /submissions?status=COMPLETED&page=1&limit=10
X-API-Key: <your-key>
```

### Inspect Dead Letter Queue
```
GET  /dlq?page=1&limit=20
DELETE /dlq/<jobId>
X-API-Key: <your-key>
```

### Health Check
```
GET /health
```

---

## Testing & E2E Verification Guide

The entire platform can be easily built, run, and verified from a completely clean state. Follow these step-by-step instructions:

### 1. Prerequisites & Setup
Ensure dependencies are installed and runner sandboxes are built:
```bash
# Install workspace packages
npm ci

# Compile shared libraries & microservices
npm run build:shared && npm run build

# Build sandbox runner images
npm run docker:build:runners
```

### 2. Start the Platform
Launch all microservices, databases, and monitoring stack in the background:
```bash
npm run start:all
```

---

### 3. Verification Scenario 1: Real-Time WebSocket Streaming & Custom CLI Execution

#### A. Basic Streaming Test
Submit a long-running python script and watch standard output stream back to the client in real-time, exactly 1 second apart, with a clean connection closure:
```bash
export API_KEY=test-api-key
node test-ws.js
```

**Expected Output:**
```
Submitted job. ID: <job-id>
Connecting to WebSocket: ws://localhost:8000/stream/<job-id>
WS Connection opened successfully
[WS Stream Chunk] Type: stdout, Data: Chunk 1: Starting computation..., Time: ...
[WS Stream Chunk] Type: stdout, Data: Chunk 2: Middle of execution..., Time: ...
[WS Stream Chunk] Type: stdout, Data: Chunk 3: Execution finished., Time: ...
[WS Stream Chunk] Type: system, Data: EXECUTION_COMPLETE, Time: ...
WS Connection closed. Code: 1000, Reason: Execution complete
```

#### B. Dynamic CLI File Execution
You can also run **any custom Python or JavaScript file** from your local filesystem through the platform's sandboxes using our dynamic CLI wrapper `run-file.js` (which auto-detects language based on extension):

```bash
export API_KEY=test-api-key

# Run a Python script
node run-file.js sample.py

# Run a JavaScript script
node run-file.js sample.js
```

---

### 4. Verification Scenario 2: Automated Failure Containment
Verify that the sandboxes contain malicious behavior (Infinite Loops, Fork Bombs, Out of Memory triggers, and Infinite Output attacks) successfully:
```bash
export API_KEY=test-api-key
npm run test:failure
```
**Expected Results:**
- **Test 1 (Infinite Loop):** Safely killed (Status: `TIMEOUT` in ~5s).
- **Test 2 (Fork Bomb):** Contained by process limit limits (Status: `FAILED`, Exit Code `1`).
- **Test 3 (OOM Attack):** Contained by memory hard limits (Status: `FAILED`, Exit Code `137` / `OOM`).
- **Test 4 (Infinite Output):** Throttled and ended by 1 MB output cap (Status: `FAILED`).

---

### 5. Verification Scenario 3: Manual Worker Crash & Resiliency Recovery
This manual scenario tests the fault tolerance of the **System Monitor** and its ability to recover orphaned jobs when worker processes crash:

1. **Terminal A (Watcher):** Watch the System Monitor logs:
   ```bash
   docker logs -f execution_system_monitor
   ```
2. **Terminal B (Runner):** Submit a long-running computation:
   ```bash
   node test-ws.js
   ```
3. **Trigger Crash (Terminal B):** Immediately kill the execution worker container mid-computation:
   ```bash
   docker kill infra-execution-worker-1
   ```
4. **Observe Recovery (Terminal A):** Within 10 seconds, you will see the System Monitor log:
   ```json
   {"level":40,"msg":"Dead workers detected!"}
   {"level":30,"msg":"Found 1 orphan job(s) to recover"}
   {"level":30,"msg":"Orphan job recovered — requeued (attempt 1 of 3)"}
   ```
5. **Resume Job (Terminal B):** Restart the worker container:
   ```bash
   docker compose -f infra/docker-compose.yml -f infra/docker-compose.services.yml start execution-worker
   ```
6. **Verify (Terminal B):** Check Postgres to confirm the job was safely resumed and finished as `COMPLETED`:
   ```bash
   docker exec execution_postgres psql -U postgres -d code_execution -c "SELECT id, status, retry_count FROM submissions;"
   ```

---

## Observability Dashboard

Navigate to **`http://localhost:3000`** in your browser to view Grafana.
- **Credentials:** `admin` / `admin`
- Under **Dashboards**, open the pre-loaded **Distributed Code Execution Platform** dashboard to view real-time API latency percentiles, worker CPU usage, execution error rates, and queue depth metrics. Memory metrics are best-effort (sampled via `docker stats`; may be absent for very short-lived containers).

---

## Horizontal Scaling

Workers keep no durable local state; they depend on Redis/Postgres/Docker socket. To simulate and run multiple workers in parallel:
```bash
# Spin up 3 parallel workers running concurrently
npm run start:all:scaled
```
The System Monitor reaper automatically scales and handles heartbeat/dead-worker detection across all active instances.

---

## Known Architectural Tradeoffs & Production Path

This system is built as a **production-style learning prototype**. It prioritizes operational transparency, ease of demo, and idiomatic distributed patterns over complex cloud infrastructure. In a real-world enterprise system, the following limitations would be addressed:

### 1. At-Least-Once Delivery vs. Exactly-Once
- **The Limit:** Because Redis and PostgreSQL are heterogeneous datastores, they do not share an atomic transaction boundary. A worker crash after writing execution results but before removing a job from the processing queue will cause a retry.
- **Our Defense:** The system relies on **at-least-once delivery**. Duplicate executions are made safe via **idempotent database result writes** (`ON CONFLICT DO NOTHING`) and **Reaper DB status pre-checks** that skip recovering jobs already marked as complete in Postgres.
- **Production Path:** Implement a **Transactional Outbox Pattern** or a **DB-to-Queue reconciler** to guarantee strict eventual consistency.

### 2. Redis-Backed Rate Limiting
- **Implemented:** The rate limiter uses Redis as a shared counter store (`@fastify/rate-limit` with an ioredis client). Limits are enforced correctly across multiple gateway instances — each request increments an atomic Redis counter with a 1-minute TTL.
- **Remaining gap:** The counter uses a fixed window (not sliding window). A client can send 30 requests at second 59 and 30 more at second 61 for a burst of 60 in 2 seconds. A sliding window (Redis sorted sets) eliminates this but is not implemented.

### 3. Docker Socket Security & Sibling Containers
- **The Limit:** The worker mounts `/var/run/docker.sock` to spawn sandboxes. This grants the worker root-equivalent privileges on the host system. Furthermore, local directory mounts restrict the worker pool to a single host VM.
- **Production Path:** Replace the local Docker spawner with a container orchestration API (e.g. AWS ECS Fargate or Kubernetes Job APIs) or VMs microvisors like **AWS Firecracker** to ensure strict sandbox-to-host isolation.

### 4. Cold-Start Sandbox Latency
- **The Limit:** Creating a brand new container (`docker run --rm`) from scratch for every execution adds 200ms–500ms of startup latency.
- **Production Path:** Implement a **pre-warmed container pool** that keeps runner instances running in a paused state, resuming them instantly (<5ms) when a job arrives.

### 5. Best-Effort Peak Memory Collection
- **The Limit:** Sandboxes are ephemeral. We poll `docker stats` immediately after execution ends to read peak memory usage, but extremely fast/short executions can terminate before a metrics tick, returning `null`.
- **Production Path:** Read cgroup memory allocation statistics directly from `/sys/fs/cgroup/memory` or run containers under a lightweight daemon that reports precise runtime telemetry.

### 6. WebSocket Streaming Limitations
- **Live-only:** `/stream/:jobId` streams output in real time using Redis pub/sub. Clients that connect after execution completes receive no output — there is no replay buffer. Connect before or during execution.
- **Unauthenticated by design:** The stream endpoint does not require `X-API-Key`. Job IDs are random UUIDs so enumeration is infeasible, but anyone who obtains a job ID can watch its output stream. In production, short-lived signed tokens (HMAC of jobId) should gate access.
