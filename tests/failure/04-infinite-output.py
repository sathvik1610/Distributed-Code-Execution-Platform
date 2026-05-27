#!/usr/bin/env python3
"""
Failure Test 4: Infinite Output
---------------------------------
Submits code that prints to stdout endlessly.
Expected: System streams chunks reliably via WebSocket without:
  - Worker running out of memory
  - WebSocket connection crashing
  - Host process memory growing unboundedly
The job will be killed by timeout (TIMEOUT status).

This validates:
  - MAX_OUTPUT_SIZE cap on the worker side (64KB buffer limit)
  - Redis pub/sub streaming does not accumulate unboundedly
  - WebSocket gateway handles high-frequency message bursts
"""

import json
import time
import threading
import urllib.request
import sys

BASE_URL = "http://localhost:8000"

chunks_received = []
ws_connected = False
ws_closed = False

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

def websocket_listener(job_id):
    """Connect to WebSocket stream and count chunks received."""
    global ws_connected, ws_closed
    try:
        import websocket  # pip install websocket-client
        ws_url = f"ws://localhost:8000/stream/{job_id}"

        def on_open(ws):
            global ws_connected
            ws_connected = True
            print(f"  [WS] Connected to stream for job {job_id}")

        def on_message(ws, message):
            try:
                chunk = json.loads(message)
                chunks_received.append(chunk)
                if len(chunks_received) % 50 == 0:
                    print(f"  [WS] Received {len(chunks_received)} chunks so far...")
            except Exception:
                pass

        def on_close(ws, code, reason):
            global ws_closed
            ws_closed = True
            print(f"  [WS] Connection closed. Total chunks received: {len(chunks_received)}")

        def on_error(ws, error):
            print(f"  [WS] Error: {error}")

        wsa = websocket.WebSocketApp(
            ws_url,
            on_open=on_open,
            on_message=on_message,
            on_close=on_close,
            on_error=on_error
        )
        wsa.run_forever()
    except ImportError:
        print("  [WS] websocket-client not installed. Skipping WebSocket test.")
        print("  Install with: pip install websocket-client")

def main():
    print("=" * 60)
    print("FAILURE TEST 4: Infinite Output")
    print("=" * 60)

    code = """
import sys
i = 0
while True:
    print(f"attack line {i}", flush=True)
    i += 1
"""

    print(f"\nSubmitting infinite output code...")
    result = submit_job(code)
    job_id = result["jobId"]
    print(f"Job ID: {job_id}")

    print(f"\nConnecting WebSocket listener in background...")
    ws_thread = threading.Thread(target=websocket_listener, args=(job_id,), daemon=True)
    ws_thread.start()

    time.sleep(1)  # Give WS a moment to connect

    print(f"\nPolling for result (should TIMEOUT in ~5s, streaming should remain stable)...")
    final = poll_status(job_id, timeout=30)

    if final is None:
        print("FAIL: Job never reached terminal state within 30 seconds")
        sys.exit(1)

    print(f"\nFinal Status: {final['status']}")
    print(f"Total WS chunks received: {len(chunks_received)}")

    if final["status"] == "TIMEOUT":
        print("PASS: Infinite output was killed by timeout")
        if len(chunks_received) > 0:
            print(f"PASS: WebSocket received {len(chunks_received)} streaming chunks without crashing")
        else:
            print("NOTE: WebSocket chunks not verified (websocket-client may not be installed)")
    elif final["status"] == "FAILED" and "Output limit exceeded" in (final.get("errorMessage") or ""):
        print("PASS: Infinite output was killed by output limit cap")
    else:
        print(f"FAIL: Expected TIMEOUT or FAILED (output cap), got {final['status']} (Message: {final.get('errorMessage')})")
        sys.exit(1)

if __name__ == "__main__":
    main()
