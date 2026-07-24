'use server';

import { revalidatePath } from 'next/cache';
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
  const provider = (field(formData, 'provider') || 'openai') as
    'openai' | 'anthropic' | 'openai_compat';
  const apiKey = field(formData, 'apiKey');
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!apiKey) return { ok: false, error: 'A secret key is required.' };
  try {
    // The secret is sealed on write and never returned by any read — the form is write-only.
    await createProvider({ name, provider, apiKey });
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
