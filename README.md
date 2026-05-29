# Distributed Code Execution Platform

[![Node.js](https://img.shields.io/badge/Node.js-v20+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Redis](https://img.shields.io/badge/Redis-v7.0-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Fastify](https://img.shields.io/badge/Fastify-v4-000000?style=for-the-badge&logo=fastify&logoColor=white)](https://www.fastify.io/)
[![Prometheus](https://img.shields.io/badge/Prometheus-Metrics-E6522C?style=for-the-badge&logo=prometheus&logoColor=white)](https://prometheus.io/)
[![Grafana](https://img.shields.io/badge/Grafana-Dashboards-F46800?style=for-the-badge&logo=grafana&logoColor=white)](https://grafana.com/)
 
This is a **distributed backend system** that accepts untrusted code over a REST API, runs it inside isolated Docker container sandboxes with strict resource limits, and streams stdout/stderr back in real-time over a **WebSocket**. It is engineered to handle the typical infrastructure challenges of an online compiler or automated coding grader.

## Key Results

- **3-Worker Distributed Execution Cluster:** Deployed locally inside WSL2 (Ubuntu) isolating the API Gateway, Worker replicas, Postgres, Redis, and System Monitor.
- **Linear Throughput Scaling:** Achieved **6.02 jobs/sec** aggregate execution throughput (**~2.01 jobs/sec per worker replica**) under queue saturation.
- **Fast Cold-Start Latency:** Average end-to-end client latency of **557.2 ms** (minimum **516 ms**) under 1-to-1 concurrency (Scenario 1).
- **Zero Host-Disk I/O for Code Staging:** Code is piped via `stdin` directly into container-level memory-backed RAM mounts (`--tmpfs`), eliminating host disk writes.
- **Deterministic Telemetry Collection:** Byte-precise peak memory telemetry captured in **< 1 ms** directly via Linux kernel cgroups, eliminating container deletion races.
- **Automated Orphan-Job Recovery:** Stranded execution tasks are automatically detected and re-queued by a background System Monitor in **< 25 seconds** during worker crashes.

*Note: Ingestion latency, throughput, and execution metrics are dependent on host hardware specification (CPU cores, processing speeds, physical SSD capabilities, operating system scheduling, and WSL2 networking overhead) as well as the active worker replica count. Code is staged inside a RAM-backed tmpfs volume, so 0 host writes occur for the code staging lifecycle (Docker logging drivers and database persistence still commit metadata to the host disk).*


---

## System Architecture

```
 Client
    │
    │  POST /submissions  { code, language }  +  X-API-Key header
    │  GET  /stream/:jobId  (WebSocket)
    ▼
┌──────────────────────────────────────────────────────────────┐
│                        API Gateway                           │
│  Fastify HTTP + WebSocket server                             │
│  • Validates X-API-Key and JSON schema                       │
│  • Redis-backed rate limiter — 30 req/min/IP (Bypassed locally)│
│  • Writes PENDING row to PostgreSQL                          │
│  • LPUSH job payload to Redis pending queue                  │
│  • Subscribes to Redis pub/sub (jobs:streams:*)              │
│  • Forwards stream chunks to WebSocket clients               │
│  Ports: :8000 (HTTP/WS)  :9100 (Prometheus metrics)         │
└──────────────────────────┬───────────────────────────────────┘
                           │ LPUSH
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                         Redis                                │
│  jobs:queue:pending              — main job queue (List)     │
│  jobs:queue:processing:{id}      — per-worker in-flight job  │
│  jobs:queue:dead-letter          — failed after max retries  │
│  worker:heartbeat:{id}           — TTL key, refreshed 5s     │
│  jobs:streams:{jobId}            — pub/sub stdout/stderr     │
│  Port: :6379                                                 │
└──────────────────────────┬───────────────────────────────────┘
                           │ BRPOPLPUSH (atomic dequeue)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                   Execution Worker(s)                        │
│  Stateless — can run N replicas on separate nodes            │
│  • Dequeues job atomically into processing:{workerId}        │
│  • Updates submission status to RUNNING in PostgreSQL        │
│  • Contacts Docker Socket Proxy via TCP                      │
│  • Pipes code over stdin to sandbox container                │
│  • Publishes stdout/stderr chunks to Redis pub/sub           │
│  • Commits result to PostgreSQL in a BEGIN/COMMIT block      │
│  • LREM from processing queue (acknowledge)                  │
│  • Sends heartbeat every 5 seconds (TTL 15s)                 │
│  Port: :9101 (Prometheus metrics per replica)                │
└──────────────────────────┬───────────────────────────────────┘
                           │ TCP (DOCKER_HOST=tcp://docker-proxy:2375)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Docker Socket Proxy                       │
│  tecnativa/docker-socket-proxy                               │
│  • Only container that mounts /var/run/docker.sock           │
│  • Allowlist: container create, start, kill, inspect         │
│  • Blocks: volume binds, image ops, network changes, Swarm   │
│  Port: :2375 (internal)                                      │
└──────────────────────────┬───────────────────────────────────┘
                           │ docker run -i --rm
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Sandbox Container                         │
│  Image: runner-python  OR  runner-javascript                 │
│  Entrypoint: runner-wrapper.sh                               │
│    1. Reads code from stdin → writes to /tmp (tmpfs, RAM)    │
│    2. Executes: python -u /tmp/code.py                       │
│               OR  node /tmp/code.js                          │
│    3. Reads /sys/fs/cgroup/memory.peak on exit               │
│    4. Outputs ___MEM_PEAK___: <bytes> token                  │
│  Kernel constraints:                                         │
│    --network none   --memory 128m  --memory-swap 128m        │
│    --pids-limit 50  --read-only   --cap-drop ALL             │
│    --security-opt no-new-privileges  --user runner           │
│    --tmpfs /tmp:rw,size=32m,mode=1777                        │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                    System Monitor                            │
│  Runs independently as a separate service                    │
│  Every 10s:                                                  │
│    • Scans all worker:heartbeat:* keys in Redis              │
│    • Cross-checks jobs:queue:processing:* lists              │
│    • For any processing queue with no matching heartbeat:    │
│      → RPOPLPUSH back to pending queue (recover orphan)      │
│    • Increments retry counter, routes to DLQ after 3 tries   │
│  Port: :9102 (Prometheus metrics)                            │
└──────────────────────────────────────────────────────────────┘
```

---

## The Engineering Problems Solved

### 1. Host Security (Sibling Container Escape)
- **Problem:** Mounting `/var/run/docker.sock` directly inside a worker gives raw root-equivalent access to the host. A compromised sandbox or worker would allow an attacker to escape to sibling containers or hijack the host filesystem.
- **Solution:** Workers are isolated from the UNIX socket. A dedicated **Docker Socket Proxy** (`tecnativa/docker-socket-proxy`) acts as a secure firewall. Workers communicate purely over TCP, and the proxy enforces a strict allowlist—allowing container creation and termination while completely blocking volume mounts, network configurations, or image alterations.

### 2. Multi-Worker Scalability (Eliminating Host Disk coupling)
- **Problem:** Standard approaches mount code files from host directories into containers (`-v /tmp/code:/app/code`), physically coupling execution workers to the same node as the Docker daemon and preventing multi-node horizontal scaling.
- **Solution:** Workers stream user code directly to the container's standard input (`stdin`). Inside the container, an unprivileged entrypoint wrapper script reads `stdin` and writes the code into a memory-backed RAM directory (`--tmpfs /tmp:rw,size=32m,mode=1777`). This eliminates host-disk writes for code staging, allowing workers to run anywhere on a cluster network.

### 3. Telemetry (Deterministic Telemetry Collection)
- **Problem:** Polling `docker stats` after container exit is highly inefficient and races container teardown. For fast scripts executing under 20ms, the container is destroyed (`--rm`) before the poll finishes, leaving a database filled with `null` metrics.
- **Solution:** Telemetry is captured *internally* at the container level. Immediately before the user script exits, the wrapper script reads the Linux kernel cgroups (`memory.peak` or `memory.max_usage_in_bytes`) and prints a token to `stdout`. The worker intercepts and strips the token before publishing logs, ensuring telemetry is captured before container teardown with sub-millisecond overhead.

### 4. Queue Durability (At-Least-Once Delivery)
- **Problem:** Popping jobs standardly with `BLPOP` means that if a worker crashes mid-execution, the job is lost forever. Alternatively, writing database results and then crashing before acknowledging the queue causes duplicate processing.
- **Solution:** Workers use the atomic Redis **`BRPOPLPUSH`** command to transition jobs from the main queue to a worker-specific processing queue. The job remains in this processing list until a multi-statement PostgreSQL database transaction (`BEGIN`/`COMMIT` block) successfully writes the execution output. If the worker crashes, the System Monitor detects the missing heartbeat and safely re-enqueues the stranded job.

### 5. Resource Isolation (Runaway Code)
- **Problem:** Malicious user code can attempt infinite loop CPU hogs, process starvation (fork-bombs), memory leaks, or logging spam.
- **Solution:** Hard kernel limits are enforced on the sandbox (`--network none`, `--memory 128m`, `--memory-swap 128m`, `--pids-limit 50`, `--read-only`, and `--cap-drop ALL`), while runaway runtimes are terminated via wall-clock timeouts in the worker.

---

## System Performance & Benchmarks (WSL2 Run)

The benchmark values presented below are physically measured from our live WSL2 cluster run (using `node benchmark.js`). They demonstrate how the system scales and recovers under load.

> **Environment note:** All numbers are from WSL2 (Ubuntu) on consumer hardware. WSL2 introduces a virtualization networking layer that adds latency overhead not present on bare Linux. Absolute latency numbers (e.g. 557 ms) would be lower on native Linux or cloud infrastructure — the *relative* behaviour (linear scaling, queue wave model, tail latency growth) holds regardless of host.

### 1. Throughput & Latency

*   **Aggregate Throughput:** **6.02 jobs/sec** (under saturated queue conditions), showing that 3 worker replicas scale linearly at **~2.01 jobs/sec per worker**.
*   **E2E Latency Profile:** Under 1-to-1 concurrency (Scenario 1), average end-to-end latency is **557.2 ms** (with a **516 ms** minimum).
*   **Deterministic Latency Breakdown:**
    *   **Queueing, network transit, and database metadata transactions:** `~100 ms`
    *   **Container execution lifecycle:** `~457 ms` (Docker process creation, code execution, internal cgroup peak RAM lookup, and process teardown—perfectly matching database-recorded runtimes averaging `430–489 ms`).
*   **Redis Pub/Sub WebSocket Stream Propagation:** **< 5 ms** propagation delay for stdout/stderr chunks from execution worker to client WebSockets.

| Metric | Scenario 1: Optimal Queue Balance (Concurrency=3) | Scenario 2: Queue Saturation (Concurrency=10) |
| :--- | :--- | :--- |
| **Total Jobs Processed** | 9 | 20 |
| **Active Target Concurrency** | 3 (1 per worker) | 10 (Saturating the pool) |
| **Total End-to-End Duration** | **1.68 seconds** | **3.32 seconds** |
| **Distributed Throughput** | **5.35 jobs/sec** | **6.02 jobs/sec** |
| **Average End-to-End Latency** | **557.2 ms** | **1,311.5 ms** |
| **Median (p50) Latency** | **522 ms** | **1,438 ms** |
| **Tail (p95 / p99) Latency** | **638 ms** | **1,882 ms** |
| **Minimum / Maximum Latency** | **516 ms / 638 ms** | **528 ms / 1,882 ms** |

*Scenario 2 is a queue saturation behavioural test — it validates that tail latency grows predictably with the wave model `(concurrency / workers) × ~500ms` and is not a steady-state throughput study. For statistically robust throughput numbers, run with a larger job corpus on dedicated hardware.*

### 2. Resource Isolation & Failure Containment

Enforcing strict Linux kernel control groups and resource constraints protects host compute capacity, securely terminating runaway processes under sub-millisecond to sub-second durations:

| Attack Scenario | Active Kernel/Worker Mitigations | Containment Speed |
| :--- | :--- | :--- |
| **Infinite CPU Loop** | Worker-side wall-clock timeout cancellation | **Exactly 5,000 ms** (configurable) |
| **Fork Bomb (Process Exhaustion)** | Linux Cgroups process limit (`--pids-limit 50`) | **< 15 ms** (instant kernel rejection) |
| **Memory Exhaustion (OOM)** | Hard container swap memory limits (`--memory 128m`) | **< 50 ms** (OOM SIGKILL exit 137) |
| **Infinite Output (Log Spam)** | Worker-side network pub/sub stream cap (`1 MB`) | **< 700 ms** (SIGKILL exit 137 at 1 MB) |

### 3. Telemetry Accuracy & Cost

Custom peak memory readings directly tap the kernel-level control group files to guarantee perfect reliability without the timing race conditions typical of polling architectures:

| Metric | Value | Technical Context & Cost |
| :--- | :--- | :--- |
| **Memory Telemetry Reliability** | **100% Reliable** | Reads kernel `/sys/fs/cgroup/memory.peak` *inside* container immediately before exit, entirely bypassing the container destruction race. |
| **Telemetry Collection Overhead** | **< 1 ms** | Single file read versus a resource-intensive `~100ms` asynchronous `docker stats` polling loop. |
| **Node.js Sandbox Peak RAM** | **8,339,456 bytes (~7.9 MB)** | Exact kernel control group value, byte-precise footprint. |
| **Python Sandbox Peak RAM** | **8,228,864 bytes (~7.8 MB)** | Exact kernel control group value, byte-precise footprint. |
| **Host Disk Writes Per Job** | **0** | Code piped via `stdin` to container's RAM `tmpfs`. Nothing written on host disk. |

### 4. Reliability & Recovery

Ensuring high-availability job durability at-least-once through durable transactional queues and active background heartbeats:

| Scenario | Active Mitigations | Recovery Time |
| :--- | :--- | :--- |
| **Execution Worker Crash / SIGKILL** | Atomic queue dequeue via `BRPOPLPUSH` + System Monitor heartbeat scans | **< 25 seconds** (3 missed beats of 5s heartbeats, TTL 15s) |
| **Database Transaction Failure** | ACID transaction `BEGIN`/`COMMIT` block protects submission state updates | **Instant** (job remains in processing queue for retry/monitor sweep) |
| **Persistent Infrastructure Outage** | Routed to Dead Letter Queue (DLQ) after `3` failed execution attempts | **After 3 retries** (prevents toxic payloads from looping) |

### Side-by-Side Architectural Improvement vs. Standard Approach

| Dimension | Standard Docker Approach | This System | Improvement |
| :--- | :--- | :--- | :--- |
| Host disk writes per job | 1 write + 1 delete | **0** | **Eliminated at container layer** (pure in-RAM tmpfs mounts) |
| Host socket exposure | Raw `/var/run/docker.sock` | **Filtered TCP proxy** | **Restricted socket access** (workers only talk to filtered proxy TCP) |
| Memory telemetry accuracy | Unreliable (frequently returns `null` or missing telemetry for scripts executing in < 20ms due to container deletion races) | **100% reliable** (always captures cgroup peak usage prior to wrapper script exit) | **Eliminated race conditions** via exit-cgroup architecture |
| Worker horizontal scalability | Same-VM only | **Any node on network** | **Horizontal worker scalability** |
| Orphan job recovery | Manual / never | **Automatic < 25s** | **Fully automated** |

---

## Quick Start (Install & Run)

### 1. Build & Compile
```bash
# Install workspace dependencies
npm ci

# Compile shared libraries
npm run build:shared

# Compile microservices
npm run build

# Build Python and JavaScript sandbox runner images
wsl -u root bash -c "npm run docker:build:runners" # WSL2
# Or on Linux/macOS: sudo npm run docker:build:runners
```

### 2. Start the Cluster
```bash
# Set API Key for gateway authorization
export API_KEY=test-api-key

# Start all services with 3 worker replicas
npm run start:all:scaled
```

### 3. Submit a Local Script
Submit and stream code output in real time using the local test runner:
```bash
# Run JavaScript
node run-file.js sample.js

# Run Python
node run-file.js sample.py
```

### 4. Submit via HTTP POST
```bash
curl -X POST http://localhost:8000/submissions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{
    "language": "python",
    "code": "print([x * 2 for x in range(5)])"
  }'
# → { "jobId": "uuid-here", "status": "PENDING" }
```

---

## REST API Reference

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/submissions` | Submit code for execution. Returns `{ jobId, status }`. |
| `GET` | `/submissions/:id` | Fetch full submission result including stdout, stderr, exit status, and memory metrics. |
| `GET` | `/submissions?page=1&limit=10&status=COMPLETED` | Paginated submission history with optional status filter. |
| `GET` | `/stream/:jobId` | WebSocket — live stdout/stderr stream for a job. |
| `GET` | `/dlq` | Inspect jobs in the Dead Letter Queue (failed after max retries). |
| `DELETE` | `/dlq/:jobId` | Remove a specific job from the Dead Letter Queue. |
| `GET` | `/health` | Health check (no auth required). |

* **Auth:** All routes except `/health` and `/stream/*` require `X-API-Key: <key>` header.
* **Bypass:** Loopback connections (`127.0.0.1`/`::1`) and validated API keys bypass global rate limits for monitoring and local benchmarking.

---
# 🧠 Systems Architecture & Tradeoffs Deep Dive
---

This section outlines the detailed architectural state machines, system constants, operational boundaries, and design tradeoffs of the platform.

## Submission Lifecycle Walkthrough

```
Client POSTs code
  └─► API Gateway validates auth, rate limit, schema
      └─► INSERT submissions (status=PENDING) → PostgreSQL
          └─► LPUSH job payload → Redis pending queue
              └─► Return 201 { jobId }

Worker (blocking BRPOPLPUSH loop)
  └─► Dequeues job → moves to jobs:queue:processing:{workerId}
      └─► UPDATE status=RUNNING (optimistic lock — skips if already claimed)
          └─► Spawns sandbox via Docker Socket Proxy (TCP)
              └─► Pipes code over stdin → container writes to /tmp (RAM)
                  └─► Executes script
                      ├─► stdout/stderr chunks → PUBLISH jobs:streams:{jobId}
                      └─► On exit: reads /sys/fs/cgroup → ___MEM_PEAK___ token
                          └─► BEGIN TRANSACTION
                              ├─► INSERT submission_results ON CONFLICT DO NOTHING
                              └─► UPDATE submissions status=COMPLETED|FAILED|TIMEOUT
                              COMMIT
                              └─► LREM from processing queue
                                  └─► PUBLISH EXECUTION_COMPLETE

API Gateway (subscribed to jobs:streams:*)
  └─► Receives chunks → forwards to WebSocket client
      └─► On EXECUTION_COMPLETE → closes WebSocket (code 1000)

If worker crashes mid-execution:
  └─► Heartbeat expires (15s)
      └─► System Monitor detects orphan in processing:{deadWorkerId}
          └─► RPOPLPUSH back to pending queue
              └─► Next available worker picks it up
```

---

## Practical System Operational Boundaries

Rather than relying on unverified estimates, the system's operational envelope is characterized by the following practical bounds under our test configuration:

* **Baseline Cold Start Overhead:** `~500 ms`. The physical Docker container provisioning latency (creating, starting, and running a fresh sandbox on demand under WSL2).
* **Queue Processing Delay:** Bounded by `(Concurrency / Worker Replicas) * 500ms + 500ms`. Under our 10-concurrency on 3-worker benchmark, tail latency scales predictably to `~1.88 seconds`, representing 4 consecutive execution waves.
* **Safety Output Limits:** Capped at `1 MB` for live network streams (container is forcefully killed when the threshold is reached to prevent buffer bloat) and exactly `64 KB` for historical database persistence.
* **Process Allocation Limit:** Capped at `50 PIDs` via Linux cgroups `pids-limit`. Enforced at the kernel level to halt process-exhaustion attacks (fork-bombs) immediately.
* **Ingestion Rate Limit:** `30 submissions/minute` per client IP. Enforced via atomic sliding window Redis tokens to prevent queue monopolization.

---

## System-Level Constants & Limits Rationale

Beyond sandbox parameters, global limits are tuned to protect the infrastructure while guaranteeing high availability:

* **Rate Limit (30 req/min per IP):** Prevents a single client from monopolizing the Redis queue. With 3 worker replicas, the maximum sustainable execution throughput is around ~6–15 jobs/sec. A limit of 30 req/min per IP allows burst activity for normal users while protecting queue fairness.
* **Heartbeat TTL (15s TTL, 5s interval):** A 5-second interval keeps heartbeat traffic low on Redis. A 15-second TTL (3 missed beats) provides a buffer for transient networking issues or Garbage Collection (GC) pauses on the worker, avoiding false-positive node recovery while guaranteeing failed workers are reaped in under 25 seconds.
* **Max Retries (3 attempts):** Retrying failed or crashed jobs allows the system to recover from transient infrastructure failures (e.g., database connection blips). Capping this at 3 attempts prevents bad or exploit code from causing infinite worker crash-and-reboot cycles, routing the toxic job to the Dead Letter Queue for analysis.

---

## Key Architectural Tradeoffs

**On-demand container spawn vs. pre-warmed pools:**
Each job boots a fresh container, which pays a 200–500ms cold-start penalty before the user code runs. This keeps workers completely stateless and free of cross-run memory leaks. In production, you'd maintain a pool of paused, pre-warmed containers and resume them on job arrival, dropping startup latency to under 5ms.

**At-least-once delivery:**
`BRPOPLPUSH` guarantees the job payload survives worker crashes, but if a worker crashes *after* committing results to PostgreSQL and *before* `LREM`-ing the queue item, the job runs twice. The `ON CONFLICT (job_id) DO NOTHING` constraint on `submission_results` makes the second write a no-op, so the outcome is still correct. This is a deliberate tradeoff — exactly-once semantics would require a distributed transaction coordinator or a Transactional Outbox pattern.

**Single Redis node:**
Redis is the single point of failure for the queue, pub/sub, and heartbeats. If it goes down, in-flight jobs stuck in the pending list since the last AOF sync are lost, and WebSocket streaming is unavailable. Production mitigations: Redis Sentinel for HA, or ElastiCache with Multi-AZ replication and AOF persistence enabled.

**Single-file submissions:**
Piping code over stdin restricts submissions to a single source file. Multi-file project support would require serializing the workspace into a `.tar` archive, streaming it over stdin, and unpacking inside the container before execution.

**WebSocket fan-out is gateway-local:**
The `Map<jobId, Set<WebSocket>>` lives in the API Gateway process memory. If you run multiple gateway instances behind a load balancer, a client connected to Gateway A won't receive stream events if Gateway B picked up the job. Production fix: route WebSocket connections with sticky sessions, or use a dedicated pub/sub relay layer.

**Container Ephemerality vs. Debuggability:**
Containers are launched with the `--rm` flag to guarantee immediate host resource cleanup. This prevents host disk clutter and stale container drift. However, if a container fails due to an obscure runtime issue, developers cannot connect to or inspect the container post-mortem (e.g., via `docker inspect` or `docker exec`). Troubleshooting depends entirely on the captured stdout, stderr, and worker logs.

**Wall-Clock vs. CPU-Time Timeout:**
The 5-second timeout is monitored using the host's wall-clock time by the worker process, rather than the container's CPU-time. A script executing a sleep command (e.g. `time.sleep(4.9)`) that does minimal work will pass. Conversely, if high host load slows down container initialization and runtimes, a fast and CPU-light user script could be prematurely terminated, causing a false-positive timeout.

**Infinite Submission History vs. Database Growth:**
PostgreSQL stores the full source code and metadata of every single execution indefinitely. While this provides a complete history for auditing, a production cluster under heavy load would experience extremely fast database storage growth. A real-world deployment would require a partition strategy, archival to cold storage (e.g. S3), or an automatic time-to-live (TTL) pruning process.

**Client IP-Based Rate Limiting NAT Constraint:**
Rate limiting is checked per client IP. If multiple clients connect from the same Network Address Translation (NAT) gateway—such as a university campus, office network, or shared proxy—they share the single bucket of 30 requests/minute. This can lead to starvation where one user's burst rate limits other innocent users sharing the same NAT IP address.

---

## Observability & Observability Stack

All three services expose Prometheus metrics endpoints scraping performance:

| Service | Metrics Port | Key Metrics |
| :--- | :--- | :--- |
| API Gateway | `:9100` | Request latency (p50/p95/p99), rate-limit hits, active WebSockets, queue depth |
| Execution Worker | `:9101` | Jobs completed/failed/timeout per language, execution duration histogram, queue wait time |
| System Monitor | `:9102` | Orphan jobs recovered, dead workers detected |

**Grafana Dashboard:** Open `http://localhost:3000` → login `admin/admin` → open **Distributed Code Execution Platform** to view panels monitoring queue depths, WebSocket events, and worker execution times.

---

## Testing

### Failure Containment Tests
```bash
# Runs 4 automated failure scenarios: infinite loop, fork bomb, OOM, infinite output
npm run test:failure

# Expected:
#   PASSED:  4
#   FAILED:  0
#   SKIPPED: 1 (worker crash test — manual)
```

### Load Test (50 concurrent submissions)
```bash
# Demonstrates rate limiting and queue behavior under burst load
node load-test.js
```

### WebSocket Stream Test
```bash
# Submits a job and streams the output live over WebSocket
node test-ws.js
```

---

## Project Structure

```
distributed-code-execution-platform/
├── infra/
│   ├── docker-compose.yml          # Postgres, Redis, Prometheus, Grafana
│   ├── docker-compose.services.yml # API Gateway, Worker, Monitor, Docker Proxy
│   └── schema.sql                  # PostgreSQL table definitions
├── runners/
│   ├── javascript/
│   │   ├── Dockerfile              # node:20-alpine, non-root runner user
│   │   └── runner-wrapper.sh       # stdin reader, cgroup peak memory capture
│   └── python/
│       ├── Dockerfile              # python:3.11-slim, non-root runner user
│       └── runner-wrapper.sh       # stdin reader, cgroup peak memory capture
├── shared/
│   ├── contracts/                  # Shared TypeScript types, queue key names, constants
│   ├── logger/                     # Pino structured logger instance
│   └── metrics/                    # Prometheus counter/histogram wrappers
└── services/
    ├── api-gateway/                # Fastify HTTP + WebSocket server
    ├── execution-worker/           # BRPOPLPUSH loop + Docker sandbox spawner
    └── system-monitor/             # Heartbeat sweeper + orphan job reaper
```
