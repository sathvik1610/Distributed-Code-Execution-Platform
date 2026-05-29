import http from 'http';

const API_KEY = process.env.API_KEY || 'test-api-key';
const HOST = 'localhost';
const PORT = 8000;

// Payload for benchmark case (a simple Python script that executes quickly)
const PYTHON_PAYLOAD = {
  language: 'python',
  code: 'print("Benchmark run success!")'
};

// Helper for HTTP requests
function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, rawBody: body });
        }
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

// Submit a single job
async function submitJob() {
  const start = Date.now();
  const res = await request({
    hostname: HOST,
    port: PORT,
    path: '/submissions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    }
  }, PYTHON_PAYLOAD);

  if (res.status !== 201) {
    throw new Error(`Submission failed with status ${res.status}: ${JSON.stringify(res.body)}`);
  }

  return { jobId: res.body.jobId, submittedAt: start };
}

// Poll status of a single job until it completes or fails
async function waitForJob(jobId, submittedAt) {
  while (true) {
    const res = await request({
      hostname: HOST,
      port: PORT,
      path: `/submissions/${jobId}`,
      method: 'GET',
      headers: {
        'X-API-Key': API_KEY
      }
    });

    if (res.status === 200) {
      const status = res.body.status;
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'TIMEOUT') {
        const completedAt = Date.now();
        const latency = completedAt - submittedAt;
        return { jobId, status, latency };
      }
    } else {
      throw new Error(`Polling failed for job ${jobId} with status ${res.status}`);
    }

    // Poll every 100ms
    await new Promise(r => setTimeout(r, 100));
  }
}

// Calculate statistics
function calculateStats(latencies, totalDuration, count) {
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avg = sum / count;
  const p50 = latencies[Math.floor(count * 0.5)];
  const p95 = latencies[Math.floor(count * 0.95)] || latencies[count - 1];
  const p99 = latencies[Math.floor(count * 0.99)] || latencies[count - 1];
  const throughput = (count / (totalDuration / 1000)).toFixed(2);

  return {
    throughput,
    avg: avg.toFixed(1),
    p50,
    p95,
    p99,
    min: latencies[0],
    max: latencies[count - 1]
  };
}

async function runBenchmark(label, totalJobs, concurrency) {
  console.log(`\n==================================================`);
  console.log(`🚀 RUNNING BENCHMARK: ${label}`);
  console.log(`   Total Jobs: ${totalJobs} | Target Concurrency: ${concurrency}`);
  console.log(`==================================================`);

  const startTime = Date.now();
  const activeJobs = [];
  const latencies = [];
  let submittedCount = 0;
  let completedCount = 0;

  // Track progress
  const progressInterval = setInterval(() => {
    process.stdout.write(`   Progress: Submitted: ${submittedCount}/${totalJobs} | Completed: ${completedCount}/${totalJobs}\r`);
  }, 200);

  // Queue runner
  async function worker() {
    while (submittedCount < totalJobs) {
      const jobIdx = submittedCount++;
      try {
        const { jobId, submittedAt } = await submitJob();
        const result = await waitForJob(jobId, submittedAt);
        latencies.push(result.latency);
        completedCount++;
      } catch (err) {
        console.error(`\n❌ Error processing job ${jobIdx}:`, err.message);
      }
    }
  }

  // Spawn dynamic pool matching requested concurrency
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  clearInterval(progressInterval);
  const totalDuration = Date.now() - startTime;

  const stats = calculateStats(latencies, totalDuration, completedCount);

  console.log(`\n\n📈 RESULTS: ${label}`);
  console.log(`--------------------------------------------------`);
  console.log(`⚡ End-to-End Duration:  ${(totalDuration / 1000).toFixed(2)} seconds`);
  console.log(`🔄 Total Throughput:     ${stats.throughput} jobs/sec`);
  console.log(`⏱️  Average Latency:      ${stats.avg} ms`);
  console.log(`⏱️  Median (p50) Latency: ${stats.p50} ms`);
  console.log(`⏱️  Tail (p95) Latency:   ${stats.p95} ms`);
  console.log(`⏱️  Tail (p99) Latency:   ${stats.p99} ms`);
  console.log(`⏱️  Min / Max Latency:    ${stats.min} ms / ${stats.max} ms`);
  console.log(`==================================================\n`);

  return stats;
}

async function main() {
  console.log('🏁 Distributed Code Execution Platform Benchmark Suite');
  console.log('   Ensure the platform is running (npm run start:all:scaled) before starting.');
  console.log('   Using API Key:', API_KEY ? '••••••••' : 'None (Set API_KEY env var!)');

  try {
    // Warm-up run to bypass initial Docker engine/network link cold-starts
    console.log('\n🔥 Warming up the engine (1 single execution)...');
    const { jobId, submittedAt } = await submitJob();
    await waitForJob(jobId, submittedAt);
    console.log('✅ Engine warmed up!');

    // Benchmark 1: Concurrency 3 (Optimal distributed load, exactly matches 3 worker processes)
    // 9 jobs total, meaning each worker gets exactly 3 jobs sequentially
    const statsOptimal = await runBenchmark('Scenario 1: Optimal Queue Balance (Concurrency=3)', 9, 3);

    // Benchmark 2: Concurrency 10 (Slight Queue Saturation)
    // 20 jobs total, meaning jobs will queue up and wait, showcasing Redis queue distribution
    const statsSaturated = await runBenchmark('Scenario 2: Slight Queue Saturation (Concurrency=10)', 20, 10);

    console.log('🎉 Benchmark Suite Completed successfully!');
  } catch (err) {
    console.error('❌ Critical Benchmark Failure:', err.message);
  }
}

main();
