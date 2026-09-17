// ---------------------------------------------------------------------------
// Client-side topic helpers. Mirrors config/topics.ts categorise() so the web
// bundle stays free of server imports. TOPIC_ROOT is not known at build time on
// the client, so classification works on path fragments, not the full prefix.
// ---------------------------------------------------------------------------
import type { TopicCategory } from './types.js';

export function categorise(topic: string): TopicCategory {
  if (topic.includes('/tools/')) return 'tool';
  if (topic.includes('/weather/') || topic.includes('/news/')) return 'context';
  if (topic.includes('/inventory/') || topic.includes('/customer/')) return 'data';
  return 'mesh';
}

// Left-border colour per category. green=mesh, magenta=external context,
// blue=customer/inventory data, orange=tool timeout.
export const CATEGORY_COLOR: Record<TopicCategory, string> = {
  mesh: '#00C895',
  context: '#D6409F',
  data: '#4FA8FF',
  tool: '#FCA829',
};

export const CATEGORY_LABEL: Record<TopicCategory, string> = {
  mesh: 'Mesh Event',
  context: 'External Context',
  data: 'Customer Or Inventory',
  tool: 'Tool Call',
};

// Fragments used both for feed filters and for the per-topic pulse dots on the
// agent rail. Matched as substrings against the topic string.
export interface TopicPrefix {
  key: string;
  label: string;
  match: string;
}

export const TOPIC_PREFIXES: TopicPrefix[] = [
  { key: 'price', label: 'Price', match: '/shopfloor/price/' },
  { key: 'weather', label: 'Weather', match: '/weather/' },
  { key: 'news', label: 'News', match: '/news/' },
  { key: 'inventory', label: 'Inventory', match: '/inventory/' },
  { key: 'consent', label: 'Consent', match: '/customer/consent/' },
  { key: 'tools', label: 'Tools', match: '/tools/' },
  { key: 'agent', label: 'Agent', match: '/agents/discount-bot/' },
  { key: 'marketing', label: 'Marketing', match: '/marketing/' },
];

// Coarse filter groups for the mesh feed. Fewer, broader buckets make the
// stream easier to navigate than the eight fine-grained prefixes. "The agent"
// bucket covers everything the bot itself emits or requests.
export interface TopicGroup {
  key: string;
  label: string;
  matches: string[];
}

export const TOPIC_GROUPS: TopicGroup[] = [
  { key: 'triggers', label: 'Triggers', matches: ['/shopfloor/price/', '/weather/', '/news/'] },
  { key: 'context', label: 'Context', matches: ['/inventory/', '/customer/consent/'] },
  {
    key: 'agent',
    label: 'The agent',
    matches: ['/agents/discount-bot/', '/tools/', '/marketing/'],
  },
];

export function matchesGroup(topic: string, group: TopicGroup): boolean {
  return group.matches.some((m) => topic.includes(m));
}

export function matchesPrefix(topic: string, prefix: TopicPrefix): boolean {
  return topic.includes(prefix.match);
}
