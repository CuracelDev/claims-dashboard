'use client';
import { useState, useEffect } from 'react';

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C",
};

const SESSION_KEY = 'report_auth';

// Returns { memberId, memberName } if authenticated, else null
function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function setSession(data) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch {}
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

export { getSession, clearSession };

export default function ReportPinGate({ members = [], onAuth, children }) {
  const [step, setStep] = useState('select'); // select | pin
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
    const s = getSession();
    if (s) { setSessionState(s); onAuth?.(s); }
  }, []);

  if (!mounted) return null;
  if (session) {
    return (
      <div>
        {/* Slim auth bar shown at top of form */}
        <div style={{
          background: `${C.accent}15`, border: `1px solid ${C.accent}33`,
          borderRadius: 10, padding: '8px 16px', marginBottom: 16,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 12, color: C.accent }}>
            🔐 Submitting as <strong>{session.memberName}</strong>
          </span>
          <button onClick={() => { clearSession(); setSessionState(null); setPin(''); setStep('select'); }}
            style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, padding: '3px 10px', fontSize: 11, cursor: 'pointer' }}>
            Switch
          </button>
        </div>
        {children}
      </div>
    );
  }

  const selectedMember = members.find(m => String(m.id) === String(selectedId));

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
      setSession(s);
      setSessionState(s);
      onAuth?.(s);
    } catch (e) { setError(e.message); }
    finally { setVerifying(false); }
  }

  const inp = {
    background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 10,
    color: C.text, padding: '12px 16px', fontSize: 14, outline: 'none',
    width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', padding: 20 }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 32, width: '100%', maxWidth: 400, boxShadow: '0 20px 60px rgba(0,0,0,.4)' }}>

        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: `linear-gradient(135deg,${C.accent},#00B4D8)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, margin: '0 auto 14px' }}>🔐</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
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
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 6 }}>Select your name</label>
              <select value={selectedId} onChange={e => { setSelectedId(e.target.value); setError(''); }}
                style={{ ...inp, cursor: 'pointer' }}>
                <option value="">— Choose member —</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {error && <div style={{ fontSize: 12, color: C.danger, marginBottom: 12, textAlign: 'center' }}>{error}</div>}
            <button
              onClick={handleSendPin}
              disabled={!selectedId || sending}
              style={{ width: '100%', background: selectedId ? C.accent : C.elevated, color: selectedId ? C.bg : C.muted, border: 'none', borderRadius: 10, padding: '12px 0', fontSize: 14, fontWeight: 700, cursor: selectedId ? 'pointer' : 'not-allowed', transition: 'all .15s' }}
            >
              {sending ? 'Sending...' : '📲 Send me my PIN'}
            </button>
          </>
        )}

        {step === 'pin' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 6 }}>Enter your 6-digit PIN</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="••••••"
                value={pin}
                onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleVerify()}
                style={{ ...inp, textAlign: 'center', fontSize: 22, letterSpacing: 8, fontFamily: 'monospace' }}
                autoFocus
              />
            </div>
            {error && <div style={{ fontSize: 12, color: C.danger, marginBottom: 12, textAlign: 'center' }}>{error}</div>}
            <button
              onClick={handleVerify}
              disabled={pin.length < 4 || verifying}
              style={{ width: '100%', background: pin.length >= 4 ? C.accent : C.elevated, color: pin.length >= 4 ? C.bg : C.muted, border: 'none', borderRadius: 10, padding: '12px 0', fontSize: 14, fontWeight: 700, cursor: pin.length >= 4 ? 'pointer' : 'not-allowed', marginBottom: 10, transition: 'all .15s' }}
            >
              {verifying ? 'Verifying...' : '→ Sign In'}
            </button>
            <div style={{ textAlign: 'center' }}>
              <button onClick={() => { setStep('select'); setPin(''); setError(''); setSentMsg(''); }}
                style={{ background: 'transparent', border: 'none', color: C.muted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
                ← Back / Resend PIN
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
