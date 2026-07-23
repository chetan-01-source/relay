'use server';

import { revalidatePath } from 'next/cache';
import { createApp, issueKey, rotateKey, revokeKey, type IssuedKey } from '../../lib/api';

/** Result envelope for useActionState — an error message the form renders, or the issued key. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}
export interface IssueKeyResult extends ActionResult {
  key?: IssuedKey;
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

/** Read a text field from a FormData safely (a file entry yields ''). */
function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function createAppAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const name = field(formData, 'name').trim();
  const description = field(formData, 'description').trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  try {
    await createApp({ name, ...(description ? { description } : {}) });
    revalidatePath('/apps');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

export async function issueKeyAction(
  _prev: IssueKeyResult,
  formData: FormData,
): Promise<IssueKeyResult> {
  const appId = field(formData, 'appId');
  const name = field(formData, 'name').trim();
  const environment = (field(formData, 'environment') || 'live') as 'live' | 'test';
  if (!appId) return { ok: false, error: 'Missing application.' };
  try {
    const key = await issueKey(appId, { ...(name ? { name } : {}), environment });
    revalidatePath(`/apps/${appId}`);
    return { ok: true, key };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

export async function rotateKeyAction(keyId: string, appId: string): Promise<IssueKeyResult> {
  try {
    const key = await rotateKey(keyId);
    revalidatePath(`/apps/${appId}`);
    return { ok: true, key };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

export async function revokeKeyAction(keyId: string, appId: string): Promise<ActionResult> {
  try {
    await revokeKey(keyId);
    revalidatePath(`/apps/${appId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}
