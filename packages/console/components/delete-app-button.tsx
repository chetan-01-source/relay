'use client';

import * as React from 'react';
import { useTransition } from 'react';
import { deleteAppAction } from '../app/(console)/apps/actions';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Input } from './ui/input';

/**
 * Delete an application, behind a typed confirmation.
 *
 * Heavier than the provider dialog on purpose: deleting an application revokes every key it owns,
 * and those keys are in someone's production environment. A misplaced click should not be able to
 * cause that, so the name has to be typed — the same reasoning as a repository delete.
 */
export function DeleteAppButton({
  id,
  name,
  activeKeys,
}: {
  id: string;
  name: string;
  activeKeys: number;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const confirmed = confirmation.trim() === name;

  function remove() {
    setError(null);
    start(async () => {
      const result = await deleteAppAction(id);
      if (result.ok) {
        setOpen(false);
        setConfirmation('');
      } else {
        setError(result.error ?? 'Delete failed');
      }
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
              {activeKeys > 0
                ? `${activeKeys} active ${activeKeys === 1 ? 'key stops' : 'keys stop'} working immediately, and any application-scoped budgets and routes are removed with it. This cannot be undone.`
                : 'Its budgets and application-scoped routes are removed with it. This cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-sm" htmlFor={`confirm-${id}`}>
              Type <span className="font-mono font-medium">{name}</span> to confirm
            </label>
            <Input
              id={`confirm-${id}`}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending || !confirmed}
              onClick={remove}
            >
              {pending ? 'Deleting…' : 'Delete application'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
