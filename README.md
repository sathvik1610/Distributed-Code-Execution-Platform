# Distributed Code Execution Platform

[![CI](https://github.com/sathvik-pilyanam/Distributed-Code-Execution-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/sathvik-pilyanam/Distributed-Code-Execution-Platform/actions/workflows/ci.yml)

A distributed, sandboxed code execution system built with **Node.js**, **TypeScript**, **Redis**, **PostgreSQL**, and **Docker**. Accepts code submissions via HTTP, executes them in isolated containers with strict security policies, streams real-time output over WebSockets, and recovers from worker crashes automatically.

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
         PostgreSQL :5432  (ACID state machine + results)

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
| **`ON CONFLICT DO NOTHING`** on result insert | Idempotency: if a worker crashes after writing results but before removing the job from its queue, a retry re-executes the insert safely. |
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
| **Redis is a single node** | Redis Sentinel or ElastiCache with AOF persistence. If Redis goes down, the queue, pub/sub, and heartbeats all fail simultaneously. Worker reconnection logic is in place; the queue recovers once Redis is back. |
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

# 4. Start everything (infra + all 3 services)
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
Returns full result including `errorCategory`, `memoryUsedBytes`, `executionTimeMs`.

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

## Testing

### End-to-End Stream Test
```bash
node test-ws.js
```

### Failure & Security Tests
```bash
npm run test:failure
```

| Test | Attack | Expected |
|---|---|---|
| `01-infinite-loop.py` | `while True: pass` | `TIMEOUT` after 5s |
| `02-fork-bomb.py` | `os.fork()` loop | Killed by `--pids-limit 50` |
| `03-oom-attack.py` | Grow list to exhaust RAM | Exit 137, `errorCategory: OOM` |
| `04-infinite-output.py` | `while True: print(...)` | Killed after 1 MB output cap |
| `05-worker-crash.py` | Kill worker mid-execution | Reaper recovers and requeues |

### Load Testing
```bash
k6 run infra/k6-load-test.js
```

---

## Horizontal Scaling

Workers are stateless — each instance generates a unique `workerId` UUID at startup and maintains its own heartbeat key and processing queue. Add capacity by running more instances:

```bash
# docker compose: 3 parallel workers
npm run start:all:scaled

# Development: open more terminals running:
npm run dev:worker
```

The System Monitor's reaper handles all worker instances automatically — it scans `worker:heartbeat:*` and `jobs:queue:processing:*` keys regardless of how many workers are running.
