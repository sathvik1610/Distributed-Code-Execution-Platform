# Distributed Code Execution Platform

A distributed backend platform for safely executing untrusted Python and JavaScript code inside isolated Docker sandboxes. The system accepts code through a REST API, queues execution work through Redis, runs jobs on horizontally scalable worker containers, streams stdout/stderr over WebSockets, stores results in PostgreSQL, and recovers jobs when workers crash.

This project is designed as a systems/backend engineering project: it demonstrates queues, workers, sandboxing, fault recovery, live streaming, observability, and failure testing.

---

## Table of Contents

- [Project Goal](#project-goal)
- [What This System Does](#what-this-system-does)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [How The System Works](#how-the-system-works)
- [Setup](#setup)
- [Running The Platform](#running-the-platform)
- [Using The API](#using-the-api)
- [Testing](#testing)
- [Observability](#observability)
- [Project Structure](#project-structure)
- [Why This Project Matters](#why-this-project-matters)

---

## Project Goal

The goal is to build the backend of a small online code execution engine, similar to the execution layer behind platforms like coding interview tools, online judges, or programming sandboxes.

The platform must be able to:

- accept user-submitted code,
- execute it safely,
- stream output live,
- save final results,
- handle dangerous programs,
- scale across multiple workers,
- recover jobs after worker crashes,
- expose useful operational metrics.

The important part is not just running code. The important part is running untrusted code safely and reliably.

---

## What This System Does

A user submits code like this:

```json
{
  "language": "python",
  "code": "print('hello from sandbox')"
}
```

The platform then:

1. validates the request,
2. stores the submission in PostgreSQL,
3. enqueues a job in Redis,
4. lets an execution worker claim the job,
5. runs the code in a locked-down Docker container,
6. streams stdout/stderr over WebSockets,
7. stores the final result in PostgreSQL,
8. recovers the job if the worker crashes,
9. exposes metrics through Prometheus and Grafana.

Supported languages:

- Python
- JavaScript

---

## Architecture

```text
Client
  |
  | REST / WebSocket
  v
API Gateway
  |  - validates requests and API key
  |  - writes submissions to PostgreSQL
  |  - pushes jobs into Redis
  |  - streams output to WebSocket clients
  |
  v
Redis
  |  - pending job queue
  |  - per-worker processing queues
  |  - live/replayable output streams
  |  - worker heartbeat keys
  |
  v
Execution Workers
  |  - atomically claim jobs
  |  - run Docker sandbox containers
  |  - publish stdout/stderr chunks
  |  - persist final results
  |
  v
Docker Sandbox Containers
  |  - no network
  |  - memory limit
  |  - process limit
  |  - CPU limit
  |  - read-only filesystem
  |  - non-root user

System Monitor
  |  - watches worker heartbeats
  |  - detects dead workers
  |  - requeues orphaned jobs
  |  - sends exhausted jobs to DLQ

PostgreSQL
  |  - durable submission metadata
  |  - execution results
  |  - status history

Prometheus + Grafana
  |  - metrics and dashboards
```

For a detailed architecture explanation, see [docs/architecture.md](docs/architecture.md).

---

## Technology Stack

| Area | Technology | Purpose |
|---|---|---|
| API server | Node.js, TypeScript, Fastify | HTTP API and WebSocket gateway |
| Queue and coordination | Redis | Job queue, processing queues, heartbeats, stream replay |
| Database | PostgreSQL | Durable submission and result storage |
| Sandboxing | Docker | Isolated execution environment for untrusted code |
| Worker runtime | Node.js, TypeScript | Distributed job execution workers |
| Monitoring service | Node.js, TypeScript | Dead-worker detection and job recovery |
| Metrics | Prometheus, prom-client | Service and job metrics |
| Dashboards | Grafana | Visual monitoring |
| Logging | Pino | Structured service logs |
| Load testing | k6 | Concurrent traffic tests |

---

## How The System Works

### 1. Submission

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

### 2. Queueing With Redis

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

### 3. Atomic Job Claim With BRPOPLPUSH

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

### 4. Worker Execution

Once a worker claims a job, it:

1. updates the database status to `RUNNING`,
2. starts a Docker sandbox container,
3. sends the user code into the container through stdin,
4. listens for stdout/stderr,
5. stores output chunks in Redis Streams,
6. publishes chunks live to WebSocket clients,
7. saves the final result in PostgreSQL,
8. removes the job from its processing queue.

### 5. Docker Sandbox

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

### 6. Live Output Streaming

When the sandbox prints output, the worker sends chunks to Redis.

The API Gateway forwards those chunks to WebSocket clients connected to:

```http
GET /stream/:jobId
```

The platform also stores recent chunks in Redis Streams, so a client that connects late can replay previous output and still receive the completion marker.

### 7. Result Persistence

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

### 8. Worker Heartbeats And Crash Recovery

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

### 9. Dead Letter Queue

The Dead Letter Queue stores jobs that failed too many infrastructure recovery attempts.

Redis key:

```text
jobs:queue:dead-letter
```

This prevents broken jobs from being retried forever.

---

## Setup

### Prerequisites

Install:

- Node.js 20+
- npm
- Docker
- Docker Compose
- WSL2 Ubuntu if running on Windows

On WSL/Linux, your user must be able to run Docker without `sudo`:

```bash
docker ps
```

If this fails with a permission error, add your user to the Docker group:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

On Windows, you may need to restart WSL after changing Docker permissions:

```powershell
wsl --shutdown
```

### Install Dependencies

```bash
npm ci
```

### Build TypeScript Packages

```bash
npm run build
```

### Build Runner Images

The execution workers expect these local Docker images:

```bash
npm run docker:build:runners
```

This creates:

```text
runner-python
runner-javascript
```

### Build Service Images

On a fresh machine, build the Docker Compose service images before starting the stack:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.services.yml build
```

---

## Running The Platform

### Start Everything

```bash
npm run start:all:scaled
```

This starts:

- PostgreSQL
- Redis
- Prometheus
- Grafana
- Docker Socket Proxy
- API Gateway
- System Monitor
- 3 Execution Workers

### Check Health

```bash
curl http://localhost:8000/health
```

Expected:

```json
{
  "status": "OK",
  "service": "api-gateway"
}
```

### Stop Everything

```bash
npm run stop:all
```

---

## Using The API

The default local API key in Docker Compose is:

```text
test-api-key
```

### Submit Python Code

```bash
curl -X POST http://localhost:8000/submissions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "language": "python",
    "code": "print([x * 2 for x in range(5)])"
  }'
```

Response:

```json
{
  "jobId": "uuid",
  "status": "PENDING"
}
```

### Fetch Result

```bash
curl -H "X-API-Key: test-api-key" \
  http://localhost:8000/submissions/<jobId>
```

### Run A Local File

```bash
node run-file.js sample.py
node run-file.js sample.js
```

### WebSocket Stream

Connect to:

```text
ws://localhost:8000/stream/<jobId>
```

The WebSocket must include:

```text
X-API-Key: test-api-key
```

---

## API Reference

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/health` | Health check | No |
| `POST` | `/submissions` | Submit code | Yes |
| `GET` | `/submissions/:id` | Fetch one result | Yes |
| `GET` | `/submissions?page=1&limit=10&status=COMPLETED` | List submissions | Yes |
| `GET` | `/stream/:jobId` | WebSocket output stream | Yes |
| `GET` | `/dlq` | Inspect dead-letter jobs | Yes |
| `DELETE` | `/dlq/:jobId` | Remove a dead-letter job | Yes |

---

## Testing

### Type Check

```bash
npm run typecheck
```

### Failure And Regression Suite

```bash
npm run test:failure
```

The suite validates:

1. infinite loop timeout,
2. fork bomb containment,
3. memory exhaustion containment,
4. infinite output stream cap,
5. worker crash recovery,
6. API/WebSocket regressions.

Expected summary:

```text
PASSED: 6
FAILED: 0
```

### What The Tests Prove

| Test | What It Proves |
|---|---|
| Infinite loop | Worker timeout kills runaway CPU loops |
| Fork bomb | Docker PID limit prevents process exhaustion |
| OOM attack | Docker memory limit kills memory abuse |
| Infinite output | Output cap prevents stream/memory blowup |
| Worker crash | Heartbeat monitor recovers orphaned jobs |
| API/WebSocket regression | Auth, replay, validation, output flags work |

---

## Observability

### Prometheus

```text
http://localhost:9090
```

Prometheus scrapes:

- API Gateway metrics on `:9100`
- Execution Worker metrics on `:9101`
- System Monitor metrics on `:9102`

### Grafana

```text
http://localhost:3000
```

Default login:

```text
admin / admin
```

Grafana includes dashboards for:

- queue depth,
- job throughput,
- execution duration,
- WebSocket activity,
- DLQ count,
- worker recovery events,
- rate-limit hits.

---

## Project Structure

```text
.
├── infra/
│   ├── docker-compose.yml              # Postgres, Redis, Prometheus, Grafana
│   ├── docker-compose.services.yml     # API, workers, monitor, Docker proxy
│   ├── schema.sql                      # PostgreSQL schema
│   └── prometheus.yml                  # Prometheus scrape config
│
├── runners/
│   ├── python/                         # Python sandbox image
│   └── javascript/                     # JavaScript sandbox image
│
├── services/
│   ├── api-gateway/                    # Fastify REST/WebSocket API
│   ├── execution-worker/               # Redis worker + Docker sandbox runner
│   └── system-monitor/                 # Heartbeat scanner + orphan reaper
│
├── shared/
│   ├── contracts/                      # Shared types, statuses, queue keys, constants
│   ├── logger/                         # Pino logger
│   └── metrics/                        # Prometheus metrics
│
├── tests/failure/                      # Live failure and regression tests
├── run-file.js                         # Submit and stream a local file
├── test-ws.js                          # WebSocket demo client
├── benchmark.js                        # Benchmark helper
└── load-test.js                        # Load test helper
```

---

## Why This Project Matters

This project is meaningful because it combines several real backend engineering ideas in one system:

- distributed workers,
- atomic queue operations,
- crash recovery,
- sandboxed execution,
- resource isolation,
- WebSocket streaming,
- durable result storage,
- observability,
- failure testing.

It is intentionally more advanced than a CRUD application. It demonstrates practical systems engineering: what happens when a worker dies, when code prints forever, when memory explodes, when a process fork-bombs, or when a client connects late to a stream.

---

## Current Limitations

This is a local/demo-scale platform, not a production service. Important future improvements would include:

- per-user authorization instead of a single API key,
- stronger secret management,
- digest-pinned base images,
- multi-file submission support,
- Redis high availability,
- PostgreSQL retention/archival policy,
- more advanced worker metrics discovery when scaling across many hosts.

---

## Useful Commands

```bash
npm ci                         # install dependencies
npm run build                  # build all TypeScript packages
npm run typecheck              # run TypeScript checks
npm run docker:build:runners   # build sandbox runner images
npm run start:all:scaled       # start full stack with 3 workers
npm run test:failure           # run live failure/regression tests
npm run stop:all               # stop all services
```
