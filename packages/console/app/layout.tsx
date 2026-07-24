import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { ThemeProvider } from '../components/theme-provider';

// Geist + Geist Mono — the console's typefaces (self-hosted via the `geist` package). Sans for all
// UI, Mono for numbers/keys/code. See docs/UI-THEME.md.

export const metadata = {
  title: 'Relay Console',
  description: 'Relay Gateway management console',
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
