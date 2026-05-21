# Distributed Code Execution Platform

## Complete Master Implementation Plan

---

# 1. PROJECT OVERVIEW

## Project Name

# Distributed Code Execution Platform

---

# Core Idea

A backend infrastructure platform that securely executes untrusted user-submitted code inside isolated Docker sandboxes using distributed workers, Redis-based job queues, realtime WebSocket streaming, fault recovery systems, and observability tooling.

Think:
mini LeetCode execution infrastructure backend.

NOT:
a frontend-heavy coding website clone.

---

# Main Engineering Goals

This project is designed to demonstrate:

* distributed systems fundamentals
* backend engineering depth
* concurrency handling
* fault tolerance
* sandboxed execution
* async architectures
* realtime communication
* observability
* infrastructure/system design thinking

---

# What Makes This Project Valuable

Most student projects are:

* CRUD apps
* frontend clones
* AI wrappers

This project instead demonstrates:

* worker coordination
* retry systems
* distributed queues
* process isolation
* idempotency
* failure recovery
* system monitoring

That is much closer to real backend engineering.

---

# 2. RECOMMENDED DEVELOPMENT ENVIRONMENT

# OS Setup

## Recommended:

Windows + WSL2 Ubuntu

---

# Why

You prefer Windows.
But backend infrastructure tooling works much better in Linux environments.

WSL2 gives:

* Linux runtime behavior
* Docker compatibility
* proper shell tooling
* realistic infra environment

without leaving Windows.

---

# Recommended Workflow

## Windows

Use for:

* browser
* VS Code UI
* normal daily usage

---

## WSL2 Ubuntu

Use for:

* Node.js
* Docker
* Redis
* PostgreSQL
* backend execution
* all terminal commands

---

# IMPORTANT

Store the project INSIDE WSL filesystem.

GOOD:

```text id="cq9mb5"
/home/sathvik/code-execution-platform
```

BAD:

```text id="tm5jn9"
/mnt/d/...
```

This avoids:

* filesystem slowness
* Docker mount issues
* watcher bugs
* permission problems

---

# Required Tools

Install inside WSL:

* Node.js 20+
* npm
* Docker Desktop with WSL integration
* Docker Compose
* Redis
* PostgreSQL
* Git

VS Code extensions:

* Remote WSL
* Docker
* TypeScript

---

# 3. HIGH-LEVEL ARCHITECTURE

# FINAL SYSTEM COMPONENTS

You should ONLY have these services.

---

# Service 1 — API Gateway

## Responsibilities

* REST APIs
* validation
* authentication later (optional)
* rate limiting
* websocket handling
* queue submission

---

# Service 2 — Execution Worker

MOST IMPORTANT SERVICE.

Handles:

* queue consumption
* Docker execution
* resource enforcement
* stdout/stderr streaming
* DB result persistence
* heartbeats

---

# Service 3 — System Monitor / Reaper

Handles:

* dead worker detection
* orphan job recovery
* retry orchestration
* dead-letter queue management

---

# Shared Components

## Redis

Used for:

* queues
* heartbeats
* pub/sub
* rate limiting

---

## PostgreSQL

Used for:

* submissions
* execution results
* statuses
* history

---

## Docker Sandboxes

Used for:

* isolated execution
* security boundaries
* resource limits

---

## Prometheus + Grafana

Used for:

* metrics
* dashboards
* observability

---

# 4. FINAL DIRECTORY STRUCTURE

```text id="txg9j7"
code-execution-platform/

├── services/
│   ├── api-gateway/
│   ├── execution-worker/
│   └── system-monitor/
│
├── shared/
│   ├── contracts/
│   ├── logger/
│   └── metrics/
│
├── runners/
│   ├── python/
│   └── javascript/
│
├── infra/
│   ├── docker-compose.yml
│   ├── prometheus.yml
│   └── k6-load-test.js
│
└── docs/
    ├── architecture.md
    ├── decisions/
    └── failure-analysis/
```

---

# 5. TECHNOLOGY STACK

# Backend

## Node.js + TypeScript

Why:

* productive
* async-friendly
* strong ecosystem
* easier for this project scope

---

# Framework

## Fastify preferred

Why:

* faster
* cleaner
* lower overhead

Express acceptable too.

---

# Queue + Cache

## Redis

Core distributed system backbone.

---

# Database

## PostgreSQL

Used for:

* transactional consistency
* indexing
* idempotent storage

---

# Containerization

## Docker

Mandatory.

---

# Logging

## Pino

Structured JSON logging.

---

# Monitoring

## Prometheus + Grafana

Mandatory for observability.

---

# Load Testing

## k6

Used for:

* concurrency testing
* throughput measurement
* stress validation

---

