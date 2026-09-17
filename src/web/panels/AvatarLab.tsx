// ---------------------------------------------------------------------------
// Hidden dev route at /avatar-lab. Lists every expression and animation with
// buttons so the renderer can be rehearsed and verified. Expressions are
// previewed by mapping to any animation whose first step uses them; the
// animation buttons drive the renderer directly.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { Avatar } from '../avatar/Avatar.js';
import type { AvatarDefinition } from '../avatar/Avatar.js';
import { api } from '../lib/api.js';

type Selection = { kind: 'animation' | 'expression'; name: string };

export function AvatarLab() {
  const [def, setDef] = useState<AvatarDefinition | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'animation', name: 'idle' });
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .avatar()
      .then((d) => setDef(d as AvatarDefinition))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load avatar'));
  }, []);

  if (error) {
    return <div style={{ padding: 24, color: 'var(--orange)' }}>{error}</div>;
  }
  if (!def) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading avatar definition...</div>;
  }

  const animationNames = Object.keys(def.animations);
  const expressionNames = Object.keys(def.expressions);

  return (
    <div className="lab">
      <div className="controls">
        <h2 style={{ width: '100%' }}>Avatar Lab</h2>
        <p className="explainer" style={{ width: '100%' }}>
          Every animation and expression, for rehearsal and renderer verification.
        </p>

        <div className="section-title">Animations</div>
        {animationNames.map((name) => (
          <button
            key={name}
            className={`btn${
              selection.kind === 'animation' && selection.name === name ? ' primary' : ''
            }`}
            onClick={() => setSelection({ kind: 'animation', name })}
          >
            {name}
          </button>
        ))}

        <div className="section-title">Expressions (static pose)</div>
        {expressionNames.map((name) => (
          <button
            key={name}
            className={`btn${
              selection.kind === 'expression' && selection.name === name ? ' primary' : ''
            }`}
            onClick={() => setSelection({ kind: 'expression', name })}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="stage">
        <h3>
          {selection.kind === 'animation' ? 'Animation' : 'Expression'}: {selection.name}
        </h3>
        {selection.kind === 'animation' ? (
          <Avatar definition={def} animationName={selection.name} />
        ) : (
          <Avatar definition={def} expressionName={selection.name} />
        )}
      </div>
    </div>
  );
}
