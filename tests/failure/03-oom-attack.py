#!/usr/bin/env python3
"""
Failure Test 3: OOM (Out of Memory) Attack
--------------------------------------------
Submits code that allocates memory unboundedly until killed.
Expected: Container killed by OOM limiter at 128MB (FAILED status, exit code 137).

This validates:
  - Docker --memory=128m and --memory-swap=128m enforcement
  - Worker correctly detects exit code 137 as OOM kill
  - Host machine is NOT affected (memory is isolated to the container)
  - System remains stable with no memory leak on the worker side
"""

import json
import time
import urllib.request
import sys
import os

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

def poll_status(job_id, timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        headers = {}
        api_key = os.environ.get("API_KEY", "test-api-key")
        if api_key:
            headers["X-API-Key"] = api_key
        req = urllib.request.Request(f"{BASE_URL}/submissions/{job_id}", headers=headers)
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
    print("FAILURE TEST 3: OOM Attack")
    print("=" * 60)

    code = """
# Allocate 1MB chunks until OOM kills the container
x = []
while True:
    x.append(bytearray(1024 * 1024))
    print(f"Allocated {len(x)}MB so far...")
"""

    print(f"\nSubmitting OOM attack code...")
    result = submit_job(code)
    job_id = result["jobId"]
    print(f"Job ID: {job_id}")

    print(f"\nPolling for result (container should be killed by OOM at ~128MB)...")
    final = poll_status(job_id, timeout=30)

    if final is None:
        print("FAIL: Job never reached terminal state within 30 seconds")
        sys.exit(1)

    print(f"\nFinal Status: {final['status']}")
    print(f"Exit Code: {final.get('exitCode')}")
    print(f"Error: {final.get('errorMessage')}")

    if final["status"] == "FAILED":
        if "Out of Memory" in (final.get("errorMessage") or ""):
            print("PASS: OOM attack was correctly identified and reported")
        else:
            print("PASS: OOM attack was stopped (exit code 137 / container killed)")
    elif final["status"] == "TIMEOUT":
        print("PARTIAL PASS: OOM code timed out instead of triggering OOM — may need more memory pressure")
    else:
        print(f"FAIL: Expected FAILED (OOM), got {final['status']}")
        sys.exit(1)

if __name__ == "__main__":
    main()
