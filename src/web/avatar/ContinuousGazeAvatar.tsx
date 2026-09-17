// ---------------------------------------------------------------------------
// ContinuousGazeAvatar -- a resting-state avatar whose gaze follows the cursor
// *continuously*, not in nine discrete compass steps.
//
// Why this exists: the upstream <Avatar> component only exposes a named-pose
// API (controller.setExpression('gaze-e'|'gaze-n'|...)), and it hardcodes a
// 420ms "smooth" tween between poses. Driving gaze that way looks steppy -- the
// eyes snap between a handful of buckets. To get buttery, per-frame tracking we
// render the avatar ourselves for the resting state, using the SAME upstream
// *core* rendering primitives (@bible-strong/avatar-core) that the React
// component uses internally:
//   - expressionFromDefinition(): the base pose as a mutable numeric Expression
//   - renderAvatarExpression():   Expression -> SVG geometry + colours
// We reproduce the upstream SVG structure exactly (same class names, viewBox,
// clip-path, path order) so it is visually identical, then run our own rAF
// spring toward a cursor-derived target. No 9-bucket quantisation, no fighting
// the upstream animation clock, and no monkey-patching the minified package.
//
// This component is used ONLY while the agent is at rest. Once a run starts,
// AgentRail switches back to the upstream <Avatar> so the state-driven
// animations (thinking, excited, ...) own the presentation.
//
// Licence note: @bible-strong/avatar-core is AGPL-3.0-only. See
// docs/THIRD_PARTY.md for attribution and obligations.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef } from 'react';
import {
  clamp,
  expressionFromDefinition,
  renderAvatarExpression,
  type Expression,
} from '@bible-strong/avatar-core';
import type { AvatarDefinition } from '@bible-strong/avatar-core';

// Continuous gaze ranges, derived from the authored gaze-* poses so the reach
// matches the original hand-tuned look:
//   head pitch (headX): gaze-n +11 (up)  .. gaze-s -11 (down)
//   head yaw   (headY): gaze-w -14 (left) .. gaze-e +14 (right)
//   eye x:              +/-7
//   eye y:              centre -7, up -13, down -1  => -7 +/- 6
// Eyes are separated more widely than the authored spacing (35 -> 48).
const HEAD_PITCH = 11;
const HEAD_YAW = 14;
const EYE_X = 7;
const EYE_Y_CENTRE = -7;
const EYE_Y_SPAN = 6;
const EYE_SPACING = 48;

// Critically-damped spring toward the target each frame. Higher = snappier;
// this value reads as smooth-but-responsive at 60fps.
const STIFFNESS = 14;

interface Props {
  definition: AvatarDefinition;
  /** Seed pose key (defaults to the neutral 'gaze-c'). */
  baseExpression?: string;
  size?: number | string;
  ariaLabel?: string;
  /** When false, the avatar holds a neutral forward gaze and ignores the cursor. */
  gazeEnabled?: boolean;
}

interface Vec {
  headX: number;
  headY: number;
  eyeX: number;
  eyeY: number;
}

const NEUTRAL: Vec = { headX: 0, headY: 0, eyeX: 0, eyeY: EYE_Y_CENTRE };

