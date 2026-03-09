import { DM_Sans } from 'next/font/google';
import Providers from '@/app/providers';
import Sidebar from '@/app/components/Sidebar';
import './globals.css';

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans' });

export const metadata = {
  title: 'Claims Intel | Curacel Health Ops',
  description: 'Curacel Health Operations Platform',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={dmSans.variable} style={{ margin: 0, padding: 0, fontFamily: 'var(--font-dm-sans), sans-serif' }}>
        <Providers>
          <Sidebar />
          <main style={{ marginLeft: 240, minHeight: '100vh' }}>
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
