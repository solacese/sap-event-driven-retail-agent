// ---------------------------------------------------------------------------
// GATEWAY entry. Express + helmet CSP + cookie auth + SSE + static build.
// Boots the LLM provider, auto-connects the mock bus by default so the hero
// scenario runs with no broker and no LLM configured. Graceful shutdown
// disconnects the Solace session cleanly.
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { buildRouter } from './http/routes.js';
import { buildSwipeRouter } from './http/swipe.js';
import { streamHandler } from './http/stream.js';
import { requireAuth } from './http/auth.js';
import { sessionManager } from './session.js';
import { hub } from './hub.js';
import { resolveProvider } from './llm/index.js';
import { probeProvider } from './llm/openai.js';
import { getResolvedProvider } from './llm/index.js';
import { CONTEXT_SUBSCRIPTIONS, TOOL_SUBSCRIPTIONS, AGENT_TOPICS, TOPIC_ROOT } from '../../config/topics.js';
import { makeLogger } from './log.js';

const log = makeLogger('GATEWAY');
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const isProd = process.env.NODE_ENV === 'production';

async function main() {
  // Resolve LLM provider up front and publish it to the UI header chip.
  const provider = await resolveProvider();
  const label =
    provider.provider === 'openai_compatible'
      ? 'local proxy'
      : provider.provider === 'sap_ai_core'
        ? 'SAP AI Core'
        : 'mock';
  hub.setLlmInfo({ provider: label, model: provider.model, baseUrl: provider.baseUrl });

  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          // Vite dev injects styles; allow inline styles. No external CDNs.
          'style-src': ["'self'", "'unsafe-inline'"],
          // 'unsafe-eval' is required in every mode: the avatar renderer
          // (@bible-strong/avatar-core) compiles its JSON schema at runtime via
          // Ajv's `new Function(...)`. Without it the app fails to mount.
          'script-src': ["'self'", "'unsafe-eval'", ...(isProd ? [] : ["'unsafe-inline'"])],
          'connect-src': ["'self'", ...(isProd ? [] : ['ws:', 'http://localhost:*'])],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'", 'data:'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  // Health check: broker + llm reachability + version.
  app.get('/healthz', async (_req, res) => {
    let llmReachable = provider.provider === 'mock';
    if (provider.baseUrl) llmReachable = (await probeProvider(provider.baseUrl)) != null;
    res.json({
      status: 'ok',
      version: '1.0.0',
      broker: {
        connected: sessionManager.isConnected(),
        kind: sessionManager.brokerKind(),
      },
      llm: { provider: getResolvedProvider().provider, model: getResolvedProvider().model, reachable: llmReachable },
      topicRoot: TOPIC_ROOT,
    });
  });

  // Public swipe surface (NO auth): a mobile-first HITL page. Narrow, rate
  // limited, decide-only endpoints (SSE + yes/no + deal) so a phone can play
  // without the demo password. Mounted BEFORE requireAuth so it is reachable
  // regardless of DISABLE_AUTH. It exposes no credentials, publish or reset.
  app.get('/api/swipe/stream', streamHandler);
  app.use('/api/swipe', buildSwipeRouter());

  // SSE stream (auth required).
  app.get('/api/stream', requireAuth, streamHandler);

  // API router.
  app.use('/api', buildRouter());

  // Serve the built frontend in production; in dev Vite serves it on :5173.
  const webDist = join(__dirname, '../../dist/web');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (_req, res) => res.sendFile(join(webDist, 'index.html')));
    log.info('serving built frontend', { webDist });
  } else {
    log.info('no built frontend found; run `npm run dev:web` (Vite on :5173) or `npm run build`');
  }

  const server = app.listen(PORT, () => {
    log.info(`gateway listening on http://localhost:${PORT}`);
    printBanner();
  });

  // Auto-connect the mock bus by default so the demo works with zero config.
  if ((process.env.BROKER_MODE || 'mock') === 'mock') {
    await sessionManager.connectMock();
    log.info('auto-connected mock bus (BROKER_MODE=mock)');
  }

  const shutdown = async (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    await sessionManager.teardown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function printBanner() {
  const p = getResolvedProvider();
  const url = isProd ? `http://localhost:${PORT}` : 'http://localhost:5173';
  const lines = [
    '',
    '  Discount Bot demo is up.',
    `  URL:          ${url}`,
    `  Password:     ${process.env.DEMO_PASSWORD || 'solace'}  (env DEMO_PASSWORD)`,
    `  LLM provider: ${p.provider} / ${p.model}${p.baseUrl ? ` (${p.baseUrl})` : ''}`,
    `  Topic root:   ${TOPIC_ROOT}`,
    '',
    '  Subscribes (context streams):',
    ...CONTEXT_SUBSCRIPTIONS.map((t) => `    - ${t}`),
    '  Tool request topics:',
    ...Object.values(TOOL_SUBSCRIPTIONS).map((t) => `    - ${t}`),
    '  Publishes (agent):',
    `    - ${AGENT_TOPICS.runStarted('{runId}')}`,
    `    - ${AGENT_TOPICS.signal('{signal}', '{runId}')}`,
    `    - ${AGENT_TOPICS.campaignDrafted('{runId}')}`,
    `    - ${AGENT_TOPICS.humanApproval('{runId}')}`,
    `    - ${AGENT_TOPICS.approvalDecision('{runId}')}`,
    `    - ${AGENT_TOPICS.campaignDispatch('{country}', '{campaignId}')}`,
    `    - ${AGENT_TOPICS.runSuppressed('{runId}')}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((e) => {
  log.error('fatal startup error', { error: String(e) });
  process.exit(1);
});
