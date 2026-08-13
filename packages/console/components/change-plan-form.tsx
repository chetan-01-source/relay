'use client';

/**
 * Self-serve plan change (cloud edition only).
 *
 * A client component for one reason: `useActionState`, so the button can disable while the request
 * is in flight and the gateway's error message can be shown inline. Everything else on the plan page
 * is server-rendered.
 *
 * A DOWNGRADE is confirmed, an upgrade is not. Downgrading can leave an organization over its new
 * ceilings — nothing is deleted, but it stops being able to create — and that consequence deserves a
 * deliberate second click. Upgrading has no destructive outcome to warn about.
 */
import { useActionState, useState } from 'react';
import { changePlanAction, type ActionResult } from '../app/(console)/plan/actions';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';

const INITIAL: ActionResult = { ok: true };

export function ChangePlanForm({
  planCode,
  planName,
  isDowngrade,
  disabled,
  label,
}: {
  planCode: string;
  planName: string;
  isDowngrade: boolean;
  disabled?: boolean;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(changePlanAction, INITIAL);
  const [open, setOpen] = useState(false);

  const submit = (
    <form action={formAction} className="contents">
      <input type="hidden" name="plan_code" value={planCode} />
      <Button type="submit" className="w-full" disabled={pending || disabled}>
        {pending ? 'Working…' : label}
      </Button>
    </form>
  );

  if (!isDowngrade) {
    return (
      <div className="space-y-2">
        {submit}
        {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" className="w-full" disabled={disabled}>
            {label}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to {planName}?</DialogTitle>
            <DialogDescription>
              Nothing is deleted. Anything already over the smaller plan&apos;s limits keeps
              working, but you will not be able to create more until you are back under them — and
              any capability {planName} excludes stops applying to new requests within about a
              second.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {submit}
          </div>
        </DialogContent>
      </Dialog>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
    </div>
  );
}
