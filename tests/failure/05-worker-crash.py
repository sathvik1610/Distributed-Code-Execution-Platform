#!/usr/bin/env python3
"""
Failure Test 5: Worker Crash Recovery
---------------------------------------
This test validates the most critical reliability feature:
  The System Monitor detects a dead worker and recovers the orphaned job.

How it works:
  1. Submit a long-running job (10 second sleep).
  2. While it's RUNNING, find and kill the execution worker process.
  3. Wait for the System Monitor's reaper to run (default: 10s interval).
  4. The System Monitor should:
       a. Detect the dead heartbeat
       b. Find the job in jobs:queue:processing:{deadWorkerId}
       c. Re-enqueue the job in jobs:queue:pending
  5. A surviving or restarted worker picks it up and completes it.
  6. Final status should NOT be stuck in RUNNING forever.

This is the most important distributed systems test in this project.

Usage:
  # Terminal 1: run api-gateway + workers
  npm run dev:gateway
  npm run dev:worker

  # Terminal 2: run system monitor
  npm run dev:monitor

  # Terminal 3: run this test
  python3 tests/failure/05-worker-crash.py
"""

import json
import os
import signal
import subprocess
import time
import urllib.request
import sys

BASE_URL = "http://localhost:8000"

def submit_job(code, language="python"):
    payload = json.dumps({"code": code, "language": language}).encode()
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("API_KEY", "test-api-key")
    if api_key:
        headers["X-API-Key"] = api_key
    req = urllib.request.Request(
        f"{BASE_URL}/submissions",
        data=payload,
        headers=headers,
        method="POST"
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def get_job_status(job_id):
    headers = {}
    api_key = os.environ.get("API_KEY", "test-api-key")
    if api_key:
        headers["X-API-Key"] = api_key
    req = urllib.request.Request(f"{BASE_URL}/submissions/{job_id}", headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def poll_status(job_id, target_statuses, timeout=60, poll_interval=2):
    start = time.time()
    while time.time() - start < timeout:
        data = get_job_status(job_id)
        status = data.get("status")
        retry_count = data.get("retryCount", 0)
        print(f"  Status: {status} (retryCount: {retry_count})")
        if status in target_statuses:
            return data
        time.sleep(poll_interval)
    return None

def kill_worker_process():
    """Find and kill the execution-worker node process."""
    print("\nSearching for execution-worker process...")
    try:
        result = subprocess.run(
            ["pgrep", "-f", "execution-worker"],
            capture_output=True, text=True
        )
        pids = result.stdout.strip().split("\n")
        pids = [p for p in pids if p]

        if not pids:
            print("  WARNING: No execution-worker process found.")
            print("  Make sure the worker is running: npm run dev:worker")
            return False

        for pid in pids:
            print(f"  Killing execution-worker PID: {pid}")
            os.kill(int(pid), signal.SIGKILL)

        print(f"  Worker process(es) killed: {', '.join(pids)}")
        return True

    except Exception as e:
        print(f"  Error killing worker: {e}")
        return False

def main():
    print("=" * 60)
    print("FAILURE TEST 5: Worker Crash Recovery")
    print("=" * 60)
    print()
    print("WARNING: This test will KILL the execution worker process!")
    print("Make sure the System Monitor is running: npm run dev:monitor")
    print()

    # Long-running job gives us time to kill the worker mid-execution
    code = """
import time
print("Job started. Sleeping for 10 seconds...")
for i in range(10):
    time.sleep(1)
    print(f"  Second {i+1}/10...")
print("Job finished successfully!")
"""

    print("Step 1: Submitting long-running job...")
    result = submit_job(code)
    job_id = result["jobId"]
    print(f"  Job ID: {job_id}")

    print("\nStep 2: Waiting for job to reach RUNNING state...")
    running_data = poll_status(job_id, target_statuses=["RUNNING"], timeout=15)
    if running_data is None:
        print("FAIL: Job never reached RUNNING state within 15 seconds")
        sys.exit(1)
    print(f"  Job is now RUNNING!")

    print("\nStep 3: Killing the execution worker process mid-execution...")
    killed = kill_worker_process()
    if not killed:
        print("FAIL: Could not kill worker process")
        sys.exit(1)

    print("\nStep 4: Waiting for System Monitor to detect dead worker and recover job...")
    print("  (Reaper scans every 10 seconds. Waiting up to 30 seconds...)")

    # Wait for the job to either be requeued (back to PENDING) or completed again
    recovered_data = poll_status(
        job_id,
        target_statuses=["PENDING", "RUNNING", "COMPLETED", "FAILED", "TIMEOUT"],
        timeout=60,
        poll_interval=3
    )

    if recovered_data is None:
        print("FAIL: Job remained stuck in RUNNING state — System Monitor may not be working")
        sys.exit(1)

    final_status = recovered_data["status"]
    retry_count = recovered_data.get("retryCount", 0)
    print(f"\nFinal Status: {final_status}")
    print(f"Retry Count: {retry_count}")

    if final_status == "PENDING" and retry_count > 0:
        print("PASS: Orphan job was recovered by System Monitor and re-enqueued!")
        print("Note: Start a new worker instance to see it complete.")
    elif final_status == "COMPLETED":
        print("PASS: Orphan job was fully recovered and completed by a surviving worker!")
    elif final_status == "FAILED" and retry_count >= 3:
        print("PASS: Job exhausted retries and was correctly sent to Dead Letter Queue")
    else:
        print(f"FAIL: Unexpected final state. Status: {final_status}, RetryCount: {retry_count}")
        sys.exit(1)

if __name__ == "__main__":
    main()
