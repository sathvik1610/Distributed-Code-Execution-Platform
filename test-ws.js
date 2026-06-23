import WebSocket from 'ws';
import http from 'http';

// 1. Submit a job with delays to api-gateway
const payload = JSON.stringify({
  code: `
console.log("Running in Node.js container!");
const items = [1, 2, 3, 4, 5];
const doubled = items.map(x => x * 2);
console.log("Result:", doubled);
`,
  language: 'javascript'


});

const headers = {
  'Content-Type': 'application/json',
  'Content-Length': Buffer.byteLength(payload)
};
if (process.env.API_KEY) {
  headers['X-API-Key'] = process.env.API_KEY;
}

const req = http.request({
  hostname: 'localhost',
  port: 8000,
  path: '/submissions',
  method: 'POST',
  headers
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const { jobId } = JSON.parse(body);
    console.log(`Submitted job. ID: ${jobId}`);

    // 2. Connect to WebSocket stream for this jobId
    console.log(`Connecting to WebSocket: ws://localhost:8000/stream/${jobId}`);
    const wsHeaders = process.env.API_KEY ? { headers: { 'X-API-Key': process.env.API_KEY } } : undefined;
    const ws = new WebSocket(`ws://localhost:8000/stream/${jobId}`, wsHeaders);

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
