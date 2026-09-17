// ---------------------------------------------------------------------------
// Header: the bold wordmark on the left, and a single "Broker settings" control
// pinned to the top right. The popover captures the connection (url, vpn, user,
// password) plus the trigger topic subscription that arms the agent, and folds
// in the secondary demo actions (Publish event, Reset, Disconnect). The
// scenario picker and free-text box live in the Toolbar below.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import { api, AEM_BROKER, SCENARIOS, type ConnectForm } from '../lib/api.js';
import type { Connection } from '../lib/types.js';

interface HeaderProps {
  connection: Connection;
  onPublishEvent: () => void;
}

const DEFAULT_TRIGGER_TOPIC = 'acme/retail/shopfloor/price/updated/v1/>';

export function Header({ connection, onPublishEvent }: HeaderProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectForm>({
    url: 'wss://mr-connection.messaging.solace.cloud:443',
    vpn: '',
    username: 'solace-cloud-client',
    password: '',
    triggerTopic: DEFAULT_TRIGGER_TOPIC,
  });
  const [error, setError] = useState('');

  const connected = connection.connected;

  const doConnect = async () => {
    setBusy('connect');
    setError('');
    try {
      await api.connect(form);
      setShowSettings(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connect failed');
    } finally {
      setBusy(null);
    }
  };

  const doConnectAem = async () => {
    setBusy('aem');
    setError('');
    // Prefill the form so the credentials stay visible and editable, then connect.
    setForm(AEM_BROKER);
    try {
      await api.connect(AEM_BROKER);
      setShowSettings(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AEM connect failed');
    } finally {
      setBusy(null);
    }
  };

  const doMock = async () => {
    setBusy('mock');
    setError('');
    try {
      await api.connectMock();
      setShowSettings(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mock connect failed');
    } finally {
      setBusy(null);
    }
  };

  const doDisconnect = async () => {
    setBusy('disconnect');
    try {
      await api.disconnect();
    } catch {
      // non-fatal
    } finally {
      setBusy(null);
    }
  };

  const doReset = async () => {
    setBusy('reset');
    try {
      await api.reset();
    } catch {
      // non-fatal
    } finally {
      setBusy(null);
    }
  };

  return (
    <header className="header">
      <span className="wordmark-eq">
        Solace + SAP + AI = <strong>Retail Pricer Bot</strong>
      </span>

      <nav className="header-actions" aria-label="Primary actions">
        <div className="connect-wrap">
          <button
            className={`btn ${connected ? '' : 'primary'}`}
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
            title="Broker connection, trigger subscription and demo actions"
          >
            <span className={`conn-dot ${connected ? 'on' : 'off'}`} aria-hidden />
            Broker settings
          </button>

          {showSettings && (
            <div className="connect-pop">
              <h3>Broker settings</h3>
              <label className="field">
                <span>URL</span>
                <input
                  className="mono"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="wss://host.messaging.solace.cloud:443"
                />
              </label>
              <label className="field">
                <span>Message VPN</span>
                <input value={form.vpn} onChange={(e) => setForm({ ...form, vpn: e.target.value })} />
              </label>
              <label className="field">
                <span>Username</span>
                <input
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Trigger topic subscription</span>
                <input
                  className="mono"
                  value={form.triggerTopic ?? ''}
                  onChange={(e) => setForm({ ...form, triggerTopic: e.target.value })}
                  placeholder={DEFAULT_TRIGGER_TOPIC}
                />
              </label>
              {error && <p className="form-error">{error}</p>}

              {connected && (
                <p className="pop-note">
                  Connected to <strong>{connection.brokerKind ?? 'broker'}</strong>.
                  {' '}(Re)connect to apply changes.
                </p>
              )}

              <div className="btn-row">
                <button
                  className="btn primary btn-block"
                  onClick={doConnectAem}
                  disabled={busy === 'aem'}
                  title="Connect to the shared AEM playground broker with verified credentials"
                >
                  {busy === 'aem' ? 'Connecting to AEM…' : 'Connect to AEM broker'}
                </button>
              </div>

              <div className="btn-row">
                <button className="btn" onClick={doConnect} disabled={busy === 'connect'}>
                  {busy === 'connect' ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}
                </button>
                <button className="btn" onClick={doMock} disabled={busy === 'mock'}>
                  Use Mock Broker
                </button>
              </div>

              <div className="btn-row">
                <button
                  className="btn"
                  onClick={onPublishEvent}
                  title="Publish a custom event to the mesh"
                >
                  Publish event
                </button>
                <button className="btn" onClick={doReset} disabled={busy === 'reset'}>
                  {busy === 'reset' ? 'Resetting…' : 'Reset'}
                </button>
                {connected && (
                  <button
                    className="btn danger"
                    onClick={doDisconnect}
                    disabled={busy === 'disconnect'}
                  >
                    {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}

export function Toolbar() {
  const [busy, setBusy] = useState(false);
  const [freetext, setFreetext] = useState('');

  const runFreetext = async () => {
    const text = freetext.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.scenarioFreetext(text);
      setFreetext('');
    } catch {
      // non-fatal; the mesh feed will simply show no new run
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="toolbar" aria-label="Demo scenarios">
      <div className="toolbar-scenarios" role="group" aria-label="Demo scenarios">
        {SCENARIOS.map((sc) => (
          <button
            key={sc.name}
            className="btn scenario"
            onClick={() => api.scenario(sc.name).catch(() => undefined)}
            title={sc.hint}
          >
            <span className="scenario-name">
              {sc.emoji ? `${sc.emoji} ` : ''}{sc.label}
            </span>
            <span className="scenario-hint">{sc.hint}</span>
            <span className="scenario-desc">{sc.desc}</span>
          </button>
        ))}

        <form
          className="freetext"
          onSubmit={(e) => {
            e.preventDefault();
            void runFreetext();
          }}
        >
          <span className="scenario-name">Describe your own scenario</span>
          <textarea
            className="freetext-input"
            value={freetext}
            onChange={(e) => setFreetext(e.target.value)}
            placeholder="e.g. Heatwave weekend, ice cream overstocked, push a bundle to opted-in families near the coast…"
            aria-label="Describe a custom scenario"
            rows={3}
            maxLength={2000}
          />
          <button className="btn primary freetext-publish" type="submit" disabled={busy || !freetext.trim()}>
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </form>
      </div>
    </section>
  );
}