export function ContinuousGazeAvatar({
  definition,
  baseExpression = 'gaze-c',
  size = 300,
  ariaLabel = 'Retail Pricer Bot avatar',
  gazeEnabled = true,
}: Props) {
  // Refs into the live SVG so the rAF loop can mutate path data without React
  // re-renders (mirrors what the upstream component does internally).
  const svgRef = useRef<SVGSVGElement | null>(null);
  const headRef = useRef<SVGPathElement | null>(null);
  const clipRef = useRef<SVGPathElement | null>(null);
  const leftRef = useRef<SVGPathElement | null>(null);
  const rightRef = useRef<SVGPathElement | null>(null);
  const backRefs = useRef<(SVGPathElement | null)[]>([]);
  const frontRefs = useRef<(SVGPathElement | null)[]>([]);

  const clipId = useMemo(
    () => `cga-${Math.abs(hashString(definition.name ?? 'avatar')).toString(36)}-head`,
    [definition],
  );

  // The base numeric Expression we mutate every frame. Cloning keeps the
  // authored eye size / colours / perspective and only moves head + pupils.
  const base = useMemo<Expression>(() => {
    const def = definition.expressions[baseExpression] ?? definition.expressions['gaze-c'];
    const key = definition.expressions[baseExpression] ? baseExpression : 'gaze-c';
    return expressionFromDefinition(key, def);
  }, [definition, baseExpression]);

  // First paint: how many body paths does this definition have? We render once
  // synchronously to size the back/front path arrays for the initial DOM.
  const initialScene = useMemo(
    () => renderAvatarExpression(definition, applyGaze(base, NEUTRAL), undefined, 1),
    [definition, base],
  );

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Smoothed (current) and desired (target) gaze vectors.
    const cur: Vec = { ...NEUTRAL };
    const target: Vec = { ...NEUTRAL };
    // Track the cursor continuously whenever gaze is on and motion is allowed.
    // (Previously a single click/keypress permanently disengaged tracking, which
    // read as "eye tracking doesn't work" - the first interaction killed it.)
    const engaged = gazeEnabled && !reduce;

    // Blink clock: reuse the definition's idle cadence so the resting bot still
    // blinks like the upstream renderer. Fall back to sensible defaults.
    const idleBlink = definition.animations['idle']?.blink;
    const blinkMin = idleBlink?.minIntervalMs ?? 2600;
    const blinkMax = idleBlink?.maxIntervalMs ?? 5200;
    const blinkDur = idleBlink?.durationMs ?? 140;
    let nextBlinkAt = performance.now() + blinkMin;
    let blinkStart = -1;

    const onMove = (e: PointerEvent) => {
      if (!engaged) return;
      const svg = svgRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // Reach: full deflection about one radius outside the circle.
      const reach = Math.max(1, Math.min(r.width, r.height));
      const dx = clamp((e.clientX - cx) / reach, -1, 1);
      const dy = clamp((e.clientY - cy) / reach, -1, 1);
      // Axis mapping (viewBox +y = down):
      //   cursor right (dx>0) -> look right -> headY+, eyeX+
      //   cursor down  (dy>0) -> look down  -> headX- (pitch down), eyeY+ (down)
      target.headY = dx * HEAD_YAW;
      target.eyeX = dx * EYE_X;
      target.headX = -dy * HEAD_PITCH;
      target.eyeY = EYE_Y_CENTRE + dy * EYE_Y_SPAN;
    };

    if (engaged) {
      window.addEventListener('pointermove', onMove, { passive: true });
    }

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // Critically-damped approach: cur += (target - cur) * (1 - e^{-k dt}).
      const a = 1 - Math.exp(-STIFFNESS * dt);
      cur.headX += (target.headX - cur.headX) * a;
      cur.headY += (target.headY - cur.headY) * a;
      cur.eyeX += (target.eyeX - cur.eyeX) * a;
      cur.eyeY += (target.eyeY - cur.eyeY) * a;

      // Blink: schedule -> close -> open, then reschedule.
      let blink = 1;
      if (blinkStart >= 0) {
        const t = (now - blinkStart) / blinkDur;
        if (t >= 1) {
          blinkStart = -1;
          nextBlinkAt = now + rand(blinkMin, blinkMax);
        } else {
          // Triangle: fully closed at the midpoint.
          blink = Math.abs(t - 0.5) * 2;
        }
      } else if (now >= nextBlinkAt) {
        blinkStart = now;
      }

      const scene = renderAvatarExpression(definition, applyGaze(base, cur), undefined, blink);
      writeScene(scene);

      raf = requestAnimationFrame(frame);
    };

    const writeScene = (scene: ReturnType<typeof renderAvatarExpression>) => {
      const g = scene.geometry;
      if (headRef.current) headRef.current.setAttribute('d', g.headPath);
      if (clipRef.current) clipRef.current.setAttribute('d', g.headPath);
      if (leftRef.current) {
        leftRef.current.setAttribute('d', g.leftPath);
        leftRef.current.setAttribute('opacity', g.leftVisible ? '1' : '0');
      }
      if (rightRef.current) {
        rightRef.current.setAttribute('d', g.rightPath);
        rightRef.current.setAttribute('opacity', g.rightVisible ? '1' : '0');
      }
      for (let i = 0; i < backRefs.current.length; i += 1) {
        backRefs.current[i]?.setAttribute('d', g.backPaths[i] ?? '');
      }
      for (let i = 0; i < frontRefs.current.length; i += 1) {
        frontRefs.current[i]?.setAttribute('d', g.frontPaths[i] ?? '');
      }
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
    };
  }, [definition, base, gazeEnabled]);

  const backCount = initialScene.geometry.backPaths.length;
  const frontCount = initialScene.geometry.frontPaths.length;
  const colors = initialScene.colors;

  return (
    <div
      className="bs-avatar"
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel}
    >
      <svg ref={svgRef} className="bs-avatar__svg" viewBox="-150 -150 300 300" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <path ref={clipRef} d={initialScene.geometry.headPath} />
          </clipPath>
        </defs>
        {Array.from({ length: backCount }, (_, i) => (
          <path
            key={`back-${i}`}
            ref={(el) => {
              backRefs.current[i] = el;
            }}
            d={initialScene.geometry.backPaths[i] ?? ''}
            fill={colors.body}
          />
        ))}
        <path ref={headRef} d={initialScene.geometry.headPath} fill={colors.body} />
        <g clipPath={`url(#${clipId})`} fill={colors.eyes}>
          <path
            ref={leftRef}
            d={initialScene.geometry.leftPath}
            opacity={initialScene.geometry.leftVisible ? 1 : 0}
          />
          <path
            ref={rightRef}
            d={initialScene.geometry.rightPath}
            opacity={initialScene.geometry.rightVisible ? 1 : 0}
          />
        </g>
        {Array.from({ length: frontCount }, (_, i) => (
          <path
            key={`front-${i}`}
            ref={(el) => {
              frontRefs.current[i] = el;
            }}
            d={initialScene.geometry.frontPaths[i] ?? ''}
            fill={colors.body}
          />
        ))}
      </svg>
    </div>
  );
}

// Clone the base Expression and overlay the continuous gaze vector.
function applyGaze(base: Expression, v: Vec): Expression {
  return {
    ...base,
    headX: v.headX,
    headY: v.headY,
    positionXLeft: v.eyeX,
    positionXRight: v.eyeX,
    positionYLeft: v.eyeY,
    positionYRight: v.eyeY,
    spacing: EYE_SPACING,
    // Kill ambient motion so our spring is the only thing moving the eyes.
    eyeMotion: 'none',
    bodyMotion: 'none',
  };
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
