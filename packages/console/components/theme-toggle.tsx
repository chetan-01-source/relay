'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { Button } from './ui/button';

/**
 * Light/dark switch. Renders a stable placeholder until mounted to avoid a hydration mismatch — the
 * server cannot know the resolved theme.
 *
 * `mounted` gates the LABEL as well as the icon, which it previously did not. The icon was already
 * placeholder-stable, but `aria-label` was derived from `resolvedTheme` on the first render, so the
 * server emitted "Switch to dark mode" while a client in dark mode produced "Switch to light mode"
 * — React reported a hydration mismatch, and, worse, a screen-reader user could be told the button
 * does the opposite of what it does. Before mount the control is described neutrally.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === 'dark';

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={
        mounted ? (isDark ? 'Switch to light mode' : 'Switch to dark mode') : 'Switch theme'
      }
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {mounted ? (
        isDark ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )
      ) : (
        <Sun className="h-4 w-4 opacity-0" />
      )}
    </Button>
  );
}
