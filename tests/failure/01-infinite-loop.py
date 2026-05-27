#!/usr/bin/env python3
"""
Failure Test 1: Infinite Loop
-------------------------------
Submits code that runs forever.
Expected: Worker kills the container after 5 seconds (TIMEOUT status).

This validates:
  - Docker timeout enforcement
  - Status correctly becomes TIMEOUT in DB
  - System remains stable (no memory leaks or zombie containers)
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
    print("FAILURE TEST 1: Infinite Loop")
    print("=" * 60)

    code = """
while True:
    pass  # Infinite loop — must be killed by timeout
"""

    print(f"\nSubmitting infinite loop code...")
    result = submit_job(code)
    job_id = result["jobId"]
    print(f"Job ID: {job_id}")

    print(f"\nPolling for result (should TIMEOUT in ~5s)...")
    final = poll_status(job_id)

    if final is None:
        print("FAIL: Job never reached terminal state within 30 seconds")
        sys.exit(1)

    print(f"\nFinal Status: {final['status']}")
    if final["status"] == "TIMEOUT":
        print("PASS: Infinite loop was correctly killed with TIMEOUT status")
    else:
        print(f"FAIL: Expected TIMEOUT, got {final['status']}")
        sys.exit(1)

if __name__ == "__main__":
    main()
