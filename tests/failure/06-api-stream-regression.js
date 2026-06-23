#!/usr/bin/env node
import http from 'http';
import WebSocket from 'ws';

const BASE_HOST = process.env.BASE_HOST || 'localhost';
const BASE_PORT = Number(process.env.BASE_PORT || '8000');
const API_KEY = process.env.API_KEY || 'test-api-key';

function request(path, { method = 'GET', body, apiKey = API_KEY, headers = {} } = {}) {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: BASE_HOST,
      port: BASE_PORT,
      path,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function submitAndWait(code, language = 'javascript', timeoutMs = 30000) {
  const submit = await request('/submissions', { method: 'POST', body: { code, language } });
  if (submit.statusCode !== 201) throw new Error(`submission failed ${submit.statusCode}: ${submit.body}`);
  const { jobId } = JSON.parse(submit.body);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const statusRes = await request(`/submissions/${jobId}`);
    if (statusRes.statusCode !== 200) continue;
    const status = JSON.parse(statusRes.body);
    if (['COMPLETED', 'FAILED', 'TIMEOUT'].includes(status.status)) return status;
  }
  throw new Error(`job ${jobId} did not reach terminal status`);
}

function replayWebSocket(jobId, apiKey = API_KEY) {
  const messages = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${BASE_HOST}:${BASE_PORT}/stream/${jobId}`, apiKey ? { headers: { 'X-API-Key': apiKey } } : undefined);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('websocket replay timed out'));
    }, 5000);
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('close', () => {
      clearTimeout(timer);
      resolve(messages);
    });
    ws.on('error', reject);
  });
}

async function expectUnauthenticatedStreamRejected() {
  const response = await request('/stream/not-a-real-job', { apiKey: null });
  if (response.statusCode !== 401) {
    throw new Error(`expected 401 for unauthenticated stream, got ${response.statusCode}`);
  }
}

async function main() {
  console.log('Test 6: API + WebSocket regression checks');

  const invalidPage = await request('/submissions?page=0');
  if (invalidPage.statusCode !== 400) throw new Error(`expected invalid page to return 400, got ${invalidPage.statusCode}`);
  console.log('  PASS: invalid pagination returns 400');

  await expectUnauthenticatedStreamRejected();
  console.log('  PASS: unauthenticated WebSocket stream is rejected');

  const replayJob = await submitAndWait('console.log("replay-one"); console.log("replay-two");');
  if (replayJob.status !== 'COMPLETED') throw new Error(`expected replay job completed, got ${replayJob.status}`);
  const replayMessages = await replayWebSocket(replayJob.jobId);
  const replayStdout = replayMessages.filter((m) => m.type === 'stdout').map((m) => m.data).join('');
  const sawComplete = replayMessages.some((m) => m.type === 'system' && m.data === 'EXECUTION_COMPLETE');
  if (!replayStdout.includes('replay-one') || !replayStdout.includes('replay-two') || !sawComplete) {
    throw new Error('late WebSocket replay missed stdout or completion marker');
  }
  console.log('  PASS: late WebSocket replay returns stdout and completion marker');

  const outputJob = await submitAndWait('let i = 0; while (true) console.log("attack line " + i++);');
  if (outputJob.status !== 'FAILED' || outputJob.streamOutputLimitExceeded !== true || outputJob.outputTruncated !== true) {
    throw new Error(`expected output cap flags on infinite output job, got ${JSON.stringify({
      status: outputJob.status,
      outputTruncated: outputJob.outputTruncated,
      streamOutputLimitExceeded: outputJob.streamOutputLimitExceeded,
      errorMessage: outputJob.errorMessage,
    })}`);
  }
  console.log('  PASS: infinite output sets persisted truncation and stream cap flags');

  console.log('All API/WebSocket regression checks passed');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});