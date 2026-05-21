#!/usr/bin/env python3
"""
Failure Test 2: Fork Bomb
--------------------------
Submits code that attempts an exponential process fork.
Expected: Container killed by --pids-limit=50 (FAILED status, exit code != 0).

This validates:
  - Docker --pids-limit enforcement prevents host system damage
  - Status correctly becomes FAILED in DB
  - Worker and host remain stable
"""

import json
import time
import urllib.request
import sys

BASE_URL = "http://localhost:8000"

def submit_job(code, language="python"):
    payload = json.dumps({"code": code, "language": language}).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/submissions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def poll_status(job_id, timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        req = urllib.request.Request(f"{BASE_URL}/submissions/{job_id}")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
        status = data.get("status")
        print(f"  Status: {status}")
        if status in ("COMPLETED", "FAILED", "TIMEOUT"):
            return data
        time.sleep(1)
    return None

def main():
    print("=" * 60)
    print("FAILURE TEST 2: Fork Bomb")
    print("=" * 60)

    code = """
import os
# Classic fork bomb — exponential process spawning
while True:
    os.fork()
"""

    print(f"\nSubmitting fork bomb code...")
    result = submit_job(code)
    job_id = result["jobId"]
    print(f"Job ID: {job_id}")

    print(f"\nPolling for result (should be FAILED due to --pids-limit=50)...")
    final = poll_status(job_id, timeout=30)

    if final is None:
        print("FAIL: Job never reached terminal state within 30 seconds")
        sys.exit(1)

    print(f"\nFinal Status: {final['status']}")
    print(f"Exit Code: {final.get('exitCode')}")
    print(f"Error: {final.get('errorMessage')}")

    if final["status"] in ("FAILED", "TIMEOUT"):
        print("PASS: Fork bomb was contained by pids-limit")
    else:
        print(f"FAIL: Expected FAILED or TIMEOUT, got {final['status']}")
        sys.exit(1)

if __name__ == "__main__":
    main()
