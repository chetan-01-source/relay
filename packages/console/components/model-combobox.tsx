'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Input } from './ui/input';

export interface ModelOption {
  provider: string;
  model: string;
}

interface ModelComboboxProps {
  value: string;
  onChange: (model: string) => void;
  /** Restrict suggestions to one provider — the route form knows it from the chosen credential. */
  provider?: string;
  placeholder?: string;
  id?: string;
  name?: string;
  required?: boolean;
  className?: string;
  /**
   * Suggest from this fixed list instead of the catalog. The playground uses it: a virtual key can
   * only call ROUTE ALIASES, so offering the full catalog there would suggest names the gateway
   * answers `model_not_found` for.
   */
  staticOptions?: readonly string[];
  /** Shown under the field when the suggestion list is empty or short. */
  emptyHint?: string;
}

/**
 * A model picker that suggests without restricting.
 *
 * Deliberately NOT a `<select>`. A route target may legitimately name a model the catalog has never
 * heard of — the catalog is a convenience populated by `relay sync-models`, and route targets carry
 * a `known_model` flag precisely because an unknown one is allowed. A closed dropdown would turn
 * "we haven't synced that provider yet" into "you cannot configure this at all", which is how the
 * OpenAI picker ended up offering two models.
 *
 * So: free text, with search-as-you-type suggestions from the catalog underneath.
 */
export function ModelCombobox({
  value,
  onChange,
  provider,
  placeholder = 'gpt-4o',
  id,
  name,
  required,
  className,
  staticOptions,
  emptyHint,
}: ModelComboboxProps) {
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [emptyCatalog, setEmptyCatalog] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Debounced: a request per keystroke would put a query on the database for every letter typed.
  useEffect(() => {
    if (!open) return;
    if (staticOptions) {
      const needle = value.trim().toLowerCase();
      setOptions(
        staticOptions
          .filter((name) => name.toLowerCase().includes(needle))
          .map((name) => ({ provider: '', model: name })),
      );
      setEmptyCatalog(staticOptions.length === 0);
      return;
    }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: '50' });
      if (provider) params.set('provider', provider);
      if (value.trim()) params.set('q', value.trim());

      setLoading(true);
      fetch(`/api/catalog?${params.toString()}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((body: { data?: ModelOption[]; counts?: Record<string, number> }) => {
          setOptions(body.data ?? []);
          // A provider with almost nothing catalogued is not "no matches" — it is "you have not
          // synced this provider yet", and saying so is the difference between a dead end and a fix.
          const count = provider ? (body.counts?.[provider] ?? 0) : Infinity;
          setEmptyCatalog(count <= 2);
        })
        .catch(() => setOptions([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [value, provider, open, staticOptions]);

  // Close on an outside click, so the list does not linger over the rest of the form.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const suggestions = options.filter((option) => option.model !== value);

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        name={name}
        value={value}
        required={required}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        className={className}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      />

      {open ? (
        <div
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-input bg-popover shadow-md"
        >
          {loading && suggestions.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>
          ) : null}

          {!loading && suggestions.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {emptyHint ??
                (emptyCatalog
                  ? `No catalog for ${provider ?? 'this provider'} yet — run “make sync-models”. You can still type any model id.`
                  : 'No match. You can still type any model id.')}
            </p>
          ) : null}

          {suggestions.map((option) => (
            <button
              key={`${option.provider}:${option.model}`}
              type="button"
              role="option"
              aria-selected={false}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onChange(option.model);
                setOpen(false);
              }}
            >
              <span className="truncate font-mono text-xs">{option.model}</span>
              {!provider ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {option.provider}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
