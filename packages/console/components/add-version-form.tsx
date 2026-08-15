'use client';

/**
 * Routes editor — target list builder (Day 13 · FE-1). A version's targets are a variable-length,
 * nested array a plain form can't express, so this client component manages the rows in state and
 * serializes them into a hidden `targets` JSON field that the server action parses. Each target picks
 * a provider credential (which fixes the provider), a provider-native model, and priority/weight.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ModelCombobox } from './model-combobox';
import { Label } from './ui/label';

export interface CredentialOption {
  id: string;
  provider: string;
  label: string;
}

interface Row {
  credential_id: string;
  model: string;
  priority: number;
  weight: number;
}

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** An application a route may be scoped to, for the create-route form's scope picker. */
export interface AppOption {
  id: string;
  name: string;
}

export function AddVersionForm({
  action,
  routeId,
  credentials,
  apps = [],
  showRouteFields = false,
  initialRows,
  submitLabel = 'Add version',
}: {
  action: (formData: FormData) => void | Promise<void>;
  routeId?: string; // omitted on the "create route" form (no route id yet)
  credentials: CredentialOption[];
  apps?: AppOption[]; // create-route form: which applications the route may be scoped to
  showRouteFields?: boolean; // create-route form: also collect model alias + cache toggle
  /**
   * The targets to start from — the ACTIVE version's, on the route editor. Versions are immutable,
   * so "updating a route" means publishing a new version; starting it blank meant retyping every
   * target to change one of them, which is why routes here ended up with a single target and no
   * fallback.
   */
  initialRows?: Row[];
  submitLabel?: string;
}) {
  const [rows, setRows] = useState<Row[]>(
    initialRows && initialRows.length > 0
      ? initialRows
      : [{ credential_id: '', model: '', priority: 100, weight: 1 }],
  );

  /** The provider behind a chosen credential, so model suggestions match where the call will go. */
  function providerOf(credentialId: string): string | undefined {
    return credentials.find((c) => c.id === credentialId)?.provider;
  }

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { credential_id: '', model: '', priority: 100, weight: 1 }]);
  }
  function removeRow(i: number) {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  }

  // Resolve each row's provider from its chosen credential; drop incomplete rows.
  const targets = rows
    .map((r) => {
      const cred = credentials.find((c) => c.id === r.credential_id);
      return cred && r.model
        ? {
            credential_id: r.credential_id,
            provider: cred.provider,
            model: r.model,
            priority: r.priority,
            weight: r.weight,
          }
        : null;
    })
    .filter(Boolean);

  return (
    <form action={action} className="space-y-4">
      {routeId ? <input type="hidden" name="routeId" value={routeId} /> : null}
      <input type="hidden" name="targets" value={JSON.stringify(targets)} />

      {showRouteFields ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="model_name">Model alias</Label>
              <Input id="model_name" name="model_name" required placeholder="fast" />
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground">
              <input type="checkbox" name="cache_enabled" className="size-4 accent-primary" />
              Enable exact-cache
            </label>
          </div>
          {/* Scope. The default is org-wide, which every application falls back to; picking an
              application creates an override that only that application's keys resolve. */}
          <div className="space-y-1.5">
            <Label htmlFor="app_id">Applies to</Label>
            <select id="app_id" name="app_id" defaultValue="" className={selectClass}>
              <option value="">Whole organization (default for every application)</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  Only {a.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              An application-scoped route overrides the organization one for the same model alias.
            </p>
          </div>
        </>
      ) : null}

      <div className="space-y-3">
        {rows.map((row, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_5rem_5rem_auto] sm:items-end">
            <div className="space-y-1">
              {i === 0 ? <Label className="text-xs">Credential</Label> : null}
              <select
                className={selectClass}
                value={row.credential_id}
                onChange={(e) => update(i, { credential_id: e.target.value })}
              >
                <option value="">Select…</option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.provider})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              {i === 0 ? <Label className="text-xs">Model</Label> : null}
              {/* Suggestions are scoped to the chosen credential's provider: an Anthropic model on
                  an OpenAI credential is a route that only fails at request time. */}
              <ModelCombobox
                value={row.model}
                onChange={(model) => update(i, { model })}
                {...(() => {
                  const provider = providerOf(row.credential_id);
                  return provider ? { provider } : {};
                })()}
              />
            </div>
            <div className="space-y-1">
              {i === 0 ? <Label className="text-xs">Priority</Label> : null}
              <Input
                type="number"
                min={0}
                value={row.priority}
                onChange={(e) => update(i, { priority: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1">
              {i === 0 ? <Label className="text-xs">Weight</Label> : null}
              <Input
                type="number"
                min={1}
                value={row.weight}
                onChange={(e) => update(i, { weight: Number(e.target.value) })}
              />
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(i)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <Plus className="mr-1 h-4 w-4" /> Add target
        </Button>
        <div className="flex items-center gap-2">
          <Label htmlFor="strategy" className="text-xs">
            Strategy
          </Label>
          <select id="strategy" name="strategy" defaultValue="priority" className={selectClass}>
            <option value="priority">priority</option>
            <option value="weighted">weighted</option>
          </select>
        </div>
        <Button type="submit" size="sm" disabled={targets.length === 0}>
          {submitLabel}
        </Button>
      </div>

      {/* The thing that is not obvious from the form alone, and the reason routes here ended up
          with no fallback: failover happens BETWEEN TARGETS in one version, not between versions.
          Only one version is ever active — versions are history and rollback. */}
      <p className="text-xs text-muted-foreground">
        {rows.length > 1
          ? 'Targets are tried in order until one answers. A target that errors before the first token fails over to the next.'
          : 'Add a second target to get failover — if the first errors before the first token, the next one is tried. One target means no fallback.'}{' '}
        <strong>priority</strong> orders them (lowest first); <strong>weighted</strong> splits
        traffic across them by weight.
      </p>
    </form>
  );
}
