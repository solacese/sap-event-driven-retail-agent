// ---------------------------------------------------------------------------
// Avatar adapter over the original @bible-strong/avatar-react renderer.
//
// We do NOT re-implement the rendering engine. The upstream package (the same
// code that powers https://avatars.bible-strong.app/) validates the JSON
// definition and renders it faithfully, blink clock, ambient motion, head
// rotation and per-expression colours included. This module only:
//   1. re-exports the AvatarDefinition type from @bible-strong/avatar-core, and
//   2. maps our agent state machine onto the definition's semantic animation
//      keys.
//
// Licence note: @bible-strong/avatar-core and @bible-strong/avatar-react are
// AGPL-3.0-only. See docs/THIRD_PARTY.md for attribution and obligations.
// ---------------------------------------------------------------------------
import type { Ref } from 'react';
import { Avatar as BsAvatar } from '@bible-strong/avatar-react';
import type { AvatarController } from '@bible-strong/avatar-react';
import type { AvatarDefinition } from '@bible-strong/avatar-core';
import type { AgentState } from '../lib/types.js';

export type { AvatarDefinition };
export type { AvatarController };

// Agent state -> semantic animation key. Every value below exists in the
// discount-bot avatar definition's `animations` map.
const STATE_ANIMATION: Record<AgentState, string> = {
  disconnected: 'sleeping',
  connecting: 'waking',
  idle: 'idle',
  triggered: 'surprised',
  gathering: 'searching',
  reasoning: 'thinking',
  drafted: 'excited',
  awaiting_approval: 'listening',
  dispatched: 'celebrate',
  suppressed: 'confused',
  error: 'angry',
};

export function animationForState(state: AgentState): string {
  return STATE_ANIMATION[state] ?? 'idle';
}

interface Props {
  definition: AvatarDefinition;
  /** Semantic animation key from the definition (see animationForState). */
  animationName?: string;
  /** Semantic expression key; renders a single static pose (mutually exclusive). */
  expressionName?: string;
  size?: number | string;
  /**
   * Imperative handle to the upstream renderer. Use it to drive gaze
   * expressions (setExpression) from the pointer. Only usable together with
   * `uncontrolled` -- the upstream component blocks imperative playback while
   * `animation`/`expression` are supplied as controlled props.
   */
  controllerRef?: Ref<AvatarController>;
  /**
   * Render without a controlled `animation`/`expression` prop, seeding the
   * initial pose via `defaultAnimation` instead. This frees the controller to
   * drive expressions imperatively (e.g. cursor-gaze). `animationName` is used
   * as the seed pose.
   */
  uncontrolled?: boolean;
}

export function Avatar({
  definition,
  animationName,
  expressionName,
  size = 300,
  controllerRef,
  uncontrolled = false,
}: Props) {
  const label = expressionName ?? animationName ?? 'idle';
  // The upstream component treats `animation` and `expression` as two mutually
  // exclusive sources of truth. When `uncontrolled`, we pass neither (only a
  // `defaultAnimation` seed) so the controller ref may drive gaze expressions.
  const control = uncontrolled
    ? { defaultAnimation: (animationName ?? 'idle') as never }
    : expressionName
      ? { expression: expressionName as never }
      : { animation: (animationName ?? 'idle') as never };
  return (
    <BsAvatar
      definition={definition}
      ref={controllerRef}
      {...control}
      size={size}
      ariaLabel={`Retail Pricer Bot avatar, ${label}`}
      // Unknown keys are reported here instead of throwing; keep it quiet in the
      // demo and fall back to whatever the runtime shows.
      onError={() => undefined}
    />
  );
}
