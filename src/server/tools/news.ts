// ---------------------------------------------------------------------------
// News tool service. Replies with national-event flags and notable headlines
// derived from the world scenario.
// ---------------------------------------------------------------------------
import type { Bus, MeshMessage } from '../types.js';
import { TOOL_SUBSCRIPTIONS } from '../../../config/topics.js';
import { newsReplySchema } from '../agent/schema.js';
import { normalise } from '../solace/topics.js';
import { makeLogger } from '../log.js';
import { world } from '../simulators/world.js';

const log = makeLogger('TOOLS');

function lastLevel(topic: string): string {
  const parts = normalise(topic).split('/');
  return parts[parts.length - 1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function register(bus: Bus) {
  bus.respond(TOOL_SUBSCRIPTIONS.news, async (msg: MeshMessage) => {
    const country = lastLevel(msg.topic);
    await delay(150 + Math.floor(Math.random() * 250));
    const reply = world.newsReply();
    log.info('news reply', {
      country,
      nationalEvents: reply.nationalEvents.length,
    });
    return newsReplySchema.parse(reply);
  });
}
