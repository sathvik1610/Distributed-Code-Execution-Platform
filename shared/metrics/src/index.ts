import client from 'prom-client';
import http from 'http';

// Automatically collect default metrics (CPU, Memory, etc.)
client.collectDefaultMetrics();

// Define Metrics
let queueDepthProvider: (() => Promise<number>) | null = null;

// Define Metrics
export const queueDepth = new client.Gauge({
  name: 'code_execution_queue_depth',
  help: 'Number of pending jobs in the queue',
  async collect() {
    if (queueDepthProvider) {
      try {
        const depth = await queueDepthProvider();
        this.set(depth);
      } catch (err) {
        // Silent catch to prevent prom-client scrape errors
      }
    }
  }
});

export const dequeueLatency = new client.Histogram({
  name: 'code_execution_dequeue_latency_ms',
  help: 'Latency of atomic dequeue operation in milliseconds'
});

export const activeWorkers = new client.Gauge({
  name: 'code_execution_active_workers',
  help: 'Number of running worker instances'
});

export const workerJobCounter = new client.Counter({
  name: 'code_execution_worker_jobs_total',
  help: 'Total number of jobs processed by workers',
  labelNames: ['worker_id', 'status', 'language']
});

export const executionDuration = new client.Histogram({
  name: 'code_execution_duration_ms',
  help: 'Execution duration of sandboxed code in milliseconds',
  labelNames: ['language', 'status']
});

export const executionMemory = new client.Gauge({
  name: 'code_execution_memory_used_bytes',
  help: 'Memory used by sandbox container in bytes',
  labelNames: ['language']
});

export const activeWebSockets = new client.Gauge({
  name: 'code_execution_websocket_connections_active',
  help: 'Active WebSocket log streaming connections'
});

export const websocketEvents = new client.Counter({
  name: 'code_execution_websocket_events_total',
  help: 'Total WebSocket lifecycle events',
  labelNames: ['event'] // e.g., 'connect', 'disconnect', 'error'
});

export const deadWorkerRecoveries = new client.Counter({
  name: 'code_execution_dead_worker_recoveries_total',
  help: 'Total number of jobs recovered from crashed workers'
});

export const deadLetterJobs = new client.Counter({
  name: 'code_execution_dead_letter_jobs_total',
  help: 'Total number of jobs sent to the Dead Letter Queue'
});

export const rateLimitHits = new client.Counter({
  name: 'code_execution_rate_limit_hits_total',
  help: 'Total rate limit hits'
});

/**
 * Starts a standalone HTTP server to expose Prometheus metrics
 */
export function startMetricsServer(
  port: number,
  options?: { queueDepthProvider?: () => Promise<number> }
): Promise<http.Server> {
  if (options?.queueDepthProvider) {
    queueDepthProvider = options.queueDepthProvider;
  }
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', client.register.contentType);
        res.writeHead(200);
        res.end(await client.register.metrics());
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

export { client as prometheusClient };
