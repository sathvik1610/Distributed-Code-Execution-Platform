import type { StreamChunk } from '@code-execution/contracts';

export interface JobStreamHandlers {
  onChunk: (chunk: StreamChunk) => void;
  onClose: () => void;
  /** Fires if the socket never reaches OPEN, or errors before any message arrives. */
  onUnavailable: () => void;
}

/**
 * Opens the /stream/:jobId WebSocket. Scheme is computed from the current
 * page, never hardcoded — plain ws:// in local dev, wss:// once this sits
 * behind Caddy's TLS termination in Phase 2/3.
 */
export function openJobStream(jobId: string, handlers: JobStreamHandlers): () => void {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${scheme}//${location.host}/stream/${encodeURIComponent(jobId)}`);

  let receivedAnyMessage = false;

  socket.addEventListener('message', (event) => {
    receivedAnyMessage = true;
    try {
      handlers.onChunk(JSON.parse(event.data) as StreamChunk);
    } catch {
      // Malformed frame — ignore rather than crash the UI.
    }
  });

  socket.addEventListener('close', () => {
    handlers.onClose();
  });

  socket.addEventListener('error', () => {
    if (!receivedAnyMessage) handlers.onUnavailable();
  });

  return () => socket.close();
}
