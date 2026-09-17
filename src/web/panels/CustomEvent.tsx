// ---------------------------------------------------------------------------
// Custom event publisher: an editable topic and JSON payload, prefilled with
// the hero price payload from the EVENT CONTRACTS section, so a prospect can
// throw their own event at the agent live.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import { api } from '../lib/api.js';

const DEFAULT_TOPIC = 'acme/retail/shopfloor/price/updated/v1/FR/EMEA/51001';

const DEFAULT_PAYLOAD = JSON.stringify(
  {
    sku: '51001',
    item: 'sausage',
    category: 'fresh_meat',
    tags: ['grill_ready', 'own_brand'],
    country: 'FR',
    region: 'EMEA',
    previousPrice: 4.29,
    newPrice: 2.99,
    currency: 'EUR',
    discountPct: 30.3,
    reason: 'expiry_window',
    shelfLifeDaysRemaining: 4,
    emittedAt: '2026-08-18T07:12:04Z',
  },
  null,
  2,
);

export function CustomEvent() {
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [payload, setPayload] = useState(DEFAULT_PAYLOAD);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const publish = async () => {
    setStatus('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setStatus('Payload is not valid JSON.');
      return;
    }
    setBusy(true);
    try {
      await api.publish(topic, parsed);
      setStatus('Published to the mesh.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Publish failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="custom-event">
      <p className="explainer">
        Throw your own event at the agent. It reacts to the mesh, not to a form.
      </p>

      <label className="field">
        <span>Topic</span>
        <input className="mono" value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>
      <label className="field">
        <span>Payload (JSON)</span>
        <textarea
          className="mono"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="btn-row">
        <button className="btn primary" onClick={publish} disabled={busy}>
          {busy ? 'Publishing...' : 'Publish'}
        </button>
        {status && (
          <span className="form-status">{status}</span>
        )}
      </div>
    </section>
  );
}
