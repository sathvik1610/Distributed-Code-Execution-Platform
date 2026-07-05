# Architecture Diagram

## System Overview

```mermaid
flowchart TD
    Client["🖥️ Client\n(curl / run-file.js / WebSocket)"]

    subgraph API["API Gateway :8000"]
        Auth["Auth + Rate Limit\n30 req/min per IP"]
        Routes["REST Routes\nPOST /submissions\nGET /submissions/:id\nGET /dlq"]
        WS["WebSocket Handler\nGET /stream/:jobId"]
    end

    subgraph Redis["Redis 7"]
        PendingQ["List: jobs:queue:pending"]
        ProcQ["List: jobs:queue:processing:{workerId}"]
        DLQ["List: jobs:queue:dead-letter"]
        Heartbeat["String TTL: worker:heartbeat:{workerId}\nExpires: 15s"]
        Streams["Stream: jobs:streams:{jobId}\nTTL: 1 hour | Max: 1000 entries"]
        PubSub["Pub/Sub: jobs:streams:{jobId}"]
    end

    subgraph Workers["Execution Workers (×N)"]
        W1["Worker 1\nBRPOPLPUSH → claim\nHeatbeat every 5s"]
        W2["Worker 2"]
        W3["Worker 3"]
    end

    subgraph Sandbox["Docker Sandbox"]
        Docker["docker run\n--network none\n--memory 128m\n--pids-limit 50\n--read-only\n--user runner\n--cap-drop ALL\nTimeout: 5s"]
    end

    subgraph Monitor["System Monitor"]
        Reaper["Reaper (every 10s)\nScan heartbeats\nDetect dead workers\nRecover orphaned jobs"]
        Lock["Redis Lock: reaper:lock\n(prevents double-recovery)"]
        Recovery["Startup Recovery\nReset RUNNING → PENDING\nRe-hydrate queue from DB"]
    end

    subgraph DB["PostgreSQL 16"]
        Submissions["submissions\n(id, status, retry_count)"]
        Results["submission_results\n(exit_code, stdout, stderr,\nmemory_used_bytes,\nexecution_time_ms)"]
    end

    subgraph Observability["Observability"]
        Prom["Prometheus\n:9090\nScrape every 2s"]
        Grafana["Grafana :3000\nDashboards"]
        M1["Gateway metrics :9100"]
        M2["Worker metrics :9101"]
        M3["Monitor metrics :9102"]
    end

    %% Client → API
    Client -->|"POST /submissions\nX-API-Key header"| Auth
    Auth --> Routes
    Client <-->|"WebSocket stream"| WS

    %% API → DB + Redis
    Routes -->|"INSERT status=PENDING"| Submissions
    Routes -->|"LPUSH"| PendingQ

    %% WebSocket replay + live
    WS -->|"XRANGE (replay)"| Streams
    WS -->|"SUBSCRIBE"| PubSub

    %% Workers claim jobs
    PendingQ -->|"BRPOPLPUSH (atomic)"| ProcQ
    ProcQ --> W1
    ProcQ --> W2
    ProcQ --> W3

    %% Workers execute
    W1 -->|"spawn docker"| Docker
    W2 -->|"spawn docker"| Docker
    W3 -->|"spawn docker"| Docker

    %% Workers publish output
    Docker -->|"stdout/stderr chunks"| W1
    W1 -->|"XADD"| Streams
    W1 -->|"PUBLISH"| PubSub

    %% Workers persist results
    W1 -->|"BEGIN; INSERT result;\nUPDATE status; COMMIT"| Results
    W1 -->|"LREM (ack)"| ProcQ
    W1 -->|"SET EX 15"| Heartbeat

    %% Monitor scans
    Reaper -->|"SCAN heartbeat:*"| Heartbeat
    Reaper -->|"SCAN processing:*"| ProcQ
    Reaper -->|"re-enqueue"| PendingQ
    Reaper -->|"DLQ after 3 retries"| DLQ
    Reaper --- Lock

    %% Startup recovery
    Recovery -->|"UPDATE RUNNING→PENDING"| Submissions
    Recovery -->|"LPUSH if queue empty"| PendingQ

    %% Observability
    M1 --> Prom
    M2 --> Prom
    M3 --> Prom
    Prom --> Grafana
```

---

## Job Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> PENDING: POST /submissions
    PENDING --> RUNNING: Worker claims via BRPOPLPUSH\n+ UPDATE WHERE status=PENDING
    RUNNING --> COMPLETED: Exit code 0\nTransaction committed
    RUNNING --> FAILED: Exit code ≠ 0\nOOM (exit 137)\nStream output > 1MB
    RUNNING --> TIMEOUT: Execution > 5 seconds
    RUNNING --> PENDING: Worker crash detected\nReaper re-enqueues\n(retry_count < 3)
    PENDING --> FAILED: retry_count ≥ 3\nRouted to DLQ
```

---

## Redis Key Namespace

```
jobs:queue:pending                    ← all unassigned jobs (List)
jobs:queue:processing:{workerId}      ← jobs owned by a specific worker (List)
jobs:queue:dead-letter                ← exhausted-retry jobs (List)
worker:heartbeat:{workerId}           ← liveness signal, TTL=15s (String)
jobs:streams:{jobId}                  ← replayable output chunks, TTL=1h (Stream)
reaper:lock                           ← distributed scan lock, TTL=15s (String)
```

---

## Sequence: Submit → Execute → Stream

```mermaid
sequenceDiagram
    participant C as Client
    participant API as API Gateway
    participant R as Redis
    participant W as Worker
    participant D as Docker
    participant DB as PostgreSQL

    C->>API: POST /submissions {code, language}
    API->>DB: INSERT submissions (status=PENDING)
    API->>R: LPUSH jobs:queue:pending
    API-->>C: 201 {jobId, status: PENDING}

    C->>API: WS /stream/{jobId}
    API->>R: XRANGE jobs:streams:{jobId} (replay existing)
    API-->>C: [previous chunks if any]
    API->>R: SUBSCRIBE jobs:streams:{jobId}

    W->>R: BRPOPLPUSH pending → processing:{workerId}
    W->>DB: UPDATE status=RUNNING WHERE status=PENDING
    W->>D: docker run (code via stdin)

    loop stdout/stderr chunks
        D-->>W: chunk
        W->>R: XADD jobs:streams:{jobId}
        W->>R: PUBLISH jobs:streams:{jobId}
        R-->>API: (subscriber receives)
        API-->>C: chunk via WebSocket
    end

    D-->>W: exit
    W->>DB: BEGIN; INSERT result; UPDATE status=COMPLETED; COMMIT
    W->>R: LREM processing:{workerId}
    W->>R: PUBLISH EXECUTION_COMPLETE
    R-->>API: EXECUTION_COMPLETE
    API-->>C: close WebSocket
```
