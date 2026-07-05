import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function saveResultsToMarkdown(results, workerCount) {
  const now = new Date().toISOString().replace('T', ' ').split('.')[0] + ' UTC';
  const os = process.platform + ' / Node.js ' + process.version;

  const rows = results.map(({ label, jobs, concurrency, stats }) => {
    return [
      `### ${label}`,
      `- **Jobs submitted:** ${jobs}`,
      `- **Client concurrency:** ${concurrency}`,
      `- **Throughput:** ${stats.throughput} jobs/sec`,
      `- **Latency avg:** ${stats.avg} ms`,
      `- **Latency p50:** ${stats.p50} ms`,
      `- **Latency p95:** ${stats.p95} ms`,
      `- **Latency p99:** ${stats.p99} ms`,
      `- **Latency min/max:** ${stats.min} ms / ${stats.max} ms`,
    ].join('\n');
  }).join('\n\n');

  const md = `# Benchmark Results

> Run: ${now}
> Workers: ${workerCount} execution-worker replicas
> Language: Python (simple print statement — measures end-to-end latency, not execution time)
> Host: ${os}

## How to read these numbers

- **Latency** = time from HTTP submission to final \`COMPLETED\` status (includes queue wait + Docker spawn + execution + DB write)
- **Throughput** = completed jobs per second over the entire run
- **Concurrency** = number of simultaneous client goroutines submitting + waiting for results

---

${rows}

---

## What these numbers mean

- p50 is your typical user experience
- p95 is your worst-case tail — anything above this in production needs investigation
- The gap between Scenario 1 and Scenario 2 throughput shows queue saturation behaviour

## To reproduce

\`\`\`bash
npm run start:all:scaled       # 3 workers
node benchmark.js
\`\`\`
`;

  // Raw output lands in docs/ (private prep material), not the repo root.
  // BENCHMARK_RESULTS.md at the root is curated by hand (hardware specs, limitations,
  // variance notes, crash-recovery section) — this template would blow all of that away
  // if written there directly. Fold fresh numbers in manually instead.
  const outPath = path.join(__dirname, 'docs', 'latest-benchmark-raw.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`\n📄 Raw results saved to docs/latest-benchmark-raw.md`);
}

async function main() {
  console.log('🏁 Distributed Code Execution Platform Benchmark Suite');
  console.log('   Ensure the platform is running (npm run start:all:scaled) before starting.');
  console.log('   Using API Key:', API_KEY ? '••••••••' : 'None (Set API_KEY env var!)');

  const WORKER_COUNT = process.env.WORKER_COUNT || '3';

  try {
    console.log('\n🔥 Warming up (1 execution to bypass Docker cold-start)...');
    const { jobId, submittedAt } = await submitJob();
    await waitForJob(jobId, submittedAt);
    console.log('✅ Engine warmed up!');

    const results = [];

    // Scenario 1: one job per worker — baseline throughput with no queue backlog
    const s1 = await runBenchmark('Scenario 1: Optimal Queue Balance (Concurrency=3)', 9, 3);
    results.push({ label: 'Scenario 1: Optimal Queue Balance', jobs: 9, concurrency: 3, stats: s1 });

    // Scenario 2: more clients than workers — queue saturation stress test
    const s2 = await runBenchmark('Scenario 2: Queue Saturation (Concurrency=10)', 20, 10);
    results.push({ label: 'Scenario 2: Queue Saturation', jobs: 20, concurrency: 10, stats: s2 });

    // Scenario 3: sustained load — 500 jobs, concurrency=3 (matches worker count).
    // Shows steady-state throughput, p99 under continuous load, and queue distribution across a real workload.
    const s3 = await runBenchmark('Scenario 3: Sustained Load (500 jobs, Concurrency=3)', 500, 3);
    results.push({ label: 'Scenario 3: Sustained Load (500 jobs)', jobs: 500, concurrency: 3, stats: s3 });

    console.log('🎉 Benchmark Suite Completed!');
    saveResultsToMarkdown(results, WORKER_COUNT);
  } catch (err) {
    console.error('❌ Critical Benchmark Failure:', err.message);
  }
}

main();
