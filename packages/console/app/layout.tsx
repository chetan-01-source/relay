import type { ReactNode } from 'react';

export const metadata = {
  title: 'Relay Console',
  description: 'Relay Gateway management console',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
