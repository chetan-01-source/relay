/**
 * Valkey-backed event bus + client (PRD §4 Day 3). Used for policy-snapshot invalidation
 * (pub/sub) and, later, token-bucket rate limits + budget reserve/settle (atomic Lua).
 * Two connections: one for commands, a dedicated one for subscriptions (ioredis requirement).
 */
import { Redis } from 'ioredis';

export interface EventBus {
  client: Redis;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createEventBus(valkeyUrl: string): EventBus {
  const client = new Redis(valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  const sub = new Redis(valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });

  async function publish(channel: string, message: string): Promise<number> {
    if (client.status === 'wait') await client.connect();
    return client.publish(channel, message);
  }

  async function subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    if (sub.status === 'wait') await sub.connect();
    await sub.subscribe(channel);
    sub.on('message', (ch, msg) => {
      if (ch === channel) handler(msg);
    });
  }

  async function ping(): Promise<boolean> {
    try {
      if (client.status === 'wait') await client.connect();
      return (await client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  return {
    client,
    publish,
    subscribe,
    ping,
    close: () => {
      client.disconnect();
      sub.disconnect();
      return Promise.resolve();
    },
  };
}
