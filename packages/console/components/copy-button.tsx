'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './ui/button';

/** Copy `value` to the clipboard, flashing a check for 1.5s. Used for one-time keys + snippets. */
export function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
}: {
  value: string;
  label?: string;
  size?: 'sm' | 'icon';
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context) — no-op; the value is still visible to select manually.
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={() => void copy()}
      aria-label={label}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {size === 'sm' ? <span>{copied ? 'Copied' : label}</span> : null}
    </Button>
  );
}
