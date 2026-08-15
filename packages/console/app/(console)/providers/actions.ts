'use server';

import { revalidatePath } from 'next/cache';
import { isKnownProvider, providerInfo } from 'relay-shared';
import { createProvider, deleteProvider } from '../../lib/api';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

/** Read a text field from a FormData safely (a file entry yields ''). */
function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function createProviderAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const name = field(formData, 'name').trim();
  const provider = field(formData, 'provider') || 'openai';
  const apiKey = field(formData, 'apiKey');
  const baseUrl = field(formData, 'baseUrl').trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!apiKey) return { ok: false, error: 'A secret key is required.' };
  // Re-checked server-side: the select is a client control, and a hand-posted form could name a
  // provider the gateway would reject with a constraint violation rather than a readable message.
  if (!isKnownProvider(provider)) return { ok: false, error: `Unknown provider "${provider}".` };
  if (!baseUrl && providerInfo(provider)?.defaultBaseUrl === null) {
    return { ok: false, error: 'This provider has no default address — a base URL is required.' };
  }
  try {
    // The secret is sealed on write and never returned by any read — the form is write-only.
    // An empty base URL is omitted rather than sent as '': the gateway reads null as "use the
    // provider's default", while an empty string would be stored and then requested verbatim.
    await createProvider({ name, provider, apiKey, ...(baseUrl ? { baseUrl } : {}) });
    revalidatePath('/providers');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

export async function deleteProviderAction(id: string): Promise<ActionResult> {
  try {
    await deleteProvider(id);
    revalidatePath('/providers');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}
