'use server';

/**
 * Server actions for the routes editor (Day 13 · FE-1). Run server-side so the caller's Logto token
 * is attached by the typed client and never exposed to the browser. The gateway enforces routes:write;
 * the UI is a convenience. Variable-length target lists arrive as a JSON string in a hidden field
 * (a form can't express a nested array), parsed here before calling the API.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  createRoute,
  addRouteVersion,
  activateRouteVersion,
  setRouteCache,
  deleteRoute,
  type CreateRouteInput,
  type CreateVersionInput,
} from '../../lib/api';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

type TargetInput = NonNullable<CreateVersionInput['targets']>[number];

/** Parse the hidden `targets` JSON field into a validated target array (best-effort; server re-checks). */
function parseTargets(formData: FormData): TargetInput[] {
  const raw = field(formData, 'targets');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TargetInput[];
    return Array.isArray(parsed)
      ? parsed.filter((t) => t.credential_id && t.provider && t.model)
      : [];
  } catch {
    return [];
  }
}

/** Create a route (optionally with an initial active version), then open its detail page. */
export async function createRouteAction(formData: FormData): Promise<void> {
  const modelName = field(formData, 'model_name');
  if (!modelName) return;
  const targets = parseTargets(formData);
  // Empty means the org-wide route — the fallback every application resolves when it has no
  // override. Only a non-empty value scopes the route to one application.
  const appId = field(formData, 'app_id');
  const input: CreateRouteInput = {
    model_name: modelName,
    strategy: field(formData, 'strategy') === 'weighted' ? 'weighted' : 'priority',
    cache_enabled: formData.get('cache_enabled') === 'on',
    ...(appId ? { app_id: appId } : {}),
    ...(targets.length > 0 ? { targets } : {}),
  };
  const route = await createRoute(input);
  revalidatePath('/routes');
  redirect(`/routes/${route.id}`);
}

/** Add a new (inactive) version to a route. */
export async function addVersionAction(formData: FormData): Promise<void> {
  const routeId = field(formData, 'routeId');
  const targets = parseTargets(formData);
  if (!routeId || targets.length === 0) return;
  await addRouteVersion(routeId, {
    strategy: field(formData, 'strategy') === 'weighted' ? 'weighted' : 'priority',
    targets,
  });
  revalidatePath(`/routes/${routeId}`);
}

/** Activate a version (rollback = activating an older one). */
export async function activateVersionAction(formData: FormData): Promise<void> {
  const routeId = field(formData, 'routeId');
  const versionId = field(formData, 'versionId');
  if (!routeId || !versionId) return;
  await activateRouteVersion(routeId, versionId);
  revalidatePath(`/routes/${routeId}`);
}

/** Toggle exact-cache for a route. */
export async function toggleCacheAction(formData: FormData): Promise<void> {
  const routeId = field(formData, 'routeId');
  if (!routeId) return;
  await setRouteCache(routeId, field(formData, 'enabled') === 'true');
  revalidatePath(`/routes/${routeId}`);
  revalidatePath('/routes');
}

/** Delete a route and all its versions, then return to the list. */
export async function deleteRouteAction(formData: FormData): Promise<void> {
  const routeId = field(formData, 'routeId');
  if (!routeId) return;
  await deleteRoute(routeId);
  revalidatePath('/routes');
  redirect('/routes');
}
