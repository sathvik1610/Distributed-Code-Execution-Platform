/**
 * k6 Load Test — Distributed Code Execution Platform
 *
 * Scenarios tested:
 *   1. smoke        — 1 VU, 30s: basic sanity check
 *   2. concurrent   — 100 VUs, 2min: concurrency and queue saturation
 *   3. stress       — ramp to 200 VUs: find the breaking point
 *   4. websocket    — 50 VUs streaming real-time logs
 *
 * Usage:
 *   k6 run --scenario concurrent infra/k6-load-test.js
 *   k6 run infra/k6-load-test.js
 *
 * Metrics reported:
 *   - http_req_duration p95 < 2000ms
 *   - http_req_failed < 1%
 *   - submission_success_rate > 95%
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ── Custom Metrics ─────────────────────────────────────────────────────────

const submissionSuccessRate = new Rate('submission_success_rate');
const wsStreamReceived = new Counter('ws_stream_chunks_received');
const submissionLatency = new Trend('submission_latency_ms', true);
const completionLatency = new Trend('completion_latency_ms', true);

// ── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const API_KEY = __ENV.API_KEY || '';

if (!API_KEY) {
  console.warn('Warning: API_KEY not set. Set it with: k6 run -e API_KEY=your-secret-key infra/k6-load-test.js');
}

// ── Test Scenarios ─────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // Smoke test: minimal load to verify system is working
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      tags: { scenario: 'smoke' }
    },

    // Concurrent submission load: 100 users simultaneously
    concurrent_submissions: {
      executor: 'constant-vus',
      vus: 100,
      duration: '2m',
      startTime: '30s',
      tags: { scenario: 'concurrent' }
    },

    // Stress test: ramp from 0 to 200 VUs to find saturation point
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 200 },
        { duration: '30s', target: 0 }
      ],
      startTime: '3m',
      tags: { scenario: 'stress' }
    },

    // WebSocket streaming: 50 users streaming live execution logs
    websocket_streaming: {
      executor: 'constant-vus',
      vus: 50,
      duration: '2m',
      startTime: '30s',
      exec: 'testWebSocketStreaming',
      tags: { scenario: 'websocket' }
    }
  },

  thresholds: {
    // HTTP submission must be under 2 seconds at P95
    http_req_duration: ['p(95)<2000'],
    // Less than 1% failure rate
    http_req_failed: ['rate<0.01'],
    // Custom metric: 95%+ submissions must succeed
    submission_success_rate: ['rate>0.95'],
    // WebSocket stream chunks must be received
    ws_stream_chunks_received: ['count>0']
  }
};

// ── Scenario: Code Submission + Poll for Completion ───────────────────────

export default function testCodeSubmission() {
  // Alternate between Python and JavaScript
  const language = Math.random() > 0.5 ? 'python' : 'javascript';

  const code = language === 'python'
    ? `print("Hello from Python!")\nresult = sum(range(100))\nprint(f"Sum: {result}")`
    : `console.log("Hello from JavaScript!");\nconst result = Array.from({length: 100}, (_, i) => i).reduce((a, b) => a + b, 0);\nconsole.log("Sum:", result);`;

  const payload = JSON.stringify({ code, language });

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-API-Key': API_KEY
  };

  // ── Submit Job ─────────────────────────────────────────────────────────
  const submitStart = Date.now();
  const submitRes = http.post(`${BASE_URL}/submissions`, payload, { headers });
  submissionLatency.add(Date.now() - submitStart);

  const submitOk = check(submitRes, {
    'submission: status 201': (r) => r.status === 201,
    'submission: has jobId': (r) => {
      try {
        return JSON.parse(r.body).jobId !== undefined;
      } catch { return false; }
    },
    'submission: status is PENDING': (r) => {
      try {
        return JSON.parse(r.body).status === 'PENDING';
      } catch { return false; }
    }
  });

  submissionSuccessRate.add(submitOk);

  if (!submitOk) {
    sleep(1);
    return;
  }

  const { jobId } = JSON.parse(submitRes.body);

  // ── Poll for Completion ─────────────────────────────────────────────────
  const maxPollAttempts = 20;
  const pollStart = Date.now();

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    sleep(0.5);

    const statusRes = http.get(`${BASE_URL}/submissions/${jobId}`, { headers });

    if (statusRes.status !== 200) {
      continue;
    }

    let body;
    try {
      body = JSON.parse(statusRes.body);
    } catch {
      continue;
    }

    if (['COMPLETED', 'FAILED', 'TIMEOUT'].includes(body.status)) {
      completionLatency.add(Date.now() - pollStart);

      check(statusRes, {
        'completion: terminal status reached': () => true,
        'completion: has stdout or stderr': () => body.stdout !== undefined || body.stderr !== undefined
      });

      break;
    }
  }

  sleep(Math.random() * 0.5);
}

// ── Scenario: WebSocket Streaming ─────────────────────────────────────────

export function testWebSocketStreaming() {
  // Submit a job with delays so streaming has something to send
  const code = `import time\nprint("Stream Start")\nfor i in range(5):\n    time.sleep(0.5)\n    print(f"Chunk {i+1}")\nprint("Stream End")`;
  const payload = JSON.stringify({ code, language: 'python' });
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY };

  const submitRes = http.post(`${BASE_URL}/submissions`, payload, { headers });
  if (submitRes.status !== 201) {
    return;
  }

  let jobId;
  try {
    jobId = JSON.parse(submitRes.body).jobId;
  } catch {
    return;
  }

  // Connect to WebSocket stream for this job
  const wsUrl = `ws://localhost:8000/stream/${jobId}`;

  const response = ws.connect(wsUrl, { headers: { 'X-API-Key': API_KEY } }, function(socket) {
    socket.on('open', () => {
      check(socket, { 'ws: connection opened': () => true });
    });

    socket.on('message', (data) => {
      wsStreamReceived.add(1);
      try {
        const chunk = JSON.parse(data);
        check(chunk, {
          'ws: chunk has type': (c) => ['stdout', 'stderr', 'system'].includes(c.type),
          'ws: chunk has data': (c) => typeof c.data === 'string',
          'ws: chunk has timestamp': (c) => typeof c.timestamp === 'number'
        });
      } catch { }
    });

    socket.on('error', (e) => {
      check(null, { 'ws: no error': () => false });
    });

    // Keep connection open for 10 seconds (sufficient for the test job to complete)
    socket.setTimeout(() => {
      socket.close();
    }, 10000);
  });

  check(response, { 'ws: connected without error': (r) => r && r.status === 101 });

  sleep(1);
}

// ── Scenario: Retry Storm Simulation ──────────────────────────────────────
// Submits intentionally broken code to trigger retries and verify system stability

export function testRetryStorm() {
  const badCode = `raise Exception("Intentional failure for retry testing")`;
  const payload = JSON.stringify({ code: badCode, language: 'python' });
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY };

  const submitRes = http.post(`${BASE_URL}/submissions`, payload, { headers });
  check(submitRes, { 'retry_storm: submission accepted': (r) => r.status === 201 });

  sleep(2);
}
