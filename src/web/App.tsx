// ---------------------------------------------------------------------------
// App: password gate, then a clean two-region story. Wordmark header, a simple
// controls Toolbar, then two columns (AgentRail | MeshFeed) so the live mesh
// feed -- the star of an EDA demo -- gets the full viewport as the hero.
// The human-in-the-loop surface now lives entirely on the mobile-first /swipe
// page; the desktop dashboard is the agent + the mesh it reasons over.
// The "Publish Custom Event" tool lives in a slide-over drawer toggled from the
// toolbar, so it never pushes the story below the fold.
// The stream hook is wired once authenticated. Hidden routes: /avatar-lab
// renders the AvatarLab, /swipe renders the swipe HITL deck.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, LLM_MODELS, type LlmModel } from './lib/api.js';
import { useStream } from './lib/useStream.js';
import type { AvatarDefinition } from './avatar/Avatar.js';
import { Header, Toolbar } from './panels/Header.js';
import { CostMeter } from './panels/CostMeter.js';
import { AgentRail } from './panels/AgentRail.js';
import { MeshFeed } from './panels/MeshFeed.js';
import { CustomEvent } from './panels/CustomEvent.js';
import { AvatarLab } from './panels/AvatarLab.js';
import { SwipePage } from './panels/SwipePage.js';

export function App() {
  if (typeof window !== 'undefined' && window.location.pathname === '/avatar-lab') {
    return <AvatarLab />;
  }
  // Mobile-first swipe HITL surface. Public (no login) - mirrors the desktop
  // Human-in-the-Loop rail as a Tinder-style deck driven by the live mesh.
  if (typeof window !== 'undefined' && window.location.pathname === '/swipe') {
    return <SwipePage />;
  }
  return <MainApp />;
}

function MainApp() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  // Probe session on load: a 401 from a protected GET means we need to log in.
  useEffect(() => {
    api
      .session()
      .then(() => setAuthed(true))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setAuthed(false);
        else setAuthed(true); // other errors: assume authed, let panels surface issues
      });
  }, []);

  if (authed === null) {
    return (
      <div className="gate">
        <div className="card">
          <h1>Retail Pricer Bot</h1>
          <p className="explainer">Connecting…</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return <LoginGate onSuccess={() => setAuthed(true)} />;
  }

  return <Dashboard />;
}

function LoginGate({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong password.' : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="card" onSubmit={submit}>
        <h1>Retail Pricer Bot</h1>
        <p className="explainer">
          An SAP × Solace event-driven agent demo. Enter the demo password.
        </p>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </label>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Enter'}
        </button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}

function Dashboard() {
  const stream = useStream(true);
  const [avatar, setAvatar] = useState<AvatarDefinition | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The selected agent LLM lives here so the picker (now in the budget bar) and
  // the avatar tint (in the agent rail) share one source of truth. The choice is
  // broadcast to every client; the mock provider actually runs the campaign.
  const [model, setModel] = useState<LlmModel>(LLM_MODELS[0]);
  const onModelChange = useCallback((value: string) => {
    const next = LLM_MODELS.find((m) => m.value === value) ?? LLM_MODELS[0];
    setModel(next);
    api.setLlmModel(next.value).catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .avatar()
      .then((d) => setAvatar(d as AvatarDefinition))
      .catch(() => setAvatar(null));
  }, []);

  // Close the drawer on Escape for keyboard users.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="app">
      <Header
        connection={stream.connection}
        onPublishEvent={() => setDrawerOpen(true)}
      />

      <Toolbar />

      <CostMeter
        counters={stream.counters}
        llmInfo={stream.llmInfo}
        model={model.value}
        onModelChange={onModelChange}
      />

      <div className="app-main">
        <AgentRail agentState={stream.agentState} avatar={avatar} run={stream.run} model={model} />
        <MeshFeed feed={stream.feed} />
      </div>

      {drawerOpen && (
        <div
          className="drawer-scrim"
          onClick={() => setDrawerOpen(false)}
          role="presentation"
        >
          <aside
            className="drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Publish custom event"
          >
            <div className="drawer-head">
              <h2>Publish Custom Event</h2>
              <button
                className="btn"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close"
              >
                Close
              </button>
            </div>
            <CustomEvent />
          </aside>
        </div>
      )}
    </div>
  );
}
