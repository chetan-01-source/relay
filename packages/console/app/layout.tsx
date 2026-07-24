import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Relay Console',
  description: 'Relay Gateway management console',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
