'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { issueKeyAction, type IssueKeyResult } from '../app/(console)/apps/actions';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { CopyButton } from './copy-button';
import { SnippetDrawer } from './snippet-drawer';

const INITIAL: IssueKeyResult = { ok: false };

/**
 * Issue a virtual key from an application. The plaintext key is returned exactly ONCE by the gateway
 * and is never re-fetchable, so on success this dialog reveals it with a copy button + a ready-to-run
 * snippet and a clear "won't be shown again" warning — matching the apps service's one-time contract.
 */
export function CreateKeyDialog({ appId, baseUrl }: { appId: string; baseUrl: string }) {
  const [state, action, pending] = useActionState(issueKeyAction, INITIAL);
  const [open, setOpen] = React.useState(false);
  const issued = state.ok ? state.key : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Create key</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{issued ? 'Copy your key now' : 'Create a virtual key'}</DialogTitle>
          <DialogDescription>
            {issued
              ? 'This is the only time the full key is shown.'
              : 'A plaintext key is returned once on creation.'}
          </DialogDescription>
        </DialogHeader>

        {issued?.key ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span>Store this key securely — it cannot be retrieved later.</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
                {issued.key}
              </code>
              <CopyButton value={issued.key} label="Copy key" />
            </div>
            <div className="flex justify-between">
              <SnippetDrawer baseUrl={baseUrl} apiKey={issued.key} />
              <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form action={action} className="space-y-4">
            <input type="hidden" name="appId" value={appId} />
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" name="name" placeholder="optional" maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-env">Environment</Label>
              <select
                id="key-env"
                name="environment"
                defaultValue="live"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                <option value="live">live</option>
                <option value="test">test</option>
              </select>
            </div>
            {state.error ? (
              <p className="text-sm text-destructive" role="alert">
                {state.error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={pending}>
                {pending ? 'Issuing…' : 'Issue key'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
