#!/usr/bin/env python3
"""
Failure Test 5: Worker Crash Recovery
-------------------------------------
Submits a short job, finds the worker container that claimed it, kills that
container, and verifies the System Monitor recovers the orphaned job.

Expected: retryCount increments and the job eventually reaches COMPLETED.
Requires the Docker Compose stack with multiple execution-worker replicas.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")
API_KEY = os.environ.get("API_KEY", "test-api-key")


def api_headers(json_body=False):
    headers = {"X-API-Key": API_KEY}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def submit_job(code, language="python"):
    payload = json.dumps({"code": code, "language": language}).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/submissions",
        data=payload,
        headers=api_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def get_job_status(job_id):
    req = urllib.request.Request(f"{BASE_URL}/submissions/{job_id}", headers=api_headers())
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def run_cmd(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def redis_cli(*args):
    return run_cmd(["docker", "exec", "execution_redis", "redis-cli", *args])


def find_processing_queue(job_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        keys = [k for k in redis_cli("KEYS", "jobs:queue:processing:*").splitlines() if k.strip()]
        for key in keys:
            items = [x for x in redis_cli("LRANGE", key, "0", "-1").splitlines() if x.strip()]
            if any(job_id in item for item in items):
                return key
        time.sleep(1)
    return None


def map_worker_id_to_container(worker_id):
    containers = run_cmd([
        "docker", "ps", "--filter", "name=infra-execution-worker", "--format", "{{.Names}}"
    ]).splitlines()
    for name in containers:
        logs = run_cmd(["docker", "logs", "--tail", "300", name])
        if worker_id in logs:
            return name
    return None


def ensure_worker_scale():
    # If this test killed a worker, put the demo stack back into its expected shape.
    subprocess.run([
        "docker", "compose", "-f", "infra/docker-compose.yml", "-f", "infra/docker-compose.services.yml",
        "up", "-d", "--scale", "execution-worker=3"
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def main():
    print("=" * 60)
    print("FAILURE TEST 5: Worker Crash Recovery")
    print("=" * 60)

    code = """
import time
print("recoverable job start", flush=True)
for i in range(3):
    time.sleep(1)
    print(f"tick {i + 1}", flush=True)
print("recoverable job done", flush=True)
"""

    print("\nStep 1: Submitting recoverable job...")
    job_id = submit_job(code)["jobId"]
    print(f"  Job ID: {job_id}")

    print("\nStep 2: Finding the worker that claimed the job...")
    processing_queue = find_processing_queue(job_id)
    if not processing_queue:
        print("FAIL: Could not find job in any worker processing queue")
        sys.exit(1)
    worker_id = processing_queue.replace("jobs:queue:processing:", "")
    print(f"  Worker ID: {worker_id}")

    container = map_worker_id_to_container(worker_id)
    if not container:
        print("FAIL: Could not map workerId to a Docker worker container")
        sys.exit(1)
    print(f"  Container: {container}")

    print("\nStep 3: Killing that worker container mid-execution...")
    try:
        run_cmd(["docker", "kill", container])
        print(f"  Killed: {container}")

        print("\nStep 4: Waiting for reaper recovery and final completion...")
        recovered = False
        deadline = time.time() + 90
        while time.time() < deadline:
            status = get_job_status(job_id)
            current = status.get("status")
            retry_count = status.get("retryCount", 0)
            print(f"  Status: {current} (retryCount: {retry_count})")
            if retry_count > 0:
                recovered = True
            if recovered and current in ("COMPLETED", "FAILED", "TIMEOUT"):
                if current == "COMPLETED" and retry_count > 0:
                    print("\nPASS: Worker crash was detected, job was requeued, and retry completed successfully")
                    return
                print(f"FAIL: Job recovered but ended as {current}: {status.get('errorMessage')}")
                sys.exit(1)
            time.sleep(2)

        print("FAIL: Job did not recover to a terminal state within 90 seconds")
        sys.exit(1)
    finally:
        ensure_worker_scale()


if __name__ == "__main__":
    main()