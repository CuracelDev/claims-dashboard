// app/lib/auth.js
// ─────────────────────────────────────────────────────────────
// Client-side session helpers.
// Session is backed by a server-generated UUID token stored in
// Supabase `sessions` table. The client stores the token only —
// it cannot forge member_id or is_guest without a valid DB row.
// ─────────────────────────────────────────────────────────────

const SESSION_KEY = 'claims_intel_session';
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours in ms

/**
 * Called after /api/auth/verify returns a valid token.
 * Stores minimal session info — is_guest is derived from member_id.
 */
export function setSession({ sessionToken, memberId, memberName }) {
  const session = {
    session_token: sessionToken,            // UUID from server — cannot be forged
    member_id: memberId ?? null,            // null = guest
    member_name: memberName || 'Guest',
    expires_at: Date.now() + SESSION_TTL,
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // SSR guard — localStorage not available server-side
  }
  return session;
}

/** Set a guest session — no token needed, member_id stays null */
export function setGuestSession() {
  return setSession({ sessionToken: null, memberId: null, memberName: 'Guest' });
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** True if session exists AND hasn't expired */
export function isSessionValid() {
  const session = getSession();
  if (!session) return false;
  return Date.now() < session.expires_at;
}

/** True if logged in AND not a guest */
export function isAuthenticated() {
  const session = getSession();
  if (!session || !isSessionValid()) return false;
  return session.member_id !== null;
}

/** is_guest is derived — member_id null = guest. Never trust a stored flag. */
export function isGuest() {
  const session = getSession();
  if (!session) return true;
  return session.member_id === null;
}

export function getMemberName() {
  return getSession()?.member_name ?? null;
}

export function getMemberId() {
  return getSession()?.member_id ?? null;
}

export function getSessionToken() {
  return getSession()?.session_token ?? null;
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}
