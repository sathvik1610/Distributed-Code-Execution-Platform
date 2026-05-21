# Distributed Sandboxed Code Execution Platform (Fault-Tolerant Prototype)

A fault-tolerant, isolated, and observable distributed code execution engine designed to run untrusted user code (Python, JavaScript) in real-time. This project implements the core backend architecture of competitive programming platforms like LeetCode and HackerRank as an educational prototype.

---

## 💡 What This Project Does

This project is a mini backend for running user-submitted code safely, similar to the execution engine behind platforms like LeetCode.

A user submits Python or JavaScript code. The API stores the request, puts it into a queue, and a background worker runs the code inside a restricted Docker container. While the code runs, the user can see live output through WebSockets. If a worker crashes, a monitor service detects it and puts the unfinished job back into the queue so it is not lost.

The project focuses on backend reliability, sandboxing, distributed job processing, and observability.

---

## 🚀 System Architecture

The platform is designed as an asynchronous, microservice-based architecture to decouple ingestion from heavy sandboxed compute.

```
                    +-------------------+
                    |    User/Client    |
                    +---------+---------+
                              |
        1. POST /submissions  |  4. Real-time stdout/stderr
           (REST Payload)     |     (WebSockets Stream)
                              v
                    +-------------------+
                    |    API Gateway    |
                    +----+---------+----+
                         |         |
     2. Write 'PENDING'  |         | 3. LPUSH
        State            v         v
                +--------+---+   +─+──────────+
                | PostgreSQL |   | Redis Queue| (FIFO Pending Queue)
                +────────────+   +─+──────────+
                                   |
                                   | 5. BRPOPLPUSH (Crash-Safe Dequeue)
                                   v
                        +──────────+──────────+
                        |   Execution Worker  | <---+ [Heartbeat: worker:heartbeat:*]
                        +──────────+──────────+     |
                                   |                | 8. Check worker health
                                   | 6. Spawn       |    & recover orphaned jobs
                                   v                |
                        +──────────+──────────+     |
                        |   Docker Container  |     |
                        |  (Python/JS Sandbox)|     |
                        +──────────+──────────+     |
                                   |                |
                       7. Publish  |                |
                          Stream   v                |
                        +──────────+──────────+     |
                        |    Redis Pub/Sub    |     |
                        | (jobs:streams:*     |     |
                        +──────────+──────────+     |
                                   |                |
                                   |                |
                        +──────────+──────────+     |
                        |   System Monitor    |-----+
                        |      (Reaper)       | (Runs scan every 10s)
                        +---------------------+
```

---

## 🛠️ Technology Stack & Decisions

### 1. Redis — Queueing, Pub/Sub, and Crash-Safe Job Handoff
*   **Message Broker:** The API Gateway pushes jobs using `LPUSH`. The workers consume jobs using `BRPOPLPUSH` into a worker-specific processing queue. This provides an atomic, crash-safe transition—if a worker node fails, the job remains in the processing queue rather than being lost.
*   **Real-time Streaming:** The API Gateway opens a WebSocket per client subscription. Instead of polling the database, it subscribes to `jobs:streams:<jobId>` on Redis. The sandbox writes directly to this Pub/Sub channel, offering low-latency delivery of logs.

### 2. PostgreSQL — Transactional State Persistence
*   **State Machine:** Submissions transition through `PENDING -> RUNNING -> COMPLETED/FAILED/TIMEOUT`.
*   **Optimistic Concurrency Control:** Workers claim jobs using a database-level Compare-And-Swap (CAS) write:
    ```sql
    UPDATE submissions
    SET status = 'RUNNING'
    WHERE id = $2 AND status = 'PENDING';
    ```
    This guarantees that even if a job is concurrently scheduled, only one worker can process it.
*   **ACID Transactions:** To prevent split-brain states where results are written but the parent status remains stuck at `RUNNING` due to a mid-process crash, the final status update and results insertion are wrapped in a database transaction (`BEGIN`/`COMMIT`).

### 3. Docker — Sandbox Container Isolation
Untrusted user code is executed in isolated containers configured with strict runtime policies:
*   `--network none`: Complete network isolation. No outbound internet access.
*   `--memory 128m` & `--memory-swap 128m`: Restricts RSS usage. Prevents RAM-exhaustion attacks.
*   `--pids-limit 50`: Restricts maximum process forks to prevent fork-bomb attacks.
*   `--read-only` & `--tmpfs /tmp`: Makes the root filesystem immutable. Writable storage is limited to in-memory `/tmp`.
*   `--user runner`: Drops root privileges to run as a non-privileged system user inside the container.

---

## 🔍 Observability & Telemetry

Each service exports standard Prometheus metrics for system health monitoring:
*   **API Gateway (Port 9100):** Exposes active WebSocket connections, queue depth (`jobs:queue:pending`), and request counts.
*   **Execution Worker (Port 9101):** Exposes active worker counts, execution durations (`execution_time_ms` bucketed by language), and finished job metrics.
*   **System Monitor (Port 9102):** Exposes recovery count metrics and Dead Letter Queue (DLQ) transitions.

