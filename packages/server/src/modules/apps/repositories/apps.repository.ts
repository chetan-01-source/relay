/**
 * Apps repository (DEVELOPMENT.md §2) — data access only. Runs the parametrized queries against the
 * caller's transaction (a Queryable from withTenant), so a rotate (insert successor + link
 * predecessor) commits atomically. Contains NO query text and NO business logic.
 */
import {
  insertAppQuery,
  getAppByIdQuery,
  listAppsQuery,
  insertKeyQuery,
  getKeyByIdQuery,
  listKeysByAppQuery,
  revokeKeyQuery,
  linkSuccessorQuery,
} from '../queries/apps.queries.js';
import type { ApplicationRow, AppsRepository, VirtualKeyRow } from '../types/apps.types.js';

export function createAppsRepository(): AppsRepository {
  return {
    async createApp(tx, orgId, input) {
      const rows = await tx.run<ApplicationRow>(
        insertAppQuery(orgId, input.name, input.description ?? null),
      );
      return rows[0]!;
    },
    async getApp(tx, appId) {
      const rows = await tx.run<ApplicationRow>(getAppByIdQuery(appId));
      return rows[0] ?? null;
    },
    listApps(tx) {
      return tx.run<ApplicationRow>(listAppsQuery());
    },
    async insertKey(tx, key) {
      const rows = await tx.run<VirtualKeyRow>(insertKeyQuery(key));
      return rows[0]!;
    },
    async getKey(tx, keyId) {
      const rows = await tx.run<VirtualKeyRow>(getKeyByIdQuery(keyId));
      return rows[0] ?? null;
    },
    listKeys(tx, appId) {
      return tx.run<VirtualKeyRow>(listKeysByAppQuery(appId));
    },
    async revokeKey(tx, keyId) {
      await tx.run(revokeKeyQuery(keyId));
    },
    async linkSuccessor(tx, predecessorId, successorId, graceUntil) {
      await tx.run(linkSuccessorQuery(predecessorId, successorId, graceUntil));
    },
  };
}
