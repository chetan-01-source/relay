'use client';

/**
 * SparklesCore — the tsparticles field, as supplied, adapted to this repo.
 *
 * Two deliberate changes to the reference:
 *
 *  1. `prefers-reduced-motion` is honoured. tsparticles animates unconditionally, which our design
 *     system does not allow (docs/UI-THEME.md §1). Under `reduce` the particles are still drawn —
 *     the texture is part of the layout, and removing it would leave a hole — but movement and the
 *     opacity twinkle are switched off. If the field looks static on your machine, check
 *     Accessibility → Display → Reduce motion; that is this branch, working.
 *
 *  2. It is loaded through `next/dynamic` at the call site (see components/landing/sparkles-band),
 *     so ~90KB of engine stays out of the initial bundle and off the landing page's critical path.
 *
 * `background` should stay "transparent" here: our page has a real light mode, so painting an
 * opaque particle background would punch a coloured rectangle through it.
 */
import { useEffect, useId, useState } from 'react';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import type { Container } from '@tsparticles/engine';
import { loadSlim } from '@tsparticles/slim';
import { motion, useAnimation } from 'framer-motion';
import { useTheme } from 'next-themes';
import { cn } from '../../app/lib/utils';

/**
 * Resolve the theme's accent to a concrete hex colour.
 *
 * tsparticles parses colours with its own parser, which knows nothing about CSS variables — passing
 * it `hsl(var(--primary))` renders a canvas with ZERO painted pixels and no error, which is exactly
 * as confusing as it sounds. Our tokens are also stored as bare HSL components (`217 91% 60%`), so
 * they need both interpolation and conversion before the engine will accept them.
 */
function accentHex(fallback = '#3b82f6'): string {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  const parts = raw
    .replace(/%/g, '')
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return fallback;

  const [h, s, l] = parts as [number, number, number];
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const hex = (v: number | undefined) =>
    Math.round(((v ?? 0) + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export interface SparklesCoreProps {
  id?: string;
  className?: string;
  background?: string;
  minSize?: number;
  maxSize?: number;
  speed?: number;
  particleColor?: string;
  particleDensity?: number;
}

export function SparklesCore({
  id,
  className,
  background = 'transparent',
  minSize = 0.6,
  maxSize = 1.4,
  speed = 4,
  particleColor,
  particleDensity = 120,
}: SparklesCoreProps) {
  const [init, setInit] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [accent, setAccent] = useState<string | null>(null);
  const controls = useAnimation();
  const generatedId = useId();
  const { resolvedTheme } = useTheme();

  // Re-resolve when the theme flips: the accent is a different blue in dark mode, and tsparticles
  // bakes the colour in at init, so the field has to be rebuilt rather than restyled.
  useEffect(() => {
    setAccent(accentHex());
  }, [resolvedTheme]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void initParticlesEngine(async (engine) => {
      await loadSlim(engine);
    }).then(() => {
      if (!cancelled) setInit(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const particlesLoaded = async (container?: Container): Promise<void> => {
    if (container) {
      // Fade the field in once the engine has painted, so it never pops.
      await controls.start({ opacity: 1, transition: { duration: reduced ? 0 : 1 } });
    }
  };

  // Defaults to the theme accent rather than white, so the field stays on-token and is visible on a
  // light background — white particles on white are invisible.
  const color = particleColor ?? accent;

  return (
    <motion.div animate={controls} className={cn('opacity-0', className)}>
      {init && color ? (
        <Particles
          // Keyed by colour so a theme change tears the field down and re-initialises it with the
          // new accent; tsparticles will not re-read the option in place.
          key={color}
          id={id ?? generatedId}
          className="h-full w-full"
          particlesLoaded={particlesLoaded}
          options={{
            background: { color: { value: background } },
            fullScreen: { enable: false, zIndex: 1 },
            fpsLimit: 120,
            detectRetina: true,
            interactivity: {
              events: {
                onClick: { enable: false, mode: 'push' },
                onHover: { enable: false, mode: 'repulse' },
                resize: { enable: true },
              },
            },
            particles: {
              color: { value: color },
              move: {
                enable: !reduced,
                direction: 'none',
                straight: false,
                outModes: { default: 'out' },
                speed: { min: 0.1, max: 1 },
              },
              number: {
                density: { enable: true, width: 400, height: 400 },
                value: particleDensity,
              },
              opacity: {
                value: { min: 0.1, max: 1 },
                animation: {
                  enable: !reduced,
                  speed,
                  sync: false,
                  startValue: 'random',
                  mode: 'auto',
                },
              },
              shape: { type: 'circle' },
              size: { value: { min: minSize, max: maxSize } },
            },
          }}
        />
      ) : null}
    </motion.div>
  );
}
