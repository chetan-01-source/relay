'use client';

/**
 * Request playground — the first console surface for the data plane (`POST /v1/chat/completions`).
 * Everything else in the console reads the control plane; this is where an operator proves the whole
 * path works: key → route → provider → metering, with the `x-relay-*` headers showing exactly what
 * the gateway did.
 *
 * The virtual key lives in component state and nowhere else — no localStorage, no cookie, no query
 * string — because it is a bearer credential for the org's spend. It is posted to the same-origin
 * /api/playground handler, which forwards it server-side.
 */
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Play, TriangleAlert } from 'lucide-react';
import type { ChatCompletionResult } from '../app/lib/api';
import { completionText, errorMessage, headerFacts, tokenUsage } from '../app/lib/playground';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ModelCombobox } from './model-combobox';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';

export interface PlaygroundProps {
  /** Client-facing model names this org has routes for — the only names the gateway will resolve. */
  routedModels: string[];
  /** Preselected model, e.g. arriving from the catalogue's "Try it" link. */
  initialModel?: string;
}

export function Playground({ routedModels, initialModel }: PlaygroundProps) {
  const [virtualKey, setVirtualKey] = useState('');
  const [model, setModel] = useState(initialModel ?? routedModels[0] ?? '');
  const [system, setSystem] = useState('');
  const [prompt, setPrompt] = useState('Say hello from Relay in five words.');
  const [maxTokens, setMaxTokens] = useState('64');
  const [temperature, setTemperature] = useState('0.2');

  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ChatCompletionResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const send = useCallback(async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    setResult(null);
    try {
      const response = await fetch('/api/playground', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: virtualKey, model, system, prompt, maxTokens, temperature }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setFailure(errorMessage(body) ?? `Request failed (${response.status}).`);
        return;
      }
      setResult(body as ChatCompletionResult);
    } catch {
      setFailure('The console could not reach its own API route.');
    } finally {
      setPending(false);
    }
  }, [virtualKey, model, system, prompt, maxTokens, temperature]);

  // The submit handler must return void, so the async work is fired rather than awaited here.
  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      void send();
    },
    [send],
  );

  const text = result ? completionText(result.body) : null;
  const upstreamError = result ? errorMessage(result.body) : null;
  const usage = result ? tokenUsage(result.body) : null;
  const facts = result ? headerFacts(result.headers) : [];
  const ok = result !== null && result.status < 400;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
          <CardDescription>
            Sent as a non-streaming completion so the settled cost is reported.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pg-key">Virtual key</Label>
              <Input
                id="pg-key"
                type="password"
                autoComplete="off"
                placeholder="rk_live_…"
                value={virtualKey}
                onChange={(e) => setVirtualKey(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                Held in this form only — never stored by the console. Issue one from an{' '}
                <Link href="/apps" className="underline">
                  application
                </Link>
                .
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-3">
                <Label htmlFor="pg-model">Model</Label>
                {/* Searchable, but over ROUTE ALIASES rather than the catalog. A virtual key can
                    only call a name this org has a route for; the gateway answers
                    `model_not_found` for anything else, so suggesting the full catalog here would
                    be suggesting requests that cannot succeed. */}
                <ModelCombobox
                  id="pg-model"
                  value={model}
                  onChange={setModel}
                  staticOptions={routedModels}
                  placeholder="gpt-4o-mini"
                  required
                  emptyHint={
                    routedModels.length === 0
                      ? 'No routes yet — create one under Build → Routes, then its alias appears here.'
                      : 'No alias matches. Only names you have a route for can be called.'
                  }
                />
                <p className="text-xs text-muted-foreground">
                  These are your route aliases, not the upstream catalog — add a route to call more
                  models.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pg-max">Max tokens</Label>
                <Input
                  id="pg-max"
                  type="number"
                  min={1}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pg-temp">Temperature</Label>
                <Input
                  id="pg-temp"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pg-system">System prompt (optional)</Label>
              <Textarea
                id="pg-system"
                rows={2}
                value={system}
                onChange={(e) => setSystem(e.target.value)}
                placeholder="You are a terse assistant."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pg-prompt">Prompt</Label>
              <Textarea
                id="pg-prompt"
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                required
              />
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={pending}>
                <Play aria-hidden="true" /> {pending ? 'Sending…' : 'Send request'}
              </Button>
              {failure ? (
                <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
                  <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                  {failure}
                </p>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Response</CardTitle>
          <CardDescription>
            What the gateway did, straight from the <code>x-relay-*</code> headers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {result === null ? (
            <p className="text-sm text-muted-foreground">
              Send a request to see the completion, the routing decision and the metered cost.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={ok ? 'success' : 'destructive'}>HTTP {result.status}</Badge>
                <Badge variant="outline">{result.latencyMs}ms round trip</Badge>
                {usage ? (
                  <Badge variant="outline">
                    {usage.input} in / {usage.output} out
                  </Badge>
                ) : null}
              </div>

              {facts.length > 0 ? (
                <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  {facts.map((fact) => (
                    <div key={fact.label} className="flex items-baseline justify-between gap-3">
                      <dt className="text-sm text-muted-foreground">{fact.label}</dt>
                      <dd
                        className={`font-mono text-sm tabular-nums ${fact.notable ? 'font-medium text-primary' : ''}`}
                      >
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {result.headers.traceId ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">Trace </span>
                  <Link
                    href={`/traffic/${encodeURIComponent(result.headers.traceId)}`}
                    className="font-mono text-sm underline"
                  >
                    {result.headers.traceId}
                  </Link>
                </p>
              ) : null}

              {upstreamError ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {upstreamError}
                </p>
              ) : null}

              {text ? (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Completion</span>
                  <p className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
                    {text}
                  </p>
                </div>
              ) : null}

              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Raw response body
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                  {JSON.stringify(result.body, null, 2)}
                </pre>
              </details>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
