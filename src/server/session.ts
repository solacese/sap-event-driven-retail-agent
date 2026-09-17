// ---------------------------------------------------------------------------
// SessionManager: owns the active Bus and broker credentials (in memory only,
// never logged, never persisted, never returned by any GET). Composes the four
// logical processes onto whichever bus is active: SIMULATOR, TOOLS, AGENT,
// GATEWAY feed recording.
// ---------------------------------------------------------------------------
import type { Bus, MeshMessage } from './types.js';
import { MockBus } from './solace/mockBus.js';
import { SolaceBus, type SolaceCreds } from './solace/session.js';
import { hub } from './hub.js';
import { agent } from './agent/discountBot.js';
import { registerTools } from './tools/index.js';
import { startSimulators } from './simulators/index.js';
import { contextStore } from './context/store.js';
import { makeLogger } from './log.js';

const log = makeLogger('GATEWAY');

class SessionManager {
  private bus: Bus | null = null;
  private simsStop: (() => void) | null = null;

  getBus(): Bus | null {
    return this.bus;
  }

  isConnected(): boolean {
    return this.bus?.isConnected() ?? false;
  }

  info() {
    return this.bus?.info() ?? null;
  }

  brokerKind() {
    return this.bus?.kind ?? null;
  }

  // Operator-specified trigger subscription (from Broker settings). Kept in
  // memory only, alongside the bus, so reset() can re-arm the agent identically.
  private triggerTopic: string | undefined;

  async connectMock(): Promise<void> {
    await this.teardown();
    this.triggerTopic = undefined;
    const bus = new MockBus();
    await bus.connect();
    await this.wire(bus);
  }

  async connectSolace(creds: SolaceCreds, triggerTopic?: string): Promise<void> {
    await this.teardown();
    this.triggerTopic = triggerTopic?.trim() || undefined;
    const bus = new SolaceBus(creds);
    await bus.connect();
    await this.wire(bus);
  }

  private async wire(bus: Bus) {
    this.bus = bus;
    hub.bus = bus;

    // GATEWAY feed recording: record simulator/context and tool-reply traffic
    // that the agent does not already record itself. The agent records its own
    // publishes and its own request/reply tool pairs, so here we record only
    // context streams (weather/news/inventory-stock/consent/price) inbound.
    bus.subscribe('>', (msg: MeshMessage) => {
      if (shouldGatewayRecord(msg.topic)) {
        hub.record(msg, 'in');
      }
    });

    // TOOLS: four request/reply services.
    registerTools(bus);

    // AGENT: subscribe, materialise, react.
    agent.attach(bus, { triggerTopic: this.triggerTopic });

    // SIMULATOR: publish the world so context is materialised before triggers.
    this.simsStop = startSimulators(bus) ?? null;

    hub.broadcast({
      type: 'connection',
      connected: true,
      info: bus.info(),
      brokerKind: bus.kind,
    });
    log.info('session wired', { brokerKind: bus.kind });
  }

  async teardown(): Promise<void> {
    if (this.simsStop) {
      this.simsStop();
      this.simsStop = null;
    }
    agent.detach();
    if (this.bus) {
      await this.bus.disconnect();
      this.bus = null;
      hub.bus = null;
    }
    this.triggerTopic = undefined;
    hub.broadcast({ type: 'connection', connected: false, info: null, brokerKind: null });
  }

  async reset(): Promise<void> {
    // Return everything to a known state without dropping the broker.
    contextStore.reset();
    hub.resetCounters();
    const wasSolace = this.bus?.kind === 'solace';
    const creds = wasSolace ? (this.bus as SolaceBus).info() : null;
    // Re-wire on the same kind of bus.
    if (this.bus?.kind === 'mock') {
      await this.connectMock();
    } else if (wasSolace && creds) {
      // We do not retain the password across reset by design; just re-run sims.
      this.simsStop?.();
      this.simsStop = startSimulators(this.bus!) ?? null;
    }
    hub.setAgentState(this.bus ? 'idle' : 'disconnected');
  }
}

// The agent records agent-published topics and its own tool request/reply.
// Everything else inbound (the simulated world) is recorded here for the feed.
function shouldGatewayRecord(topic: string): boolean {
  if (topic.includes('/agents/discount-bot/')) return false; // agent records its own
  if (topic.includes('/tools/')) return false; // agent records tool req/reply pairs
  if (topic.includes('/marketing/campaign/dispatch/')) return false; // agent records dispatch
  return true; // price, weather, news, inventory stock, consent streams
}

export const sessionManager = new SessionManager();