Grafana dashboards are provisioned out-of-the-box (access at `http://localhost:3000` with admin credentials) to visualize these metrics under load.

---

## ⚠️ Known Limitations & Scale Gaps (Interview Trade-offs)

If scaling this system to support large-scale workloads, these are the known operational bottlenecks and mitigation strategies:

1.  **Docker Boot Latency (100ms - 300ms):**
    *   *Limit:* Spawning a container using `docker run` has high kernel virtualization overhead.
    *   *Production Fix:* Replace Docker CLI calls with **AWS Firecracker MicroVMs** (which provide lower-latency microVM isolation) or maintain a pool of pre-warmed container sandboxes.
2.  **Kernel Security Sharing:**
    *   *Limit:* Docker containers share the host kernel. A kernel exploit could allow container breakout.
    *   *Production Fix:* Wrap container runtimes in **gVisor** (by Google) or run **Kata Containers** to provide microVM-level hardware isolation.
3.  **Redis Memory & Queueing Constraints:**
    *   *Limit:* Redis queues are memory-bound. A long queue under high load can exhaust RAM.
    *   *Production Fix:* Migrate from Redis Lists to **Apache Kafka** to support disk-based persistence and partition-based scale.

---

## ⚙️ How to Setup & Run Locally

### Prerequisites
*   Docker & Docker Compose
*   Node.js (v18+)
*   WSL 2 (if running on Windows)

### 1. Launch Infrastructure
```bash
cd infra
docker compose up -d
```
*Spins up PostgreSQL, Redis, Prometheus, and Grafana.*

### 2. Build Sandbox Images
```bash
cd runners
docker build -t runner-javascript -f javascript/Dockerfile .
docker build -t runner-python -f python/Dockerfile .
```

### 3. Build & Run Services
From the root workspace directory:
```bash
# Compile shared workspaces
npm run build:shared

# Compile all microservices
npm run build
```

Open three terminal tabs and start the services:
*   **Tab 1 (API Gateway):** `cd services/api-gateway && npm start`
*   **Tab 2 (Execution Worker):** `cd services/execution-worker && sudo npm start` *(requires sudo to run Docker commands)*
*   **Tab 3 (System Monitor):** `cd services/system-monitor && npm start`

### 4. Verify the System
Run the built-in real-time stream validation script:
```bash
node test-ws.js
```

---

## 💻 API Specification & Live Demo Walkthrough

### 1. Submit Code for Execution
Submit user code to be queued and executed asynchronously in an isolated sandbox.

*   **Endpoint:** `POST http://localhost:8000/submissions`
*   **Request Body:**
    ```json
    {
      "code": "import time\nprint('Starting job...')\ntime.sleep(2)\nprint('Done!')",
      "language": "python"
    }
    ```
*   **Response:**
    ```json
    {
      "jobId": "07dbfe27-3387-415b-9716-6ca8799a6285",
      "status": "PENDING"
    }
    ```

### 2. Stream Real-Time Console Output
Listen to standard output and error output in real time as the sandbox container executes the code.

*   **Protocol:** WebSocket
*   **Endpoint:** `ws://localhost:8000/stream/07dbfe27-3387-415b-9716-6ca8799a6285`
*   **Message Stream Output Example:**
    ```json
    {"type":"stdout","data":"Starting job...\n","timestamp":1779363738000}
    {"type":"stdout","data":"Done!\n","timestamp":1779363740000}
    ```

### 3. Fetch Submission Details & Final Metrics
Fetch persistent database records representing final exit codes, metrics, output, or compilation errors.

*   **Endpoint:** `GET http://localhost:8000/submissions/07dbfe27-3387-415b-9716-6ca8799a6285`
*   **Response:**
    ```json
    {
      "jobId": "07dbfe27-3387-415b-9716-6ca8799a6285",
      "language": "python",
      "sourceCode": "import time\nprint('Starting job...')\ntime.sleep(2)\nprint('Done!')",
      "status": "COMPLETED",
      "retryCount": 0,
      "exitCode": 0,
      "stdout": "Starting job...\nDone!\n",
      "stderr": "",
      "errorMessage": null,
      "executionTimeMs": 2045,
      "memoryUsedBytes": null,
      "createdAt": "2026-05-21T12:00:00.000Z",
      "updatedAt": "2026-05-21T12:00:02.000Z"
    }
    ```

### 4. Paginate & Filter Submissions
Query the historic database records using pagination and status filters.

*   **Endpoint:** `GET http://localhost:8000/submissions?status=COMPLETED&page=1&limit=10`
*   **Response:**
    ```json
    {
      "total": 45,
      "page": 1,
      "limit": 10,
      "totalPages": 5,
      "submissions": [
        {
          "jobId": "07dbfe27-3387-415b-9716-6ca8799a6285",
          "language": "python",
          "status": "COMPLETED",
          "retryCount": 0,
          "createdAt": "2026-05-21T12:00:00.000Z",
          "updatedAt": "2026-05-21T12:00:02.000Z"
        }
      ]
    }
    ```
