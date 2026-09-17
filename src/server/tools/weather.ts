// ---------------------------------------------------------------------------
// Weather tool service. Replies to weather requests from the world's outlook.
// When world.weatherToolDown is true it never replies, proving the agent's
// graceful degradation path (the request times out and the signal is marked
// unavailable rather than crashing the run).
// ---------------------------------------------------------------------------
import type { Bus, MeshMessage } from '../types.js';
import { TOOL_SUBSCRIPTIONS } from '../../../config/topics.js';
import { weatherReplySchema } from '../agent/schema.js';
import { normalise } from '../solace/topics.js';
import { makeLogger } from '../log.js';
import { world } from '../simulators/world.js';

const log = makeLogger('TOOLS');

/** Last topic level carries the {country} argument. */
function lastLevel(topic: string): string {
  const parts = normalise(topic).split('/');
  return parts[parts.length - 1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function register(bus: Bus) {
  bus.respond(TOOL_SUBSCRIPTIONS.weather, async (msg: MeshMessage) => {
    const country = lastLevel(msg.topic);

    if (world.weatherToolDown) {
      // Simulated outage: never resolve so the requestor times out.
      log.warn('weather tool outage, withholding reply', { country });
      return new Promise<never>(() => {});
    }

    await delay(150 + Math.floor(Math.random() * 250));
    const reply = world.weatherOutlook();
    log.info('weather reply', { country, days: reply.outlook.length });
    // Parse before returning to guarantee the shape matches the schema.
    return weatherReplySchema.parse(reply);
  });
}
