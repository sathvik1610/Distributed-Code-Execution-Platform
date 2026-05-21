# Decision: Redis over RabbitMQ (or Kafka)

**Date**: 2026-05-21  
**Status**: Accepted  
**Component**: Job Queue and Pub/Sub

---

## Context

We needed a message broker to handle:
1. A distributed job queue (submission → worker)
2. Real-time log streaming (worker → gateway → WebSocket clients)

The candidates were: **Redis**, **RabbitMQ**, and **Kafka**.

---

## Decision

We chose **Redis** for both the queue and pub/sub.

---

## Reasons

### 1. Single Dependency for Two Concerns

Redis handles both the queue (`BRPOPLPUSH`) and pub/sub (`PUBLISH`/`SUBSCRIBE`) in one system.

Using RabbitMQ or Kafka would require a separate Redis instance for the pub/sub log streaming anyway, since:
- Kafka is not suitable for real-time low-latency pub/sub at this scale.
- RabbitMQ's topic routing is overkill for a linear job queue with a single consumer group.

### 2. Atomic BRPOPLPUSH

Redis provides `BRPOPLPUSH` (and the newer `BLMOVE`), which atomically pops a job from one list and pushes it onto another **in a single operation**. This is the cornerstone of our crash-safe queue design.

RabbitMQ's ack/nack system is comparable but requires significantly more client-side configuration and does not have the processing-list model we use for dead worker detection.

### 3. Simplicity at This Scale

This platform targets a workload of hundreds of concurrent submissions, not millions. Redis handles that comfortably in-process.

Kafka's overhead (ZooKeeper/KRaft, topic partitioning, consumer groups) is real engineering complexity that adds no value for this scope.

### 4. Operational Familiarity

Redis is simpler to run, easier to inspect (`redis-cli`), and has a shallower learning curve. When debugging a distributed system, simple infrastructure is a virtue.

---

## Tradeoffs

| Concern | Impact |
|---|---|
| Message persistence | Redis is in-memory. If Redis crashes, unprocessed jobs are lost. Mitigated by: the DB already stores submission state; the Monitor can requeue RUNNING jobs on restart. |
| Fan-out at scale | Redis pub/sub does not scale to millions of subscribers. At this project's scale, it is more than sufficient. |
| No built-in DLQ | Redis has no native DLQ concept. We implement it manually with a `jobs:queue:dead-letter` list. |

---

## Conclusion

Redis is the right choice for this project: it provides atomic operations, pub/sub, and heartbeat TTL support — all in one dependency. The tradeoffs are acceptable given the project scope.