# 6. CORE SYSTEM DESIGN

# Submission Flow

```text id="58wtdc"
Client
  -> API Gateway
  -> PostgreSQL insert (PENDING)
  -> Redis enqueue
  -> Worker dequeue
  -> Docker execution
  -> Stream logs
  -> Save result
  -> Mark completed
```

---

# Queue Design

# Pending Queue

```text id="39gt2f"
jobs:queue:pending
```

Stores waiting jobs.

---

# Processing Queue

```text id="j8nkt1"
jobs:queue:processing:{workerId}
```

Stores jobs owned by a worker.

Critical for crash recovery.

---

# Atomic Dequeue Strategy

Use:

```text id="w9wmu0"
BRPOPLPUSH
```

Why:

* atomic movement
* prevents silent job loss
* enables worker recovery

This is a VERY important engineering detail.

---

# 7. SHARED CONTRACTS DESIGN

# Define Central Types

Examples:

* Job payload
* Execution result
* Status enums
* Event schemas

All services MUST import shared types.

No duplicated local definitions.

---

# State Machine Design

Allowed transitions ONLY:

```text id="76q7r5"
PENDING -> RUNNING

RUNNING ->
    COMPLETED
    FAILED
    TIMEOUT
```

Illegal transitions:
must throw errors.

This prevents inconsistent distributed state.

---

# 8. DATABASE DESIGN

# Main Tables

## submissions

Stores:

* id
* user_id
* language
* source_code
* status
* timestamps

---

## submission_results

Stores:

* stdout
* stderr
* exit code
* execution metrics

---

# Critical Database Constraints

# Unique Constraint

```sql id="eqmtnv"
UNIQUE(job_id)
```

Critical for idempotency.

---

# Important Indexes

```sql id="im1xll"
(user_id, status)
(created_at DESC)
```

Improves:

* pagination
* filtering
* history queries

---

# 9. EXECUTION WORKER DESIGN

MOST IMPORTANT SECTION.

---

# Worker Responsibilities

Workers:

* poll queue
* execute jobs
* stream output
* persist results
* cleanup containers
* send heartbeats

---

# Worker Lifecycle

```text id="5q6w8m"
while(true)
    dequeue job
    validate transition
    mark RUNNING
    execute sandbox
    stream logs
    persist result
    acknowledge queue
```

---

# Heartbeat System

Every 5 seconds:

```text id="e3xam0"
worker:heartbeat:{workerId}
```

TTL:
15 seconds.

This enables:
dead worker detection.

---

# 10. SANDBOX SECURITY DESIGN

MOST IMPORTANT ENGINEERING AREA.

---

# NEVER use

```text id="mzkk3t"
child_process.exec
```

Only:

```text id="00jk0m"
child_process.spawn
```

Reason:
streaming + memory safety.

---

# Mandatory Docker Security Flags

## Disable Network

```text id="shfqih"
--network none
```

Prevents outbound requests.

---

## Memory Limit

```text id="wbq1wo"
--memory=128m
```

---

## Disable Swap

```text id="uuhh39"
--memory-swap=128m
```

---

## Prevent Fork Bombs

```text id="ifg1qe"
--pids-limit=50
```

---

## Read-only Filesystem

```text id="1q92ad"
--read-only
```

---

## Non-root User

```text id="hch8hk"
--user runner
```

---

## Writable Temp Directory

```text id="1k0g03"
--tmpfs /tmp
```

---

# Sandbox Runners

Initially support ONLY:

* Python
* JavaScript

Do NOT support many languages initially.

---

# 11. REALTIME LOG STREAMING

# Architecture

Worker:

* publishes stdout/stderr chunks to Redis pub/sub

Gateway:

* subscribes
* forwards to WebSocket clients

---

# Pub/Sub Channel

```text id="5xk5ta"
jobs:streams:{jobId}
```

---

# Critical Cleanup Logic

On websocket disconnect:

* unsubscribe Redis subscriber
* close Redis connection

Otherwise:
memory leak.

---

# 12. RELIABILITY ENGINEERING

# Dead Worker Recovery

System Monitor:

* scans heartbeats
* detects dead workers
* recovers abandoned jobs

---

# Recovery Procedure

```text id="ibpdut"
detect dead worker
  -> read processing queue
  -> increment retry count
  -> requeue OR DLQ
```

---

# Retry Strategy

Max retries:

```text id="6owwh5"
3
```

Backoff:

```text id="w1z7b2"
2^retryCount seconds
```

---

# Dead Letter Queue

```text id="1ksf9v"
jobs:queue:dead-letter
```

Used for permanently failed jobs.

---

# 13. IDEMPOTENCY DESIGN

VERY IMPORTANT.

---

# Problem

