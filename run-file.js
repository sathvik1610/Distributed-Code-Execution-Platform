import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import http from 'http';

// 1. Get file path from command line arguments
const filePath = process.argv[2];
if (!filePath) {
  console.error('\x1b[31mError: No file specified.\x1b[0m');
  console.log('\nUsage:\n  node run-file.js <path-to-file>\n');
  console.log('Examples:\n  node run-file.js my-code.py\n  node run-file.js script.js\n');
  process.exit(1);
}

// 2. Read the file
let code;
try {
  code = fs.readFileSync(filePath, 'utf-8');
} catch (err) {
  console.error(`\x1b[31mError reading file: ${err.message}\x1b[0m`);
  process.exit(1);
}

// 3. Determine language from file extension
const ext = path.extname(filePath).toLowerCase();
let language;
if (ext === '.py') {
  language = 'python';
} else if (ext === '.js') {
  language = 'javascript';
} else {
  console.error(`\x1b[31mError: Unsupported file extension "${ext}"\x1b[0m`);
  console.log('Supported extensions:\n  - .py (Python)\n  - .js (JavaScript)\n');
  process.exit(1);
}

console.log(`\x1b[36mExecuting ${path.basename(filePath)} (${language}) on platform...\x1b[0m`);

// 4. Submit to gateway
const payload = JSON.stringify({ code, language });

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
    try {
      const response = JSON.parse(body);
      if (res.statusCode !== 200 && res.statusCode !== 201) {
        console.error(`\x1b[31mError submitting job (HTTP ${res.statusCode}):\x1b[0m`, response.message || body);
        process.exit(1);
      }
      
      const { jobId } = response;
      console.log(`\x1b[32mSubmitted job. ID: ${jobId}\x1b[0m`);
      console.log(`\x1b[33m--- Stream Output ---\x1b[0m`);

      // 5. Connect to WebSocket stream
      const ws = new WebSocket(`ws://localhost:8000/stream/${jobId}`);

      ws.on('message', (data) => {
        const chunk = JSON.parse(data.toString());
        if (chunk.type === 'stdout') {
          process.stdout.write(chunk.data);
        } else if (chunk.type === 'stderr') {
          process.stderr.write(chunk.data);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`\x1b[33m---------------------\x1b[0m`);
        process.exit(0);
      });

      ws.on('error', (err) => {
        console.error('\n\x1b[31mWebSocket Error:\x1b[0m', err.message);
        process.exit(1);
      });
    } catch (err) {
      console.error('\x1b[31mFailed to parse response body:\x1b[0m', err.message);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error('\n\x1b[31mConnection failed!\x1b[0m Make sure the gateway is running (`npm run start:all`).');
  console.error('Detail:', err.message);
  process.exit(1);
});

req.write(payload);
req.end();
