/**
 * Notifications repository — data access only. Executes the parametrized queries against the
 * caller's transaction; contains no query text and no business rules.
 */
import {
  getChannelQuery,
  listChannelsQuery,
  upsertChannelQuery,
  deleteChannelQuery,
  listPreferencesQuery,
  upsertPreferenceQuery,
  enqueueQuery,
  listOutboxQuery,
} from '../queries/notifications.queries.js';
import type {
  ChannelRow,
  NotificationsRepository,
  OutboxRow,
  PreferenceRow,
} from '../types/notifications.types.js';

export function createNotificationsRepository(): NotificationsRepository {
  return {
    async getChannel(tx, orgId, type) {
      const rows = await tx.run<ChannelRow>(getChannelQuery(orgId, type));
      return rows[0] ?? null;
    },

    listChannels(tx, orgId) {
      return tx.run<ChannelRow>(listChannelsQuery(orgId));
    },

    async upsertChannel(tx, orgId, input, sealed) {
      // A webhook channel stores nothing outside the sealed URL: no sender address, no connection
      // settings. Writing `{}` keeps the column shape uniform without inventing placeholder values.
      const isEmail = input.type === 'email_smtp';
      const rows = await tx.run<ChannelRow>(
        upsertChannelQuery({
          orgId,
          type: input.type,
          fromAddress: isEmail ? input.fromAddress : null,
          config: isEmail
            ? {
                host: input.host,
                port: input.port,
                secure: input.secure,
                ...(input.user ? { user: input.user } : {}),
              }
            : {},
          enabled: input.enabled,
          ciphertext: sealed?.ciphertext ?? null,
          iv: sealed?.iv ?? null,
          authTag: sealed?.authTag ?? null,
          wrappedDek: sealed?.wrappedDek ?? null,
        }),
      );
      return rows[0]!;
    },

    async deleteChannel(tx, orgId, type) {
      const rows = await tx.run<{ id: string }>(deleteChannelQuery(orgId, type));
      return rows.length > 0;
    },

    listPreferences(tx, orgId) {
      return tx.run<PreferenceRow>(listPreferencesQuery(orgId));
    },

    async upsertPreference(tx, orgId, event, enabled, recipients) {
      const rows = await tx.run<PreferenceRow>(
        upsertPreferenceQuery(orgId, event, enabled, recipients),
      );
      return rows[0]!;
    },

    async enqueue(tx, orgId, input) {
      const rows = await tx.run<{ id: string }>(
        enqueueQuery(orgId, input.event, input.payload, input.dedupeKey),
      );
      // No row back ⇒ the dedupe key already claimed this logical event. Not an error: it is the
      // mechanism working, and the caller must not treat a suppressed duplicate as a failure.
      return rows.length > 0;
    },

    listOutbox(tx, orgId, limit) {
      return tx.run<OutboxRow>(listOutboxQuery(orgId, limit));
    },
  };
}
