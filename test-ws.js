import WebSocket from 'ws';
import http from 'http';

// 1. Submit a job with delays to api-gateway
const payload = JSON.stringify({
  code: `import time
print("Chunk 1: Starting computation...")
time.sleep(1)
print("Chunk 2: Middle of execution...")
time.sleep(1)
print("Chunk 3: Execution finished.")
`,
  language: 'python'
});

const req = http.request({
  hostname: 'localhost',
  port: 8000,
  path: '/submissions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const { jobId } = JSON.parse(body);
    console.log(`Submitted job. ID: ${jobId}`);

    // 2. Connect to WebSocket stream for this jobId
    console.log(`Connecting to WebSocket: ws://localhost:8000/stream/${jobId}`);
    const ws = new WebSocket(`ws://localhost:8000/stream/${jobId}`);

    ws.on('open', () => {
      console.log('WS Connection opened successfully');
    });

    ws.on('message', (data) => {
      const chunk = JSON.parse(data.toString());
      console.log(`[WS Stream Chunk] Type: ${chunk.type}, Data: ${chunk.data.trim()}, Time: ${new Date(chunk.timestamp).toISOString()}`);
    });

    ws.on('close', (code, reason) => {
      console.log(`WS Connection closed. Code: ${code}, Reason: ${reason}`);
      process.exit(0);
    });

    ws.on('error', (err) => {
      console.error('WS Error:', err);
    });
  });
});

req.on('error', (err) => {
  console.error('HTTP Post Error:', err);
});

req.write(payload);
req.end();
