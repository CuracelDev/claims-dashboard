'use client';
// app/login/page.js — Claims Intel Login
// Built by Fade & TomBoy ✦

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { setSession, setGuestSession, isSessionValid, resetSession } from '../lib/auth';

const AVATAR_COLOURS = [
  '#7B61FF', '#00E5A0', '#5B8DEF', '#F59E0B',
  '#FF6B6B', '#06B6D4', '#A78BFA', '#34D399',
];

const C = {
  bg: '#0B1929', card: '#111E2E', elevated: '#1A2A3F',
  border: '#1E2D45', text: '#E8EEF7', sub: '#6B7A99',
  muted: '#3A4A5E', accent: '#00E5A0', danger: '#FF4D4D',
  warn: '#F59E0B', inputBg: '#0F1923',
};

function MemberCard({ member, onSelect }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={() => onSelect(member)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: C.elevated,
        border: `1px solid ${hovered ? member.colour : C.border}`,
        borderRadius: 12, padding: '16px 12px', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
        transition: 'all 0.15s',
        boxShadow: hovered ? `0 4px 16px ${member.colour}22` : 'none',
      }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        background: member.colour + '20',
        border: `2px solid ${member.colour}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, fontWeight: 700, color: member.colour,
      }}>{member.initials}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.text, textAlign: 'center', lineHeight: 1.3 }}>
        {member.name}
      </div>
      {!member.has_pin && (
        <div style={{ fontSize: 9, color: C.warn, fontWeight: 600 }}>No PIN set</div>
      )}
    </button>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [members,    setMembers]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [selected,   setSelected]   = useState(null);
  const [pin,        setPin]        = useState('');
  const [error,      setError]      = useState('');
  const [verifying,  setVerifying]  = useState(false);
  const [sending,    setSending]    = useState(false);
  const [pinSent,    setPinSent]    = useState(false);
  const [shake,      setShake]      = useState(false);

  useEffect(() => {
    // Only auto-redirect authenticated users — guests should be able to sign in
    const s = typeof window !== 'undefined' && JSON.parse(localStorage.getItem('claims_intel_session') || 'null');
    if (s && s.mode === 'auth' && Date.now() < s.expires_at) router.replace('/');
  }, []);

  useEffect(() => {
    fetch('/api/auth/members')
      .then(r => r.json())
      .then(d => { setMembers(d.members || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  function handleSelectMember(member) {
    setSelected(member);
    setPin(''); setError(''); setPinSent(false);
  }

  function handleBack() {
    setSelected(null);
    setPin(''); setError(''); setPinSent(false);
  }

  async function handleSendPin() {
    setSending(true); setError('');
    try {
      const res = await fetch('/api/auth/generate-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: selected.id }),
      });
      const data = await res.json();
      if (data.ok) {
        setPinSent(true);
        // Refresh members list so has_pin updates
        fetch('/api/auth/members')
          .then(r => r.json())
          .then(d => {
            const updated = (d.members || []).find(m => m.id === selected.id);
            if (updated) setSelected(prev => ({ ...prev, has_pin: updated.has_pin }));
          });
      } else {
        setError(data.error || 'Could not send PIN. Try again.');
      }
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setSending(false);
    }
  }

  async function handleVerify() {
    if (!pin.trim()) return;
    setVerifying(true); setError('');
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: selected.id, pin: pin.trim() }),
      });
      const data = await res.json();
      if (data.valid) {
        resetSession();
    setSession({ sessionToken: data.session_token, memberId: data.member_id, memberName: data.member_name });
        router.replace('/');
      } else {
        setError(data.error || 'Incorrect PIN. Try again.');
        setPin('');
        setShake(true);
        setTimeout(() => setShake(false), 600);
      }
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setVerifying(false);
    }
  }

  function handleGuest() {
    resetSession();
    setGuestSession();
    router.replace('/');
  }

  return (
    <div style={{
      minHeight: '100vh', background: C.bg,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '40px 20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {/* Logo */}
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div style={{
          width: 54, height: 54,
          background: 'linear-gradient(135deg, #7B61FF 0%, #00E5A0 100%)',
          borderRadius: 15, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: 800, color: '#fff',
          margin: '0 auto 14px',
          boxShadow: '0 8px 24px rgba(0,229,160,0.25)',
        }}>C</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: '-0.3px' }}>Claims Intel</div>
        <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>Curacel Data Ops</div>
      </div>

      {/* Card */}
      <div style={{
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 18,
        padding: '32px 28px', width: '100%',
        maxWidth: selected ? 420 : 620,
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
        transition: 'max-width 0.25s ease',
      }}>

        {/* Step 1 — Name grid */}
        {!selected && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ fontSize: 19, fontWeight: 700, color: C.text }}>Who are you?</div>
              <div style={{ fontSize: 13, color: C.sub, marginTop: 5 }}>Select your name to sign in</div>
            </div>

            {loading ? (
              <div style={{ textAlign: 'center', color: C.sub, padding: '40px 0', fontSize: 13 }}>Loading team...</div>
            ) : (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                gap: 10, marginBottom: 24,
              }}>
                {members.map((m, i) => (
                  <MemberCard
                    key={m.id}
                    member={{ ...m, colour: AVATAR_COLOURS[i % AVATAR_COLOURS.length] }}
                    onSelect={handleSelectMember}
                  />
                ))}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <div style={{ flex: 1, height: 1, background: C.border }} />
              <span style={{ fontSize: 11, color: C.muted, letterSpacing: '0.06em' }}>OR</span>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>

            <button
              onClick={handleGuest}
              style={{
                width: '100%', background: 'transparent',
                border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 0',
                color: C.sub, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = C.muted; }}
              onMouseLeave={e => { e.currentTarget.style.color = C.sub; e.currentTarget.style.borderColor = C.border; }}
            >
              Continue as Guest
            </button>
          </>
        )}

        {/* Step 2 — PIN entry or Send PIN */}
        {selected && (
          <div style={{ animation: shake ? 'shake 0.5s ease' : 'none' }}>
            {/* Member header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
              <button onClick={handleBack} style={{
                background: C.elevated, border: `1px solid ${C.border}`,
                borderRadius: 8, width: 34, height: 34, cursor: 'pointer',
                color: C.sub, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>←</button>
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: selected.colour + '20', border: `2px solid ${selected.colour}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 700, color: selected.colour, flexShrink: 0,
              }}>{selected.initials}</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{selected.name}</div>
                <div style={{ fontSize: 12, color: C.sub }}>
                  {sending ? 'Sending PIN...' : pinSent ? 'PIN sent — check Slack' : !selected.slack_user_id ? 'No Slack account linked' : 'Click below to get your PIN'}
                </div>
              </div>
            </div>

            {/* No Slack linked */}
            {!selected.slack_user_id && (
              <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
                <div style={{ fontSize: 13, color: C.warn, marginBottom: 8 }}>⚠ No Slack account linked.</div>
                <div style={{ fontSize: 12, color: C.sub }}>Ask your team lead to add your Slack ID in Team Management.</div>
              </div>
            )}
            {/* Send PIN button */}
            {selected.slack_user_id && !pinSent && !sending && (
              <button
                onClick={handleSendPin}
                style={{
                  width: '100%', marginBottom: 16,
                  background: `linear-gradient(135deg, #7B61FF, ${C.accent})`,
                  border: 'none', borderRadius: 10, padding: '13px 0',
                  fontSize: 14, fontWeight: 700, color: C.bg, cursor: 'pointer',
                }}
              >📲 Send PIN to Slack</button>
            )}
            {sending && (
              <div style={{ textAlign: 'center', padding: '12px 0 16px', fontSize: 13, color: C.sub }}>
                📲 Sending PIN to your Slack DM...
              </div>
            )}

            {/* PIN sent confirmation */}
            {pinSent && !selected.has_pin && (
              <div style={{
                background: `${C.accent}12`, border: `1px solid ${C.accent}33`,
                borderRadius: 10, padding: '14px 16px', marginBottom: 18, textAlign: 'center',
              }}>
                <div style={{ fontSize: 20, marginBottom: 8 }}>📲</div>
                <div style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>PIN sent to your Slack DM!</div>
                <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>Check your Slack messages, then enter it below.</div>
              </div>
            )}

            {/* PIN input — show once PIN sent */}
            {(pinSent || (!sending && !selected.slack_user_id === false)) && !sending && selected.slack_user_id && (
              <>
                <div style={{ marginBottom: 18 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: C.sub,
                    marginBottom: 8, letterSpacing: '0.07em', textTransform: 'uppercase',
                  }}>PIN</div>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={e => { setPin(e.target.value); setError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleVerify()}
                    placeholder="••••••"
                    autoFocus
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      background: C.inputBg,
                      border: `1px solid ${error ? C.danger : C.border}`,
                      borderRadius: 10, padding: '13px 16px',
                      fontSize: 22, color: C.text, outline: 'none',
                      letterSpacing: '0.4em', textAlign: 'center',
                      transition: 'border-color 0.15s',
                    }}
                    onFocus={e => { if (!error) e.target.style.borderColor = C.accent; }}
                    onBlur={e => { if (!error) e.target.style.borderColor = C.border; }}
                  />
                  {error && <div style={{ fontSize: 12, color: C.danger, marginTop: 7 }}>⚠ {error}</div>}
                </div>

                <button
                  onClick={handleVerify}
                  disabled={verifying || !pin.trim()}
                  style={{
                    width: '100%',
                    background: pin.trim() && !verifying
                      ? `linear-gradient(135deg, ${C.accent}, #00C48C)`
                      : C.elevated,
                    border: 'none', borderRadius: 10, padding: '13px 0',
                    fontSize: 14, fontWeight: 700,
                    color: pin.trim() && !verifying ? C.bg : C.sub,
                    cursor: pin.trim() && !verifying ? 'pointer' : 'not-allowed',
                    boxShadow: pin.trim() && !verifying ? '0 4px 16px rgba(0,229,160,0.3)' : 'none',
                    transition: 'all 0.15s',
                  }}
                >
                  {verifying ? 'Verifying...' : 'Sign In →'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 28, textAlign: 'center' }}>
        <div style={{ fontSize: 11, color: C.muted }}>Claims Intel · v6.0 · Phase 7</div>
        <div style={{
          fontSize: 11, marginTop: 5, fontWeight: 600,
          background: 'linear-gradient(90deg, #7B61FF, #00E5A0)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>Built by Fade & TomBoy ✦</div>
      </div>

      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-5px); }
          80% { transform: translateX(5px); }
        }
      `}</style>
    </div>
  );
}
