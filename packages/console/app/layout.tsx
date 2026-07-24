import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';

// Inter — the console's single typeface (Enterprise Gateway design system, docs/UI-THEME.md).
const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata = {
  title: 'Relay Console',
  description: 'Relay Gateway management console',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
