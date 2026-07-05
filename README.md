# Distributed Code Execution Platform

A distributed backend platform for safely executing untrusted Python and JavaScript code inside isolated Docker sandboxes. The system accepts code through a REST API, queues execution work through Redis, runs jobs on horizontally scalable worker containers, streams stdout/stderr over WebSockets, stores results in PostgreSQL, and recovers jobs when workers crash.

Built as a systems/backend engineering project — queues, workers, sandboxing, fault recovery, live streaming, observability, and failure testing, not just "run some code."

---

## Table of Contents

- [Quick Start](#quick-start)
- [What This System Does](#what-this-system-does)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Benchmark](#benchmark)
- [Project Structure](#project-structure)
- [Current Limitations](#current-limitations)
- [Further Reading](#further-reading)

---

## Quick Start

**Prerequisites:** Node.js 20+, Docker + Docker Compose. On Windows, run Docker Desktop with the WSL2 backend.

If `docker ps` fails with a permission error on WSL/Linux: `sudo usermod -aG docker $USER && newgrp docker` (then `wsl --shutdown` on Windows and reopen).

### 1. Install

```bash
git clone https://github.com/sathvik1610/Distributed-Code-Execution-Platform.git
cd Distributed-Code-Execution-Platform
npm ci                          # installs every workspace: services, shared packages, and the web UI
```

### 2. Build

```bash
npm run build                                                                          # compiles all TypeScript packages + services + the web UI
npm run docker:build:runners                                                           # builds the Python/JavaScript sandbox images
docker compose -f infra/docker-compose.yml -f infra/docker-compose.services.yml build  # builds the service container images
```

### 3. Start the backend

```bash
npm run start:all:scaled            # Postgres, Redis, API Gateway, System Monitor, 3 execution workers
curl http://localhost:8000/health   # sanity check → {"status":"OK","service":"api-gateway",...}
```

### 4. Start the web UI

With the backend still running from step 3, in a **new terminal**:

```bash
npm run dev:web   # starts the Vite dev server
```

Open **http://localhost:5173** — Monaco code editor, language selector, live streamed output, status progression, execution metrics, and job history. No `.env` needed: the dev server proxies API calls to the backend and injects the API key server-side, so it never reaches the browser.

### 5. Test it

```bash
npm run typecheck    # TypeScript compiler check only — no build output, just verifies there are no type errors across services/shared
npm run test:failure # live adversarial suite against the running backend from step 3:
                      #   infinite loop -> timeout, fork bomb -> pids-limit kill, OOM -> memory-limit kill,
                      #   infinite output -> stream cap, worker crash -> reaper recovery, API/WebSocket regressions
                      # expects: PASSED: 6, FAILED: 0
```

`test:failure` needs the backend from step 3 already running — it submits real jobs and checks how the live system reacts, it isn't a mocked unit-test suite. Full breakdown of what each test proves: [docs/testing.md](docs/testing.md).

### Stopping / cleanup

```bash
npm run stop:all   # stops and removes all backend containers (Postgres, Redis, API Gateway, workers, monitor)
# Ctrl+C in the dev:web terminal to stop the web UI
```

---

## What This System Does

```json
POST /submissions
{ "language": "python", "code": "print('hello from sandbox')" }
```

The platform validates the request, stores it in PostgreSQL, enqueues it in Redis, runs it in a locked-down Docker container, streams stdout/stderr live over WebSocket, persists the result, recovers the job if its worker crashes, and exposes metrics via Prometheus/Grafana.

Supported languages: **Python**, **JavaScript**.

---

## Architecture

```text
Client
  |  REST / WebSocket
  v
API Gateway  →  validates, writes to PostgreSQL, pushes to Redis, streams output
  v
Redis  →  pending queue, per-worker processing queues, output streams, heartbeats
  v
Execution Workers  →  claim jobs, run Docker sandboxes, publish output, persist results
  v
Docker Sandbox  →  no network, memory/CPU/pid limits, read-only fs, non-root user

System Monitor  →  watches heartbeats, detects dead workers, requeues orphaned jobs
PostgreSQL      →  durable submissions, results, status history
Prometheus/Grafana → metrics and dashboards
```

Full request-flow diagrams: [docs/architecture.md](docs/architecture.md) and [docs/architecture-diagram.md](docs/architecture-diagram.md). Step-by-step lifecycle walkthrough: [docs/how-it-works.md](docs/how-it-works.md).

---

## Technology Stack

| Area | Technology |
|---|---|
| API server | Node.js, TypeScript, Fastify |
| Frontend | React, TypeScript, Vite, Monaco Editor |
| Queue and coordination | Redis (BRPOPLPUSH, Streams, Pub/Sub) |
| Database | PostgreSQL |
| Sandboxing | Docker |
| Metrics / Dashboards | Prometheus, Grafana |
| Logging | Pino |
| Load testing | k6 |

---

## Benchmark

~4.3 jobs/sec sustained throughput, p95 latency 925ms over 500 jobs. Docker container spawn is **~83% of total execution time** — the throughput ceiling is the Docker daemon's spawn rate, not application logic. 100% crash-recovery success rate (a real race condition was found and fixed along the way — see [docs/reliability.md](docs/reliability.md)).

```bash
node benchmark.js                                              # throughput/latency/spawn profiling
KILL_DELAY_MS=1500 RECOVERY_TIMEOUT_MS=60000 node failure-benchmark.js   # crash recovery
```

Full numbers, hardware specs, and stated limitations: **[BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md)**.

---

## Project Structure

```text
.
├── apps/web/            # Browser UI — Monaco editor, live streaming, job history
├── infra/               # Docker Compose files, Postgres schema, Prometheus config
├── runners/             # Python & JavaScript sandbox images
├── services/
│   ├── api-gateway/     # Fastify REST/WebSocket API
│   ├── execution-worker/# Redis worker + Docker sandbox runner
│   └── system-monitor/  # Heartbeat scanner + orphan reaper
├── shared/              # Contracts, logger, metrics (shared across services + web UI)
├── tests/failure/       # Live failure and regression tests
├── benchmark.js / failure-benchmark.js
```

---

## Current Limitations

This is a local/demo-scale platform, not a production service.

| Gap | Notes |
|---|---|
| Single API key | No per-user auth — JWT or per-user keys would be the fix |
| No seccomp profile | Syscall abuse not fully blocked; `--cap-drop ALL` helps but doesn't cover everything |
| Single Redis / single PostgreSQL | No HA or replication |
| No job cancellation | Jobs run to completion or timeout |
| No autoscaling | Worker count set manually via `--scale` |

---

## Further Reading

| Doc | Covers |
|---|---|
| [docs/how-it-works.md](docs/how-it-works.md) | Full submission lifecycle: queueing, atomic claim, sandboxing, streaming, crash recovery, DLQ |
| [docs/reliability.md](docs/reliability.md) | AOF persistence, startup recovery, distributed reaper lock, graceful shutdown |
| [docs/design-decisions.md](docs/design-decisions.md) | Why Redis over RabbitMQ, why BRPOPLPUSH, why Docker, why Postgres over Mongo, etc. |
| [docs/api-reference.md](docs/api-reference.md) | Endpoint table, curl examples, WebSocket usage |
| [docs/testing.md](docs/testing.md) | Failure/regression suite, what each test proves |
| [docs/observability.md](docs/observability.md) | Prometheus/Grafana setup and dashboards |
| [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md) | All measured numbers, hardware specs, limitations |
