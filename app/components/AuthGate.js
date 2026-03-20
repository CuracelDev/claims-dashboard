'use client';
// app/components/AuthGate.js
// Global session guard. Wrap app/layout.js children with this.
// ─── Key improvements over v1 ─────────────────────────────────
// 1. GUEST_ROUTES imported from nav.js — single source of truth
// 2. Flash fix: ready stays false until the expired modal is dismissed,
//    so protected page content NEVER shows behind the modal.
// 3. Signout calls /api/auth/signout to delete the DB session row.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getSession, isSessionValid, isGuest, clearSession, getSessionToken } from '../lib/auth';
import { GUEST_ROUTES } from '../lib/nav'; // ← single source of truth

export default function AuthGate({ children }) {
  const router   = useRouter();
  const pathname = usePathname();

  const [ready, setReady]                   = useState(false);
  const [showExpiredModal, setShowExpiredModal] = useState(false);

  const check = useCallback(() => {
    // Login page — always accessible
    if (pathname === '/login') {
      setReady(true);
      return;
    }

    // Public routes — guests welcome
    if (GUEST_ROUTES.includes(pathname)) {
      setReady(true);
      return;
    }

    // Protected route from here ↓
    const session = getSession();

    // No session at all → login
    if (!session) {
      router.replace('/login');
      return; // ready stays false → no flash
    }

    // Guest trying a protected route → login
    if (isGuest()) {
      router.replace('/login');
      return;
    }

    // Session expired — show modal, keep ready=false so content stays hidden
    if (!isSessionValid()) {
      clearSession();
      setShowExpiredModal(true);
      // NOTE: ready intentionally NOT set true here.
      // The modal renders via the portal below without needing children.
      return;
    }

    // All good
    setReady(true);
  }, [pathname]);

  useEffect(() => {
    setReady(false);
    setShowExpiredModal(false);
    check();
  }, [check]);

  // Periodic expiry check every 60s — catches mid-session timeout
  useEffect(() => {
    const interval = setInterval(() => {
      if (pathname === '/login') return;
      if (GUEST_ROUTES.includes(pathname)) return;
      if (!isSessionValid()) {
        clearSession();
        setReady(false);     // hide content immediately
        setShowExpiredModal(true);
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [pathname]);

  async function handleSignInAgain() {
    // Fire-and-forget: delete session from DB
    const token = getSessionToken();
    if (token) {
      fetch('/api/auth/signout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: token }),
      }).catch(() => {});
    }
    clearSession();
    setShowExpiredModal(false);
    router.replace('/login');
  }

  // Tokens — hardcoded dark (modal is system-level, rendered before ThemeContext)
  const C = {
    bg:     '#0B1929',
    card:   '#111E2E',
    border: '#1E2D45',
    text:   '#E8EEF7',
    sub:    '#6B7A99',
    accent: '#00E5A0',
    warn:   '#F59E0B',
  };

  return (
    <>
      {/* Only render children when ready — prevents content flash */}
      {ready && children}

      {/* Session Expired Modal — rendered outside children so it always shows */}
      {showExpiredModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(11,25,41,0.88)',
          backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}>
          <div style={{
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 18, padding: '40px 32px',
            maxWidth: 380, width: '100%',
            textAlign: 'center',
            boxShadow: '0 28px 70px rgba(0,0,0,0.55)',
          }}>
            <div style={{
              width: 54, height: 54, borderRadius: '50%',
              background: C.warn + '18',
              border: `2px solid ${C.warn}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, margin: '0 auto 20px',
            }}>⏱</div>

            <div style={{ fontSize: 19, fontWeight: 700, color: C.text, marginBottom: 10 }}>
              Session Expired
            </div>
            <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.7, marginBottom: 28 }}>
              Your session expired after 2 hours.<br />
              Please sign in again to continue.
            </div>

            <button
              onClick={handleSignInAgain}
              style={{
                width: '100%',
                background: `linear-gradient(135deg, ${C.accent}, #00C48C)`,
                border: 'none', borderRadius: 10, padding: '13px 0',
                fontSize: 14, fontWeight: 700, color: C.bg, cursor: 'pointer',
                boxShadow: '0 4px 16px rgba(0,229,160,0.3)',
              }}
            >
              Sign In Again
            </button>
          </div>
        </div>
      )}
    </>
  );
}
