'use client';

import * as React from 'react';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { Button } from './ui/button';
import { CopyButton } from './copy-button';
import { buildSnippet, SNIPPET_LANGS, type SnippetLang } from '../app/lib/snippet';

/** cURL / SDK snippet drawer (DX rule). Shows a ready-to-run request against the gateway for the
 * given key + model. When the key is a placeholder the user still gets a correct shape to adapt. */
export function SnippetDrawer({
  baseUrl,
  apiKey,
  model = 'gpt-4o',
  triggerLabel = 'cURL / SDK',
  triggerVariant = 'outline',
}: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  triggerLabel?: string;
  triggerVariant?: 'outline' | 'default' | 'secondary';
}) {
  const [lang, setLang] = React.useState<SnippetLang>('curl');
  const code = buildSnippet(lang, { baseUrl, apiKey, model });

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size="sm">
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Call the gateway</DialogTitle>
          <DialogDescription>
            OpenAI-compatible — point any SDK at the Relay base URL.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          {SNIPPET_LANGS.map((l) => (
            <Button
              key={l}
              type="button"
              size="sm"
              variant={l === lang ? 'default' : 'outline'}
              onClick={() => setLang(l)}
            >
              {l}
            </Button>
          ))}
        </div>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
        <div className="flex justify-end">
          <CopyButton value={code} label="Copy snippet" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
