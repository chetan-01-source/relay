import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { ThemeProvider } from '../components/theme-provider';

// Geist + Geist Mono — the console's typefaces (self-hosted via the `geist` package). Sans for all
// UI, Mono for numbers/keys/code. See docs/UI-THEME.md.

/**
 * `metadataBase` resolves the relative OG image path to an absolute URL, which every social crawler
 * requires. It comes from the deployment's own console URL because a self-hosted install has no
 * canonical public origin we could hardcode.
 */
const siteUrl = process.env.LOGTO_BASE_URL ?? 'http://localhost:3100';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Relay — one endpoint for every model',
    template: '%s · Relay',
  },
  description:
    'Relay is a self-hosted, multi-tenant LLM gateway: OpenAI-compatible routing with failover, spend ceilings enforced on the hot path, sealed provider credentials and a tamper-evident audit trail.',
  applicationName: 'Relay',
  keywords: [
    'LLM gateway',
    'OpenAI-compatible proxy',
    'AI cost control',
    'multi-tenant',
    'self-hosted',
    'model routing',
  ],
  openGraph: {
    type: 'website',
    siteName: 'Relay',
    title: 'Relay — one endpoint for every model',
    description:
      'Self-hosted LLM gateway. Routing with failover, budgets that hold, per-tenant isolation and an audit trail — without changing your application code.',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Relay — one endpoint for every model',
    description:
      'Self-hosted LLM gateway. Routing with failover, budgets that hold, per-tenant isolation and an audit trail.',
  },
  // The console is private by nature; there is nothing here worth indexing on a tenant's own host.
  robots: { index: false, follow: false },
};

/**
 * `themeColor` is per-scheme so the mobile browser chrome matches the page in both modes — a light
 * page with a black status bar is the tell that a site only ever considered one theme.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
