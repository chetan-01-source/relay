/**
 * Which edition this console is serving (docs/editions.md).
 *
 * **Server-side only.** Every consumer is a server component, which is what lets this read the same
 * `RELAY_EDITION` the gateway reads — one variable for the whole deployment instead of a
 * `NEXT_PUBLIC_` twin that silently disagrees with the server the day somebody sets one and not the
 * other. A client component that needs this takes it as a prop (see `LandingNav`).
 *
 * `NEXT_PUBLIC_RELAY_EDITION` is still honoured as a fallback, for a console deployed on its own
 * with only build-time configuration available.
 *
 * It gates the landing page's pricing section, the Pricing link in the landing nav, and the
 * self-serve upgrade controls. It does NOT gate the plan page: on a self-hosted install that screen
 * reports real usage counts against "Unlimited", which is useful capacity information rather than a
 * disabled advertisement.
 */
export type Edition = 'oss' | 'cloud';

function resolve(): Edition {
  const raw = process.env.RELAY_EDITION ?? process.env.NEXT_PUBLIC_RELAY_EDITION;
  return raw === 'cloud' ? 'cloud' : 'oss';
}

export const EDITION: Edition = resolve();

export const isCloud = EDITION === 'cloud';
