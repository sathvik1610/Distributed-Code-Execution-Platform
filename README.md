# Distributed Code Execution Platform

A distributed backend platform for safely executing untrusted Python and JavaScript code inside isolated Docker sandboxes. The system accepts code through a REST API, queues execution work through Redis, runs jobs on horizontally scalable worker containers, streams stdout/stderr over WebSockets, stores results in PostgreSQL, and recovers jobs when workers crash.

Built as a systems/backend engineering project — queues, workers, sandboxing, fault recovery, live streaming, observability, and failure testing, not just "run some code."

---

## Table of Contents

- [Quick Start](#quick-start)
- [Web UI](#web-ui)
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

```bash
# 1. Install
git clone <this-repo>
cd Distributed-Code-Execution-Platform
npm ci

# 2. Build (TypeScript packages + sandbox runner images + service images)
npm run build
npm run docker:build:runners
docker compose -f infra/docker-compose.yml -f infra/docker-compose.services.yml build

# 3. Start the backend (Postgres, Redis, API Gateway, System Monitor, 3 workers)
npm run start:all:scaled
curl http://localhost:8000/health   # → {"status":"OK",...}

# 4. Stop
npm run stop:all
```

If `docker ps` fails with a permission error on WSL/Linux: `sudo usermod -aG docker $USER && newgrp docker` (then `wsl --shutdown` on Windows and reopen).

---

## Web UI

A browser client lives in `apps/web` — Monaco code editor, language selector, live streamed output, status progression, execution metrics, and job history.

```bash
npm run dev:web   # with the backend already running
```

Open **http://localhost:5173**. No `.env` needed — the dev server proxies API calls and injects the API key server-side, so it never reaches the browser.

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
