'use client';
import { useState, useEffect } from 'react';

const C = {
  accent: "#00E5A0", bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", success: "#34D399", blue: "#5B8DEF", purple: "#A78BFA",
};
const cardStyle = { background: '#111827', border: '1px solid #1E2D3D', borderRadius: 12, padding: 20, marginBottom: 16 };
const inputStyle = { background: '#0B0F1A', border: '1px solid #1E2D3D', borderRadius: 8, color: '#F0F4F8', padding: '8px 12px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const labelStyle = { fontSize: 11, color: '#8899AA', marginBottom: 4, display: 'block' };
const btn = (bg, color, disabled) => ({ padding: '8px 18px', background: disabled ? '#1A2332' : bg, color: disabled ? '#556677' : color, border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer' });

const CATEGORIES = [
  { key: 'mapping_data', label: '📦 Mapping & Data' },
  { key: 'claims_piles', label: '📊 Claims Piles Checked' },
  { key: 'quality_review', label: '✅ Quality & Review' },
];

function toKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ── Collision Dialog ─────────────────────────────────────────────────────────
function CollisionDialog({ collision, newName, onResolve, onCancel }) {
  const [choice, setChoice] = useState('');
  const [initials, setInitials] = useState('');

  if (collision.type === 'returning') {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#00000088', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: C.card, borderRadius: 16, padding: 28, maxWidth: 400, width: '90%', border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Returning Member?</div>
          <p style={{ color: C.sub, fontSize: 13, marginBottom: 20 }}>
            There's an inactive member named <strong style={{ color: C.text }}>{collision.existing.name}</strong>. Is this the same person returning?
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => onResolve({ action: 'reactivate', id: collision.existing.id })} style={btn(C.accent, '#0B0F1A', false)}>✓ Yes, reactivate</button>
            <button onClick={() => onResolve({ action: 'new' })} style={btn(C.elevated, C.text, false)}>No, new person</button>
            <button onClick={onCancel} style={btn(C.elevated, C.sub, false)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000088', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 28, maxWidth: 440, width: '90%', border: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Name Already Exists</div>
        <p style={{ color: C.sub, fontSize: 13, marginBottom: 20 }}>
          There's already an active member named <strong style={{ color: C.text }}>{collision.existing.name}</strong>. How would you like to distinguish the new member?
        </p>
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Add initials to differentiate (e.g. "A" → "{newName} A.")</label>
          <input value={initials} onChange={e => setInitials(e.target.value)} placeholder="Enter initial (e.g. A)" style={{ ...inputStyle, width: '100%' }} maxLength={3} />
        </div>
        <div style={{ background: C.elevated, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: C.sub, marginBottom: 20 }}>
          New member will be saved as: <strong style={{ color: C.accent }}>{newName}{initials ? ' ' + initials + '.' : ''}</strong>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => onResolve({ action: 'add_initials', displayName: `${newName} ${initials}.` })} disabled={!initials.trim()} style={btn(C.accent, '#0B0F1A', !initials.trim())}>Add Member</button>
          <button onClick={onCancel} style={btn(C.elevated, C.sub, false)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function TeamPage() {
  const [members, setMembers] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [activeTab, setActiveTab] = useState('members');
  const [loading, setLoading] = useState(true);

  // Add member form
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState(null);
  const [collision, setCollision] = useState(null);
  const [pendingMember, setPendingMember] = useState(null);

  // Add metric form
  const [newMetricLabel, setNewMetricLabel] = useState('');
  const [newMetricCategory, setNewMetricCategory] = useState('mapping_data');
  const [newMetricAppliesToAll, setNewMetricAppliesToAll] = useState(true);
  const [newMetricMembers, setNewMetricMembers] = useState([]);
  const [addingMetric, setAddingMetric] = useState(false);
  const [metricMsg, setMetricMsg] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/team').then(r => r.json()),
      fetch('/api/metrics').then(r => r.json()),
    ]).then(([teamRes, metricsRes]) => {
      setMembers(teamRes.data || []);
      setMetrics(metricsRes.data || []);
      setLoading(false);
    });
  };

  useEffect(() => { load(); }, []);

  const handleAddMember = async () => {
    if (!newName.trim()) return;
    setAdding(true); setAddMsg(null);
    const res = await fetch('/api/team', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), role: newRole.trim() }),
    });
    const result = await res.json();
    setAdding(false);

    if (result.collision) {
      setCollision(result.collision);
      setPendingMember({ name: newName.trim(), role: newRole.trim() });
      return;
    }
    if (result.error) { setAddMsg({ type: 'error', text: result.error }); return; }
    setAddMsg({ type: 'success', text: `${result.data.name} added!` });
    setNewName(''); setNewRole('');
    load();
  };

  const handleCollisionResolve = async (resolution) => {
    setCollision(null);
    if (resolution.action === 'reactivate') {
      await fetch('/api/team', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: resolution.id, active: true }) });
      setAddMsg({ type: 'success', text: 'Member reactivated!' });
      setNewName(''); setNewRole('');
      load();
    } else if (resolution.action === 'new') {
      const res = await fetch('/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: pendingMember.name, role: pendingMember.role, force: true }) });
      const result = await res.json();
      if (result.data) { setAddMsg({ type: 'success', text: `${result.data.name} added!` }); setNewName(''); setNewRole(''); load(); }
    } else if (resolution.action === 'add_initials') {
      const res = await fetch('/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: pendingMember.name, role: pendingMember.role, display_name: resolution.displayName, force: true }) });
      const result = await res.json();
      if (result.data) { setAddMsg({ type: 'success', text: `${resolution.displayName} added!` }); setNewName(''); setNewRole(''); load(); }
    }
    setPendingMember(null);
  };

  const handleRemoveMember = async (member) => {
    if (!confirm(`Remove ${member.name}? Their report data will be preserved.`)) return;
    await fetch('/api/team', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: member.id, active: false }) });
    load();
  };

  const handleAddMetric = async () => {
    if (!newMetricLabel.trim()) return;
    setAddingMetric(true); setMetricMsg(null);
    const key = toKey(newMetricLabel);
    const res = await fetch('/api/metrics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, label: newMetricLabel.trim(), category: newMetricCategory, applies_to_all: newMetricAppliesToAll, applicable_members: newMetricMembers }),
    });
    const result = await res.json();
    setAddingMetric(false);
    if (result.error) { setMetricMsg({ type: 'error', text: result.error }); return; }
    setMetricMsg({ type: 'success', text: `"${result.data.label}" added to ${CATEGORIES.find(c => c.key === newMetricCategory)?.label}` });
    setNewMetricLabel(''); setNewMetricMembers([]);
    load();
  };

  const handleToggleMetric = async (metric) => {
    await fetch('/api/metrics', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: metric.id, active: !metric.active }) });
    load();
  };

  const handleRemoveMetric = async (metric) => {
    if (!confirm(`Remove metric "${metric.label}"? Historical data using this metric will be preserved.`)) return;
    await fetch(`/api/metrics?id=${metric.id}`, { method: 'DELETE' });
    load();
  };

  const activeMembers = members.filter(m => m.active !== false);
  const inactiveMembers = members.filter(m => m.active === false);
  const activeMetrics = metrics.filter(m => m.active !== false);

  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setActiveTab(key)} style={{ padding: '10px 20px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', background: 'transparent', borderBottom: activeTab === key ? `2px solid ${C.accent}` : '2px solid transparent', color: activeTab === key ? C.accent : C.sub }}>
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60 }}>
      {collision && <CollisionDialog collision={collision} newName={newName} onResolve={handleCollisionResolve} onCancel={() => { setCollision(null); setPendingMember(null); }} />}

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Team Management</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: C.sub }}>Manage team members and customize report metrics</p>
      </div>

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 32px', display: 'flex' }}>
        {tabBtn('members', `👥 Members (${activeMembers.length})`)}
        {tabBtn('metrics', `📊 Metrics (${activeMetrics.length})`)}
      </div>

      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 32px' }}>

        {/* ── MEMBERS TAB ─── */}
        {activeTab === 'members' && (
          <div>
            {/* Add member */}
            <div style={cardStyle}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 14 }}>➕ Add Team Member</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'flex-end' }}>
                <div>
                  <label style={labelStyle}>Full Name</label>
                  <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Sophie Akinola" style={{ ...inputStyle, width: '100%' }} onKeyDown={e => e.key === 'Enter' && handleAddMember()} />
                </div>
                <div>
                  <label style={labelStyle}>Role</label>
                  <input value={newRole} onChange={e => setNewRole(e.target.value)} placeholder="e.g. Claims Analyst" style={{ ...inputStyle, width: '100%' }} onKeyDown={e => e.key === 'Enter' && handleAddMember()} />
                </div>
                <button onClick={handleAddMember} disabled={adding || !newName.trim()} style={btn(C.accent, '#0B0F1A', adding || !newName.trim())}>
                  {adding ? 'Adding…' : 'Add'}
                </button>
              </div>
              {addMsg && <div style={{ marginTop: 10, fontSize: 12, color: addMsg.type === 'success' ? C.success : C.danger }}>{addMsg.type === 'success' ? '✓' : '✗'} {addMsg.text}</div>}
            </div>

            {/* Active members */}
            <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 10 }}>ACTIVE MEMBERS</div>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 40, color: C.sub }}>Loading…</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, marginBottom: 24 }}>
                {activeMembers.map(m => (
                  <div key={m.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: `${C.accent}22`, border: `1px solid ${C.accent}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: C.accent, flexShrink: 0 }}>
                      {(m.display_name || m.name).charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.display_name || m.name}</div>
                      <div style={{ fontSize: 11, color: C.sub }}>{m.role || 'No role set'}</div>
                    </div>
                    <button onClick={() => handleRemoveMember(m)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 16, padding: 4 }} title="Remove member">✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Inactive members */}
            {inactiveMembers.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 10 }}>INACTIVE (data preserved)</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                  {inactiveMembers.map(m => (
                    <div key={m.id} style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', gap: 12, opacity: 0.6 }}>
                      <div style={{ width: 38, height: 38, borderRadius: 10, background: C.elevated, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: C.muted, flexShrink: 0 }}>
                        {m.name.charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: C.muted }}>{m.name}</div>
                        <div style={{ fontSize: 11, color: C.muted }}>{m.role}</div>
                      </div>
                      <button onClick={async () => { await fetch('/api/team', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id, active: true }) }); load(); }}
                        style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, color: C.sub, cursor: 'pointer', fontSize: 11, padding: '4px 8px' }}>
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── METRICS TAB ─── */}
        {activeTab === 'metrics' && (
          <div>
            {/* Add metric */}
            <div style={cardStyle}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 14 }}>➕ Add Custom Metric</div>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={labelStyle}>Metric Label</label>
                  <input value={newMetricLabel} onChange={e => setNewMetricLabel(e.target.value)} placeholder="e.g. Benefits Reviewed" style={{ ...inputStyle, width: '100%' }} />
                  {newMetricLabel && <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>Key: {toKey(newMetricLabel)}</div>}
                </div>
                <div>
                  <label style={labelStyle}>Category / Segment</label>
                  <select value={newMetricCategory} onChange={e => setNewMetricCategory(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                    {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={newMetricAppliesToAll} onChange={e => setNewMetricAppliesToAll(e.target.checked)} />
                  <span>Applies to everyone on the team</span>
                </label>
              </div>

              {!newMetricAppliesToAll && (
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Select applicable members</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {activeMembers.map(m => (
                      <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, padding: '5px 12px', borderRadius: 20, background: newMetricMembers.includes(m.id) ? '#00E5A015' : C.elevated, border: `1px solid ${newMetricMembers.includes(m.id) ? C.accent + '44' : C.border}`, color: newMetricMembers.includes(m.id) ? C.accent : C.sub }}>
                        <input type="checkbox" style={{ display: 'none' }} checked={newMetricMembers.includes(m.id)} onChange={e => setNewMetricMembers(prev => e.target.checked ? [...prev, m.id] : prev.filter(id => id !== m.id))} />
                        {m.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button onClick={handleAddMetric} disabled={addingMetric || !newMetricLabel.trim()} style={btn(C.accent, '#0B0F1A', addingMetric || !newMetricLabel.trim())}>
                  {addingMetric ? 'Adding…' : 'Add Metric'}
                </button>
                {metricMsg && <span style={{ fontSize: 12, color: metricMsg.type === 'success' ? C.success : C.danger }}>{metricMsg.type === 'success' ? '✓' : '✗'} {metricMsg.text}</span>}
              </div>
            </div>

            {/* Existing metrics by category */}
            {CATEGORIES.map(cat => {
              const catMetrics = metrics.filter(m => m.category === cat.key);
              if (!catMetrics.length) return null;
              return (
                <div key={cat.key} style={cardStyle}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 14 }}>{cat.label}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {catMetrics.map(m => (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: C.elevated, borderRadius: 8, opacity: m.active === false ? 0.5 : 1 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, color: m.active === false ? C.muted : C.text, fontWeight: 500 }}>{m.label}</div>
                          <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
                            key: {m.key} · {m.applies_to_all ? 'Everyone' : 'Selected members'}
                          </div>
                        </div>
                        <button onClick={() => handleToggleMetric(m)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `1px solid ${C.border}`, background: 'none', color: m.active === false ? C.success : C.warn, cursor: 'pointer' }}>
                          {m.active === false ? 'Enable' : 'Disable'}
                        </button>
                        <button onClick={() => handleRemoveMetric(m)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `1px solid ${C.border}`, background: 'none', color: C.danger, cursor: 'pointer' }}>
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
