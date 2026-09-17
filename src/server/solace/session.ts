// ---------------------------------------------------------------------------
// SolaceBus: real broker via solclientjs (SMF over WebSocket, direct messaging).
// Implements the same Bus interface as MockBus. Uses session.sendRequest for
// request/reply with reply-to correlation and a 4000ms default timeout.
//
// Credentials are passed in from the in-memory session store; they are never
// logged, persisted, or returned to the client.
// ---------------------------------------------------------------------------
import solace from 'solclientjs';
import type { Bus, MeshMessage, MessageHandler, RequestOptions, ConnectionInfo } from '../types.js';
import { makeLogger } from '../log.js';
import { topicMatches } from './topics.js';

const log = makeLogger('SOLACE');

let factoryInitialised = false;
function initFactory() {
  if (factoryInitialised) return;
  const props = new solace.SolclientFactoryProperties();
  props.profile = solace.SolclientFactoryProfiles.version10_5;
  props.logLevel = solace.LogLevel.WARN;
  solace.SolclientFactory.init(props);
  factoryInitialised = true;
}

export interface SolaceCreds {
  url: string; // wss://host:port
  vpn: string;
  username: string;
  password: string;
}

interface Sub {
  filter: string;
  handler: MessageHandler;
}
interface Responder {
  filter: string;
  fn: (msg: MeshMessage) => Promise<unknown> | unknown;
}

function toUserProps(msg: solace.Message): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  try {
    const map = msg.getUserPropertyMap?.();
    if (map) {
      for (const key of map.getKeys()) {
        const field = map.getField(key);
        out[key] = field?.getValue?.()?.toString();
      }
    }
  } catch {
    /* no user properties */
  }
  return out;
}

function parsePayload(msg: solace.Message): unknown {
  try {
    const text = msg.getBinaryAttachment?.();
    if (text == null) return null;
    const asString = typeof text === 'string' ? text : Buffer.from(text as Uint8Array).toString('utf8');
    try {
      return JSON.parse(asString);
    } catch {
      return asString;
    }
  } catch {
    return null;
  }
}

export class SolaceBus implements Bus {
  readonly kind = 'solace' as const;
  private session: solace.Session | null = null;
  private connected = false;
  private subs: Sub[] = [];
  private responders: Responder[] = [];
  private installed = new Set<string>();

  constructor(private creds: SolaceCreds) {
    initFactory();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const session = solace.SolclientFactory.createSession({
          url: this.creds.url,
          vpnName: this.creds.vpn,
          userName: this.creds.username,
          password: this.creds.password,
          connectRetries: 1,
          reconnectRetries: 5,
          generateSendTimestamps: true,
        });
        this.session = session;

        session.on(solace.SessionEventCode.UP_NOTICE, () => {
          this.connected = true;
          log.info('solace session up', { host: this.creds.url, vpn: this.creds.vpn });
          // (Re)install any subscriptions registered before connect completed.
          for (const s of this.subs) this.installSubscription(s.filter);
          for (const r of this.responders) this.installSubscription(r.filter);
          resolve();
        });
        session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e: solace.SessionEvent) => {
          this.connected = false;
          log.error('solace connect failed', { code: e.infoStr });
          reject(new Error(e.infoStr || 'connect failed'));
        });
        session.on(solace.SessionEventCode.DISCONNECTED, () => {
          this.connected = false;
          log.warn('solace disconnected');
        });
        session.on(solace.SessionEventCode.MESSAGE, (message: solace.Message) => {
          this.dispatch(message);
        });

        session.connect();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private installSubscription(filter: string) {
    if (!this.session || !this.connected) return;
    if (this.installed.has(filter)) return;
    try {
      this.session.subscribe(
        solace.SolclientFactory.createTopicDestination(filter),
        true,
        filter,
        10000,
      );
      this.installed.add(filter);
    } catch (e) {
      log.error('subscribe failed', { filter, error: String(e) });
    }
  }

  private dispatch(message: solace.Message) {
    const dest = message.getDestination();
    const topic = dest ? dest.getName() : '';
    const payload = parsePayload(message);
    const userProperties = toUserProps(message);
    const meshMsg: MeshMessage = { topic, payload, userProperties };

    // Serve responders first (request/reply); reply directly to the message.
    for (const r of this.responders) {
      if (topicMatches(r.filter, topic)) {
        const replyTo = message.getReplyTo();
        if (replyTo) {
          Promise.resolve()
            .then(() => r.fn(meshMsg))
            .then((replyPayload) => this.sendReply(message, replyPayload))
            .catch((e) => log.error('responder failed', { topic, error: String(e) }));
          return;
        }
      }
    }
    for (const s of this.subs) {
      if (topicMatches(s.filter, topic)) {
        try {
          s.handler(meshMsg);
        } catch (e) {
          log.error('handler threw', { topic, error: String(e) });
        }
      }
    }
  }

  private sendReply(request: solace.Message, payload: unknown) {
    if (!this.session) return;
    const reply = solace.SolclientFactory.createMessage();
    reply.setBinaryAttachment(JSON.stringify(payload ?? null));
    try {
      this.session.sendReply(request, reply);
    } catch (e) {
      log.error('sendReply failed', { error: String(e) });
    }
  }

  subscribe(topicFilter: string, handler: MessageHandler): void {
    this.subs.push({ filter: topicFilter, handler });
    this.installSubscription(topicFilter);
  }

  respond(topicFilter: string, fn: (msg: MeshMessage) => Promise<unknown> | unknown): void {
    this.responders.push({ filter: topicFilter, fn });
    this.installSubscription(topicFilter);
  }

  publish(msg: MeshMessage): void {
    if (!this.session || !this.connected) return;
    const m = solace.SolclientFactory.createMessage();
    m.setDestination(solace.SolclientFactory.createTopicDestination(msg.topic));
    m.setBinaryAttachment(JSON.stringify(msg.payload ?? null));
    m.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
    // Attach user properties.
    try {
      const map = new solace.SDTMapContainer();
      for (const [k, v] of Object.entries(msg.userProperties || {})) {
        if (v !== undefined) map.addField(k, solace.SDTFieldType.STRING, String(v));
      }
      m.setUserPropertyMap(map);
    } catch {
      /* best effort */
    }
    try {
      this.session.send(m);
    } catch (e) {
      log.error('publish failed', { topic: msg.topic, error: String(e) });
    }
  }

  request(topic: string, payload: unknown, opts?: RequestOptions): Promise<MeshMessage> {
    const timeoutMs = opts?.timeoutMs ?? 4000;
    return new Promise((resolve, reject) => {
      if (!this.session || !this.connected) return reject(new Error('not connected'));
      const m = solace.SolclientFactory.createMessage();
      m.setDestination(solace.SolclientFactory.createTopicDestination(topic));
      m.setBinaryAttachment(JSON.stringify(payload ?? null));
      m.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
      try {
        this.session.sendRequest(
          m,
          timeoutMs,
          (_s: solace.Session, reply: solace.Message) => {
            resolve({
              topic: `${topic}/reply`,
              payload: parsePayload(reply),
              userProperties: toUserProps(reply),
            });
          },
          (_s: solace.Session, error: solace.RequestError) => {
            reject(new Error(error?.message || `request timeout after ${timeoutMs}ms`));
          },
          undefined,
        );
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      try {
        this.session.disconnect();
      } catch {
        /* ignore */
      }
      this.session = null;
    }
    this.connected = false;
    this.installed.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  info(): ConnectionInfo {
    return { host: this.creds.url, vpn: this.creds.vpn, username: this.creds.username };
  }
}
