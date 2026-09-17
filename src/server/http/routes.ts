// ---------------------------------------------------------------------------
// API routes. Broker creds accepted over POST, held in memory only, never
// returned by any GET and never logged. Approval Yes/No publishes a decision
// EVENT to the mesh; the agent reacts to that event, not to this HTTP call.
// ---------------------------------------------------------------------------
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, issueCookie, checkPassword } from './auth.js';
import { sessionManager } from '../session.js';
import { hub } from '../hub.js';
import { agent } from '../agent/discountBot.js';
import { getResolvedProvider, setDisplayModel } from '../llm/index.js';
import { AGENT_TOPICS } from '../../../config/topics.js';
import { publishScenarioTrigger, publishTrigger, publishFreetextScenario } from '../simulators/index.js';
import { synthesiseScenario } from '../simulators/freetext.js';
import { makeLogger } from '../log.js';

const log = makeLogger('GATEWAY');
const __dirname = dirname(fileURLToPath(import.meta.url));

// Upper bound on free-text scenario prompts. Generous for real prose, but caps
// pathological payloads before they reach the interpreter.
const FREETEXT_MAX_LEN = 2000;

const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again in a minute' },
});

export function buildRouter(): Router {
  const r = Router();

  // --- login (no auth) ---
  r.post('/login', loginLimiter, (req: Request, res: Response) => {
    if (checkPassword(req.body?.password)) {
      issueCookie(res);
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'invalid password' });
  });

  // Everything below requires auth.
  r.use(requireAuth);

  // --- session (never returns credentials) ---
  r.get('/session', (_req, res) => {
    res.json({
      connected: sessionManager.isConnected(),
      info: sessionManager.info(),
      brokerKind: sessionManager.brokerKind(),
    });
  });

  r.post('/session/connect', async (req: Request, res: Response) => {
    try {
      if (req.body?.mock === true) {
        await sessionManager.connectMock();
        return res.json({ ok: true, brokerKind: 'mock', info: sessionManager.info() });
      }
      const { url, vpn, username, password, triggerTopic } = req.body ?? {};
      if (!url || !vpn || !username) {
        return res.status(400).json({ error: 'url, vpn and username are required' });
      }
      const trigger = typeof triggerTopic === 'string' ? triggerTopic.trim() : undefined;
      await sessionManager.connectSolace(
        { url, vpn, username, password: password ?? '' },
        trigger || undefined,
      );
      res.json({ ok: true, brokerKind: 'solace', info: sessionManager.info() });
    } catch (e) {
      // Never leak credential material in the error.
      log.error('connect failed', { error: String(e).replace(/password[^,}]*/gi, 'password=***') });
      res.status(502).json({ error: 'broker connect failed', detail: String(e).slice(0, 200) });
    }
  });

  r.post('/session/disconnect', async (_req, res) => {
    await sessionManager.teardown();
    res.json({ ok: true });
  });

  // --- avatar (swappable without rebuild) ---
  r.get('/avatar', async (_req, res) => {
    try {
      const path = join(__dirname, '../../../assets/discount-bot-avatar.json');
      const json = await readFile(path, 'utf8');
      res.type('application/json').send(json);
    } catch (e) {
      res.status(404).json({ error: 'avatar not found', detail: String(e) });
    }
  });

  // --- approval: publish the decision EVENT onto the mesh ---
  r.post('/approval/:runId', (req: Request, res: Response) => {
    const bus = sessionManager.getBus();
    if (!bus) return res.status(409).json({ error: 'not connected' });
    const runId = req.params.runId;
    // Enforce a strict decision enum: silently coercing an unknown value to
    // "no" turns a malformed request into an accidental rejection.
    const raw = req.body?.decision;
    if (raw !== 'yes' && raw !== 'no') {
      return res.status(400).json({ error: "decision must be 'yes' or 'no'" });
    }
    // Reject decisions for runs the agent never started.
    if (!hub.hasRun(runId)) {
      return res.status(404).json({ error: 'unknown runId' });
    }
    const decision = raw;
    const topic = AGENT_TOPICS.approvalDecision(runId);
    const msg = {
      topic,
      payload: { runId, decision, decidedBy: 'human', decidedAt: new Date().toISOString() },
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

  // --- budget top-up approval ---
  // Distinct from campaign approval: this human-in-the-loop card appears when
  // the operating budget bar hits 100%. Approving resets the bar and resumes any
  // runs held while it was exhausted. Handled in-process (a UI→server control),
  // not a mesh round trip.
  r.post('/budget/:topUpId', (req: Request, res: Response) => {
    const raw = req.body?.decision;
    if (raw !== 'yes' && raw !== 'no') {
      return res.status(400).json({ error: "decision must be 'yes' or 'no'" });
    }
    agent.onBudgetDecision(raw, req.params.topUpId);
    res.json({ ok: true });
  });

  // --- scenarios ---
  r.post('/scenario/:name', async (req: Request, res: Response) => {
    const bus = sessionManager.getBus();
    if (!bus) return res.status(409).json({ error: 'not connected' });
    const name = req.params.name;
    try {
      await publishScenarioTrigger(bus, name);
      res.json({ ok: true, scenario: name });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  // Free-text scenario: interpret the prompt into a world patch (LLM when
  // configured, keyword heuristic otherwise) and run it.
  r.post('/scenario-freetext', async (req: Request, res: Response) => {
    const bus = sessionManager.getBus();
    if (!bus) return res.status(409).json({ error: 'not connected' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > FREETEXT_MAX_LEN) {
      return res.status(400).json({ error: `text too long (max ${FREETEXT_MAX_LEN} chars)` });
    }
    try {
      const { patch, source } = await synthesiseScenario(text);
      publishFreetextScenario(bus, patch);
      res.json({ ok: true, source });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  // --- custom event publisher ---
  r.post('/publish', (req: Request, res: Response) => {
    const bus = sessionManager.getBus();
    if (!bus) return res.status(409).json({ error: 'not connected' });
    const { topic, payload } = req.body ?? {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'topic is required' });
    }
    const msg = {
      topic,
      payload: payload ?? {},
      userProperties: { agent: 'custom', schemaVersion: '1', emittedAt: new Date().toISOString() },
    };
    bus.publish(msg);
    hub.record(msg, 'out');
    res.json({ ok: true });
  });

  // --- reset ---
  r.post('/reset', async (_req, res) => {
    await sessionManager.reset();
    res.json({ ok: true });
  });

  // --- replay: republish the last trigger (default hero) ---
  r.post('/replay', async (_req, res) => {
    const bus = sessionManager.getBus();
    if (!bus) return res.status(409).json({ error: 'not connected' });
    publishTrigger(bus);
    res.json({ ok: true });
  });

  // --- llm info ---
  r.get('/llm', (_req, res) => {
    res.json(getResolvedProvider());
  });

  // Choose the model surfaced to the UI. Cosmetic for the demo: the underlying
  // provider dispatch is unchanged, but the label broadcast to every client is.
  r.post('/llm/model', (req: Request, res: Response) => {
    const model = typeof req.body?.model === 'string' ? req.body.model : '';
    setDisplayModel(model || null);
    const info = getResolvedProvider();
    hub.setLlmInfo(info);
    res.json(info);
  });

  return r;
}
