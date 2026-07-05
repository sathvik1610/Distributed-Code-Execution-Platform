# Reliability Improvements

Mechanisms implemented beyond the basic distributed queue described in [how-it-works.md](how-it-works.md).

## Redis AOF Persistence

Redis is configured with `--appendonly yes --appendfsync everysec`. Every write is synced to disk at most once per second. On Redis restart, the AOF log is replayed and the queue is restored. Maximum data loss on a hard crash: 1 second.

## Startup Queue Recovery

On every system-monitor startup, `recoverOrphanedJobsOnStartup()` runs before the first reaper scan:

1. Resets all `RUNNING` jobs to `PENDING` — any job in RUNNING state without an active worker is permanently stuck, so it is safely reset.
2. If the Redis pending queue is empty but PostgreSQL has `PENDING` jobs, re-enqueues them all — covers the Redis-restart-with-data-loss scenario even when AOF didn't flush in time.

## Distributed Reaper Lock

If multiple system-monitor replicas run simultaneously, both could detect the same dead worker and double-enqueue its jobs. A distributed lock (`SET reaper:lock {uuid} NX PX 15000`) ensures only one monitor instance runs the scan at a time. The lock is released atomically via a Lua script that checks ownership before deletion.

## Graceful Worker Shutdown

Workers handle `SIGTERM` and `SIGINT` by setting `shouldRun = false`. The current job finishes completely — including the DB transaction and processing queue acknowledgement — before the process exits. Docker Compose sends `SIGTERM` on `docker compose stop`, so workers drain cleanly.

## A Real Bug Found In This Recovery Path

Repeated runs of the worker-crash-recovery benchmark surfaced a race condition between the reaper's recovery ordering and a worker's claim logic, which silently dropped ~1 in 9 recovered jobs. Full root-cause and fix writeup: [failure-analysis/02-reaper-requeue-race-condition.md](failure-analysis/02-reaper-requeue-race-condition.md).
