import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CoCally',
  description: 'AI-first outbound contact-centre platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
