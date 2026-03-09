'use client';
import { createContext, useContext, useState, useEffect } from 'react';

export const DARK = {
  accent: '#00E5A0', accentDim: '#00B87D',
  bg: '#0B0F1A', card: '#111827', elevated: '#1A2332',
  border: '#1E2D3D', text: '#F0F4F8', sub: '#8899AA', muted: '#556677',
  danger: '#FF5C5C', warn: '#FFB84D', success: '#34D399',
  blue: '#5B8DEF', purple: '#A78BFA', orange: '#FB923C',
  sidebarBg: '#111827', inputBg: '#1A2332',
};

export const LIGHT = {
  accent: '#00A36C', accentDim: '#007A52',
  bg: '#F0F4F8', card: '#FFFFFF', elevated: '#EDF2F7',
  border: '#E2E8F0', text: '#0D1117', sub: '#4A5568', muted: '#A0AEC0',
  danger: '#E53E3E', warn: '#D97706', success: '#059669',
  blue: '#3B72D9', purple: '#7C3AED', orange: '#EA580C',
  sidebarBg: '#FFFFFF', inputBg: '#EDF2F7',
};

const ThemeContext = createContext({ theme: 'dark', C: DARK, toggle: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState('dark');

  useEffect(() => {
    const saved = localStorage.getItem('curacel_theme') || 'dark';
    setTheme(saved);
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('curacel_theme', next);
  };

  return (
    <ThemeContext.Provider value={{ theme, C: theme === 'dark' ? DARK : LIGHT, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
