import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { QueryProvider } from '../components/QueryProvider.tsx';
import '../globals.css';

export const metadata: Metadata = {
  title: 'Rex-Royal — Dynamic Pricing',
  description: 'Rex-Royal Fleet Pricing Management & Configuration Deployment',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