Worker crashes:

* AFTER DB write
* BEFORE queue acknowledgement

Now:
job retries.

Potential duplicate writes.

---

# Solution

## Unique DB Constraint

```sql id="h3vcf7"
UNIQUE(job_id)
```

AND:

```sql id="t1wmfw"
ON CONFLICT DO NOTHING
```

Excellent distributed systems design point.

---

# 14. OBSERVABILITY DESIGN

MANDATORY.

---

# Metrics to Collect

## Queue Metrics

* queue depth
* queue latency

---

## Worker Metrics

* active workers
* busy workers
* crash count

---

## Execution Metrics

* execution latency
* timeout count
* retry count
* success/failure ratio

---

## WebSocket Metrics

* active connections
* disconnects

---

# Dashboard Panels

Grafana panels:

* queue backlog
* worker health
* retry spikes
* execution latency
* dead-letter queue volume

---

# 15. LOGGING STRATEGY

Use:

## structured JSON logging

NOT:
random console.log statements.

---

# Example Log Structure

```json id="wyklvy"
{
  "timestamp": "...",
  "workerId": "...",
  "jobId": "...",
  "event": "execution_failed",
  "retryCount": 2
}
```

This improves:

* debugging
* observability
* professionalism

---

# 16. LOAD TESTING

Use:

## k6

---

# Test Scenarios

* 100 concurrent submissions
* websocket streaming load
* worker saturation
* retry storms

---

# Measure

* throughput
* queue latency
* execution latency
* websocket stability

Never fake scale numbers.

---

# 17. REQUIRED FAILURE TESTS

MOST IMPORTANT SECTION.

These make the project believable.

---

# Test 1 — Infinite Loop

```python id="8k4u7t"
while True:
    pass
```

Expected:
timeout kill.

---

# Test 2 — Fork Bomb

```python id="g24j3l"
import os
while True:
    os.fork()
```

Expected:
pids-limit kill.

---

# Test 3 — OOM Attack

```python id="0d5gk8"
x=[]
while True:
    x.append(' '*1024*1024)
```

Expected:
OOM kill without host crash.

---

# Test 4 — Infinite Output

```python id="jsg14x"
while True:
    print("attack")
```

Expected:
streamed chunks without memory explosion.

---

# Test 5 — Worker Crash

Kill worker mid-execution.

Expected:
job recovery.

VERY important.

---

# 18. PROJECT DEVELOPMENT PHASES

# Phase 0 — Foundation

## Week 1

Setup:

* repo
* docker compose
* postgres
* redis
* prometheus
* grafana
* shared contracts

Goal:
environment working.

---

# Phase 1 — Core Pipeline

## Weeks 2–4

Build:

* submission API
* queue enqueue/dequeue
* Docker execution
* result persistence

Goal:
working end-to-end execution.

MOST IMPORTANT PHASE.

---

# Phase 2 — Streaming

## Weeks 5–6

Build:

* websocket infra
* pub/sub
* live logs

---

# Phase 3 — Reliability

## Weeks 7–8

Build:

* retries
* heartbeats
* worker recovery
* dead-letter queue

THIS is minimum resume-worthy level.

---

# Phase 4 — Scheduling

## Week 9

Build:

* least-loaded worker routing
* worker load metrics
* queue balancing

---

# Phase 5 — Observability

## Week 10

Build:

* Prometheus metrics
* Grafana dashboards
* k6 load testing

---

# 19. WHAT TO DOCUMENT

VERY IMPORTANT.

# docs/decisions/

Write:

* why Redis over RabbitMQ
* why spawn over exec
* why Docker over VM
* why BRPOPLPUSH

---

# docs/failure-analysis/

For every important bug:

* issue
* root cause
* impact
* fix
* lessons learned

This becomes:
interview gold.

---

# 20. WHAT NOT TO DO

DO NOT ADD:

* Kubernetes
* Kafka
* gRPC
* 15 microservices
* AI agents
* blockchain
* unnecessary cloud complexity

This project is already advanced enough.

---

# 21. FINAL RESUME POSITIONING

ONLY after reliability features are genuinely implemented.

Example:

> Built distributed sandboxed code execution platform using Node.js, TypeScript, Redis, PostgreSQL, Docker, and WebSockets to securely execute concurrent user submissions with atomic job queues, worker heartbeat recovery, retry orchestration, realtime stdout streaming, and Prometheus/Grafana observability.

Every word must be defendable.

---

# 22. FINAL ENGINEERING MINDSET

The project becomes impressive NOT because:

* it has many tools

But because:

* you understand failures
* you understand concurrency
* you understand tradeoffs
* you intentionally test reliability
* you can explain design decisions deeply

That is what strong backend/system candidates do.
