'use client';
// app/components/AuthGate.js — v2 clean

import { useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getSession, isSessionValid, isGuest, resetSession, getSessionToken } from '../lib/auth';
import { GUEST_ROUTES } from '../lib/nav';

export default function AuthGate({ children }) {
  const router   = useRouter();
  const pathname = usePathname();

  const [ready,            setReady]            = useState(false);
  const [showExpiredModal, setShowExpiredModal] = useState(false);

  const check = useCallback(() => {
    if (pathname === '/login') { setReady(true); return; }

    // getSession() auto-cleans expired auth sessions — key fix
    const session = getSession();
    const guest   = isGuest();

    // Guest routes — accessible after cleanup
    if (GUEST_ROUTES.includes(pathname)) { setReady(true); return; }

    // No session → login
    if (!session) { router.replace('/login'); return; }

    // Guest on protected route → login
    if (guest) { router.replace('/login'); return; }

    // Auth session expired → modal
    if (!isSessionValid()) {
      resetSession();
      setShowExpiredModal(true);
      return;
    }

    setReady(true);
  }, [pathname, router]);

  useEffect(() => {
    setReady(false);
    setShowExpiredModal(false);
    check();
  }, [check]);

  // Periodic expiry check — only for auth users on protected routes
  useEffect(() => {
    const interval = setInterval(() => {
      if (pathname === '/login') return;
      if (GUEST_ROUTES.includes(pathname)) return;
      const session = getSession();
      if (session && !isGuest() && !isSessionValid()) {
        resetSession();
        setReady(false);
        setShowExpiredModal(true);
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [pathname]);

  async function handleSignInAgain() {
    const token = getSessionToken();
    if (token) {
      fetch('/api/auth/signout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: token }),
      }).catch(() => {});
    }
    resetSession();
    setShowExpiredModal(false);
    router.replace('/login');
  }

  const C = {
    bg: '#0B1929', card: '#111E2E', border: '#1E2D45',
    text: '#E8EEF7', sub: '#6B7A99', accent: '#00E5A0', warn: '#F59E0B',
  };

  return (
    <>
      {ready && children}
      {showExpiredModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(11,25,41,0.88)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}>
          <div style={{
            background: C.card, border: `1px solid ${C.border}`,
            borderRadius: 18, padding: '40px 32px',
            maxWidth: 380, width: '100%', textAlign: 'center',
            boxShadow: '0 28px 70px rgba(0,0,0,0.55)',
          }}>
            <div style={{
              width: 54, height: 54, borderRadius: '50%',
              background: C.warn + '18', border: `2px solid ${C.warn}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, margin: '0 auto 20px',
            }}>⏱</div>
            <div style={{ fontSize: 19, fontWeight: 700, color: C.text, marginBottom: 10 }}>Session Expired</div>
            <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.7, marginBottom: 28 }}>
              Your session expired after 2 hours.<br />Please sign in again to continue.
            </div>
            <button onClick={handleSignInAgain} style={{
              width: '100%',
              background: `linear-gradient(135deg, ${C.accent}, #00C48C)`,
              border: 'none', borderRadius: 10, padding: '13px 0',
              fontSize: 14, fontWeight: 700, color: C.bg, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,229,160,0.3)',
            }}>Sign In Again</button>
          </div>
        </div>
      )}
    </>
  );
}
