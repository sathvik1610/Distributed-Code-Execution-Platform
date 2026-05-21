import http from 'http';

const API_URL = 'http://localhost:8000/submissions';

// 3 Types of payloads to test different system boundaries
const payloads = [
  // 1. Success Payload
  {
    name: 'Success Case',
    data: {
      code: 'print("Execution successful!")',
      language: 'python'
    }
  },
  // 2. Timeout Payload
  {
    name: 'Infinite Loop (Timeout)',
    data: {
      code: 'import time\nwhile True:\n    time.sleep(1)',
      language: 'python'
    }
  },
  // 3. Memory Limit (OOM) Payload
  {
    name: 'Memory Hog (OOM)',
    data: {
      code: 'a = []\nwhile True:\n    a.append("x" * 10**6)',
      language: 'python'
    }
  }
];

// Helper to make async HTTP POST requests
function submitJob(payload) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(payload.data);
    
    const req = http.request({
      hostname: 'localhost',
      port: 8000,
      path: '/submissions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ success: res.statusCode === 201, jobId: parsed.jobId, name: payload.name });
        } catch (e) {
          resolve({ success: false, error: 'JSON Parse Error', name: payload.name });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message, name: payload.name });
    });

    req.write(postData);
    req.end();
  });
}

// Main execution: submits 50 jobs concurrently
async function runLoadTest() {
  console.log('🏁 Starting Load Test: Submitting 50 concurrent jobs...');
  const promises = [];

  for (let i = 0; i < 50; i++) {
    // Pick a random payload type (Success, Timeout, or OOM)
    const randomPayload = payloads[Math.floor(Math.random() * payloads.length)];
    promises.push(submitJob(randomPayload));
  }

  const startTime = Date.now();
  const results = await Promise.all(promises);
  const duration = Date.now() - startTime;

  const successfulSubmissions = results.filter(r => r.success).length;
  console.log(`\n✅ Ingestion Phase Complete in ${duration}ms!`);
  console.log(`   Submitted successfully: ${successfulSubmissions} / 50`);
  
  console.log('\nProcessing details:');
  console.log(`   - Success Cases: ${results.filter(r => r.name === 'Success Case').length}`);
  console.log(`   - Timeout Cases: ${results.filter(r => r.name === 'Infinite Loop (Timeout)').length}`);
  console.log(`   - OOM Cases:     ${results.filter(r => r.name === 'Memory Hog (OOM)').length}`);

  console.log('\n📈 Now open your Grafana Dashboard (http://localhost:3000) to see the metrics update in real-time!');
}

runLoadTest();
