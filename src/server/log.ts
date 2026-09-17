// ---------------------------------------------------------------------------
// Structured JSON logger to stdout with per-process colour prefixes and secret
// redaction. Nothing matching a credential pattern is ever printed.
// ---------------------------------------------------------------------------

export type LogScope = 'GATEWAY' | 'AGENT' | 'TOOLS' | 'SIMULATOR' | 'LLM' | 'SOLACE';

const COLOURS: Record<LogScope, string> = {
  GATEWAY: '\x1b[32m', // green
  AGENT: '\x1b[35m', // magenta
  TOOLS: '\x1b[36m', // cyan
  SIMULATOR: '\x1b[33m', // yellow
  LLM: '\x1b[34m', // blue
  SOLACE: '\x1b[90m', // grey
};
const RESET = '\x1b[0m';

// Redact anything that looks like a credential before it can reach a log line.
const SECRET_KEYS = /(password|passwd|secret|token|api[_-]?key|authorization|clientsecret|credential)/i;

export function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    // Redact "key=secret" or "key: secret" fragments inside free strings.
    return value.replace(/(password|secret|token|apikey|api_key|authorization)\s*[:=]\s*\S+/gi, '$1=***');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level: string, scope: LogScope, msg: string, meta?: unknown) {
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(meta !== undefined ? { meta: redact(meta) } : {}),
  };
  const colour = COLOURS[scope] || '';
  const prefix = `${colour}[${scope}]${RESET}`;
  // Human-friendly prefix + structured JSON payload for machine parsing.
  process.stdout.write(`${prefix} ${JSON.stringify(line)}\n`);
}

export function makeLogger(scope: LogScope) {
  return {
    info: (msg: string, meta?: unknown) => emit('info', scope, msg, meta),
    warn: (msg: string, meta?: unknown) => emit('warn', scope, msg, meta),
    error: (msg: string, meta?: unknown) => emit('error', scope, msg, meta),
  };
}
