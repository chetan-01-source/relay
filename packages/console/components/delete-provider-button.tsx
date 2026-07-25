'use client';

import * as React from 'react';
import { useTransition } from 'react';
import { deleteProviderAction } from '../app/(console)/providers/actions';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';

/** Delete a provider credential, with a confirmation step. */
export function DeleteProviderButton({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function remove() {
    setError(null);
    start(async () => {
      const r = await deleteProviderAction(id);
      if (r.ok) setOpen(false);
      else setError(r.error ?? 'Delete failed');
    });
  }

  return (
    <>
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              Routes using this credential will fail until pointed at another. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={pending} onClick={remove}>
              {pending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
