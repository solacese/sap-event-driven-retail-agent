// ---------------------------------------------------------------------------
// PUBLIC swipe endpoints - the mobile HITL surface at /swipe. These are the ONLY
// unauthenticated write paths in the app, so they are deliberately narrow:
//   • POST /api/swipe/approval/:runId  → publish the same yes/no decision EVENT
//     to the mesh as /api/approval. The agent reacts to the event, exactly as it
//     does for the desktop rail (SAP human-in-the-loop pattern).
//   • POST /api/swipe/deal/:name       → fire a known demo scenario so a solo
//     player can stock their own deck. Restricted to the four hero scenarios.
// No credentials, arbitrary publish, or reset are exposed here, and every route
// is IP rate-limited. The SSE feed (/api/swipe/stream) is mounted in index.ts.
// ---------------------------------------------------------------------------
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { sessionManager } from '../session.js';
import { hub } from '../hub.js';
import { AGENT_TOPICS } from '../../../config/topics.js';
import { publishScenarioTrigger } from '../simulators/index.js';
import { makeLogger } from '../log.js';

const log = makeLogger('GATEWAY');

// The scenarios a public client may deal. Kept in lockstep with the web
// toolbar; anything else is rejected so the public path can't drive arbitrary
// internal scenarios (storm bursts, free-text, etc.).
const DEALABLE = new Set(['rainy-umbrella', 'ube-bundle', 'heatwave-icecream', 'viral-snack']);

// Generous enough for fast swiping (a burst of 8 + rapid decisions), tight
// enough to bound abuse of an unauthenticated write path.
const swipeLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, slow down' },
});

export function buildSwipeRouter(): Router {
  const r = Router();
  r.use(swipeLimiter);

  // Decision → mesh EVENT (identical to /api/approval, minus auth).
  r.post('/approval/:runId', (req: Request, res: Response) => {
    const bus = sessionManager.getBus();
    if (!bus) return res.status(409).json({ error: 'not connected' });
    const runId = req.params.runId;
    const raw = req.body?.decision;
    if (raw !== 'yes' && raw !== 'no') {
      return res.status(400).json({ error: "decision must be 'yes' or 'no'" });
    }
    if (!hub.hasRun(runId)) {
      return res.status(404).json({ error: 'unknown runId' });
    }
    const topic = AGENT_TOPICS.approvalDecision(runId);
    const msg = {
      topic,
      payload: { runId, decision: raw, decidedBy: 'human-swipe', decidedAt: new Date().toISOString() },
      userProperties: {
        agent: 'discount-bot',
        schemaVersion: '1',
        runId,
        emittedAt: new Date().toISOString(),
      },
    };
    bus.publish(msg);
    hub.record(msg, 'out');
    res.json({ ok: true, topic });
  });

  // Deal a known hero scenario (stocks the deck for a solo player).
  r.post('/deal/:name', async (req: Request, res: Response) => {
    const bus = sessionManager.getBus();
    if (!bus) return res.status(409).json({ error: 'not connected' });
    const name = req.params.name;
    if (!DEALABLE.has(name)) {
      return res.status(400).json({ error: 'unknown scenario' });
    }
    try {
      await publishScenarioTrigger(bus, name);
      res.json({ ok: true, scenario: name });
    } catch (e) {
      log.warn('swipe deal failed', { name, error: String(e) });
      res.status(400).json({ error: String(e) });
    }
  });

  return r;
}
