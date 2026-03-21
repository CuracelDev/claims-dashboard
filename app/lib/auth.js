// app/lib/auth.js
const SESSION_KEY = 'claims_intel_session';
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours

export function setSession({ sessionToken, memberId, memberName }) {
  const session = {
    session_token: sessionToken,
    member_id:     memberId ?? null,
    member_name:   memberName || 'Guest',
    mode:          memberId ? 'auth' : 'guest',   // ← explicit mode
    expires_at:    Date.now() + SESSION_TTL,
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  return session;
}

export function setGuestSession() {
  return setSession({ sessionToken: null, memberId: null, memberName: 'Guest' });
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);

    // Auto-cleanup expired AUTH sessions — guest sessions never expire
    if (session.mode === 'auth' && Date.now() > session.expires_at) {
      clearSession();
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

// Guest sessions are always valid for UI purposes
export function isSessionValid() {
  const session = getSession();
  if (!session) return false;
  if (session.mode === 'guest') return true;
  return Date.now() < session.expires_at;
}

export function isAuthenticated() {
  const session = getSession();
  if (!session || !isSessionValid()) return false;
  return session.mode === 'auth';
}

export function isGuest() {
  const session = getSession();
  if (!session) return true;
  return session.mode === 'guest';
}

// Clear everything on logout or mode switch
export function resetSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('claims_intel_auth_session');
    localStorage.removeItem('claims_intel_guest_state');
  } catch {}
}

export function getMemberName()   { return getSession()?.member_name   ?? null; }
export function getMemberId()     { return getSession()?.member_id     ?? null; }
export function getSessionToken() { return getSession()?.session_token ?? null; }
export function clearSession()    { try { localStorage.removeItem(SESSION_KEY); } catch {} }
