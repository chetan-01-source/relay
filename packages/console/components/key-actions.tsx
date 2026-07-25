'use client';

import * as React from 'react';
import { useTransition } from 'react';
import { TriangleAlert } from 'lucide-react';
import { rotateKeyAction, revokeKeyAction } from '../app/(console)/apps/actions';
import type { IssuedKey } from '../app/lib/api';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { CopyButton } from './copy-button';
import { SnippetDrawer } from './snippet-drawer';

/** Rotate + revoke controls for one key row. Rotate reveals the successor's plaintext once (same
 * one-time contract as issue); revoke asks for confirmation first. Both call server actions that
 * revalidate the app page. */
export function KeyActions({
  keyId,
  appId,
  status,
  baseUrl,
}: {
  keyId: string;
  appId: string;
  status: 'active' | 'revoked';
  baseUrl: string;
}) {
  const [pending, start] = useTransition();
  const [rotated, setRotated] = React.useState<IssuedKey | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const disabled = pending || status !== 'active';

  function rotate() {
    setError(null);
    start(async () => {
      const r = await rotateKeyAction(keyId, appId);
      if (r.ok && r.key) setRotated(r.key);
      else setError(r.error ?? 'Rotate failed');
    });
  }

  function revoke() {
    setError(null);
    start(async () => {
      const r = await revokeKeyAction(keyId, appId);
      if (r.ok) setConfirming(false);
      else setError(r.error ?? 'Revoke failed');
    });
  }

  return (
    <>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={disabled} onClick={rotate}>
          Rotate
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          Revoke
        </Button>
      </div>
      {error ? <p className="mt-1 text-right text-xs text-destructive">{error}</p> : null}

      {/* Reveal the rotated successor key once. */}
      <Dialog open={!!rotated} onOpenChange={(o) => !o && setRotated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your new key now</DialogTitle>
            <DialogDescription>
              The predecessor keeps working during its grace window; this is the only time the new
              key is shown.
            </DialogDescription>
          </DialogHeader>
          {rotated?.key ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
                  {rotated.key}
                </code>
                <CopyButton value={rotated.key} label="Copy key" />
              </div>
              <SnippetDrawer baseUrl={baseUrl} apiKey={rotated.key} />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Confirm revoke. */}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              Requests using it are rejected within ~1s. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>Any service still using this key will start failing.</span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={pending} onClick={revoke}>
              {pending ? 'Revoking…' : 'Revoke key'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
