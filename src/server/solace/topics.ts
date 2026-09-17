// ---------------------------------------------------------------------------
// Solace topic matching. "*" matches exactly one level, ">" matches one or more
// trailing levels and is only valid as the last token. Used by the mock bus to
// route messages the same way a real broker would.
// ---------------------------------------------------------------------------

export function normalise(topic: string): string {
  return topic.replace(/\.+/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

/** Does a concrete topic match a subscription filter (with * and >)? */
export function topicMatches(filter: string, topic: string): boolean {
  const f = normalise(filter).split('/');
  const t = normalise(topic).split('/');

  for (let i = 0; i < f.length; i++) {
    const token = f[i];
    if (token === '>') {
      // > must be last and matches the remaining one-or-more levels.
      return i < t.length;
    }
    if (i >= t.length) return false;
    if (token === '*') continue;
    if (token !== t[i]) return false;
  }
  return f.length === t.length;
}
