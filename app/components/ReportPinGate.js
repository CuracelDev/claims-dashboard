'use client';
import { useState, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';

const SESSION_KEY = 'report_auth';

export function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveSession(data) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch {}
}
export function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

export default function ReportPinGate({ members = [], onAuth, existingSession, children }) {
  const { C } = useTheme();
  const [step, setStep] = useState('select');
  const [selectedId, setSelectedId] = useState('');
  const [pin, setPin] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sentMsg, setSentMsg] = useState('');
  const [error, setError] = useState('');
  const [session, setSessionState] = useState(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const s = existingSession || getSession();
    if (s) { setSessionState(s); onAuth?.(s); }
  }, []);

  // Sync if parent passes existingSession after mount
  useEffect(() => {
    if (existingSession && !session) {
      setSessionState(existingSession);
    }
  }, [existingSession]);

  const handleSignOut = () => {
    clearSession();
    setSessionState(null);
    setPin('');
    setStep('select');
    setSelectedId('');
    setError('');
    setSentMsg('');
    onAuth?.(null);
  };

  if (!mounted) return null;

  if (session) {
    return (
      <div>
        {/* Auth bar */}
        <div style={{
          background: `${C.accent}18`, border: `1px solid ${C.accent}35`,
          borderRadius: 10, padding: '10px 16px', marginBottom: 16,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🔒</span>
            <div>
              <div style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>
                {session.memberName}
              </div>
              <div style={{ fontSize: 11, color: C.muted }}>Authenticated for this session</div>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            style={{
              background: 'transparent', border: `1px solid ${C.border}`,
              borderRadius: 8, color: C.sub, padding: '5px 12px',
              fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.target.style.borderColor = C.danger; e.target.style.color = C.danger; }}
            onMouseLeave={e => { e.target.style.borderColor = C.border; e.target.style.color = C.sub; }}
          >
            🚪 Sign Out
          </button>
        </div>
        {children}
      </div>
    );
  }

  const selectedMember = members.find(m => String(m.id) === String(selectedId));

  const inp = {
    background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 10,
    color: C.text, padding: '12px 16px', fontSize: 14, outline: 'none',
    width: '100%', boxSizing: 'border-box', transition: 'border-color 0.15s',
  };

  async function handleSendPin() {
    if (!selectedId) return;
    setSending(true); setError(''); setSentMsg('');
    try {
      const res = await fetch('/api/auth/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', member_id: selectedId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSentMsg(data.message || 'PIN sent to your Slack DM');
      setStep('pin');
    } catch (e) { setError(e.message); }
    finally { setSending(false); }
  }

  async function handleVerify() {
    if (!pin || pin.length < 4) return;
    setVerifying(true); setError('');
    try {
      const res = await fetch('/api/auth/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', member_id: selectedId, pin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const s = { memberId: data.member_id, memberName: data.name };
      saveSession(s);
      setSessionState(s);
      onAuth?.(s);
    } catch (e) { setError(e.message); }
    finally { setVerifying(false); }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', padding: 20,
    }}>
      <div style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 16, padding: 32, width: '100%', maxWidth: 400,
        boxShadow: '0 20px 60px rgba(0,0,0,.2)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14,
            background: `linear-gradient(135deg, ${C.accent}, #00B4D8)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, margin: '0 auto 14px',
          }}>🔐</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6, color: C.text }}>
            {step === 'select' ? 'Who are you?' : `Hi, ${selectedMember?.name || ''}!`}
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>
            {step === 'select'
              ? 'Select your name to get your PIN via Slack'
              : sentMsg || 'Enter the PIN sent to your Slack DM'}
          </div>
        </div>

        {step === 'select' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 6 }}>
                Select your name
              </label>
              <select
                value={selectedId}
                onChange={e => { setSelectedId(e.target.value); setError(''); }}
                style={{ ...inp, cursor: 'pointer' }}
              >
                <option value="">— Choose member —</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {error && (
              <div style={{ fontSize: 12, color: C.danger, marginBottom: 12, textAlign: 'center' }}>
                {error}
              </div>
            )}
            <button
              onClick={handleSendPin}
              disabled={!selectedId || sending}
              style={{
                width: '100%',
                background: selectedId ? C.accent : C.elevated,
                color: selectedId ? '#0B0F1A' : C.muted,
                border: 'none', borderRadius: 10, padding: '12px 0',
                fontSize: 14, fontWeight: 700,
                cursor: selectedId ? 'pointer' : 'not-allowed',
                transition: 'all .15s',
              }}
            >
              {sending ? 'Sending…' : '📲 Send me my PIN'}
            </button>
          </>
        )}

        {step === 'pin' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 6 }}>
                Enter your 6-digit PIN
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="••••••"
                value={pin}
                onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleVerify()}
                style={{
                  ...inp, textAlign: 'center', fontSize: 24,
                  letterSpacing: 10, fontFamily: 'monospace',
                }}
                autoFocus
              />
            </div>
            {error && (
              <div style={{ fontSize: 12, color: C.danger, marginBottom: 12, textAlign: 'center' }}>
                {error}
              </div>
            )}
            <button
              onClick={handleVerify}
              disabled={pin.length < 4 || verifying}
              style={{
                width: '100%',
                background: pin.length >= 4 ? C.accent : C.elevated,
                color: pin.length >= 4 ? '#0B0F1A' : C.muted,
                border: 'none', borderRadius: 10, padding: '12px 0',
                fontSize: 14, fontWeight: 700,
                cursor: pin.length >= 4 ? 'pointer' : 'not-allowed',
                marginBottom: 10, transition: 'all .15s',
              }}
            >
              {verifying ? 'Verifying…' : '→ Sign In'}
            </button>
            <div style={{ textAlign: 'center' }}>
              <button
                onClick={() => { setStep('select'); setPin(''); setError(''); setSentMsg(''); }}
                style={{
                  background: 'transparent', border: 'none',
                  color: C.muted, fontSize: 12, cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                ← Back / Resend PIN
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
