// ---------------------------------------------------------------------------
// SSE stream endpoint. Every mesh event and agent state change is pushed here.
// ---------------------------------------------------------------------------
import type { Request, Response } from 'express';
import { hub } from '../hub.js';

export function streamHandler(req: Request, res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  hub.addClient(res);

  // Heartbeat to keep proxies from closing the idle connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* client gone */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    hub.removeClient(res);
  });
}
