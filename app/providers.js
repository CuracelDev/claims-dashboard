'use client';
import { ThemeProvider } from '@/app/context/ThemeContext';

export default function Providers({ children }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
