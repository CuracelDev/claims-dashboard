// PATH: app/settings/page.js
'use client';
import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

const CATEGORY_META = {
  slack:         { label: 'Slack Channels',            icon: '💬', desc: 'Control where each type of message is sent in Slack. Use the channel ID (starts with C0...), not the name.' },
  notifications: { label: 'Notifications & Timing',   icon: '🔔', desc: 'Control when automated messages are sent. Times are in Lagos time (WAT / UTC+1).' },
  thresholds:    { label: 'Intelligence Thresholds',   icon: '⚡', desc: 'Tune how the platform detects spikes, flags at-risk targets, and filters noise from insights.' },
  features:      { label: 'Feature Flags & Identity',  icon: '🎛️', desc: 'Toggle platform features on/off and configure global identity settings.' },
};

const TYPE_META = {
  text:    { inputType: 'text' },
  number:  { inputType: 'number' },
  time:    { inputType: 'time' },
  boolean: { inputType: 'toggle' },
};

function SettingRow({ setting, onChange, dirty }) {
  const { C } = useTheme();
  const meta = TYPE_META[setting.type] || TYPE_META.text;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 280px',
      gap: 20, alignItems: 'center',
      padding: '14px 20px',
      borderBottom: `1px solid ${C.border}`,
      background: dirty ? `${C.warn}08` : 'transparent',
      transition: 'background 0.2s',
    }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>
          {setting.label}
          {dirty && <span style={{ marginLeft: 8, fontSize: 11, color: C.warn, fontWeight: 700 }}>● unsaved</span>}
        </div>
        <div style={{ fontSize: 12, color: C.sub }}>{setting.description}</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4, fontFamily: 'monospace' }}>
          key: {setting.key}
        </div>
      </div>

      {meta.inputType === 'toggle' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 13, color: setting.value === 'true' ? C.accent : C.sub }}>
            {setting.value === 'true' ? 'Enabled' : 'Disabled'}
          </span>
          <div
            onClick={() => onChange(setting.key, setting.value === 'true' ? 'false' : 'true')}
            style={{
              width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
              background: setting.value === 'true' ? C.accent : C.muted,
              position: 'relative', transition: 'background 0.2s',
            }}
          >
            <div style={{
              position: 'absolute', top: 3, left: setting.value === 'true' ? 23 : 3,
              width: 18, height: 18, borderRadius: '50%', background: '#fff',
              transition: 'left 0.2s',
            }} />
          </div>
        </div>
      ) : (
        <input
          type={meta.inputType}
          value={setting.value}
          onChange={e => onChange(setting.key, e.target.value)}
          step={setting.type === 'number' ? '0.1' : undefined}
          style={{
            background: C.elevated, border: `1px solid ${dirty ? C.warn : C.border}`,
            borderRadius: 8, color: C.text, padding: '8px 12px',
            fontSize: 13, width: '100%', outline: 'none',
            fontFamily: setting.key.startsWith('slack_channel') ? 'monospace' : 'inherit',
            boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  );
}

function CategoryCard({ category, settings, localValues, onChange, C }) {
  const meta = CATEGORY_META[category];
  const dirtyCount = settings.filter(s => localValues[s.key] !== s.value).length;

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, overflow: 'hidden', marginBottom: 20,
    }}>
      <div style={{
        padding: '16px 20px',
        background: C.elevated,
        borderBottom: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
            {meta.icon}  {meta.label}
          </div>
          <div style={{ fontSize: 12, color: C.sub, marginTop: 3 }}>{meta.desc}</div>
        </div>
        {dirtyCount > 0 && (
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
            background: `${C.warn}22`, color: C.warn, border: `1px solid ${C.warn}44`,
          }}>
            {dirtyCount} unsaved
          </span>
        )}
      </div>
      {settings.map(s => (
        <SettingRow
          key={s.key}
          setting={{ ...s, value: localValues[s.key] ?? s.value }}
          onChange={onChange}
          dirty={localValues[s.key] !== undefined && localValues[s.key] !== s.value}
        />
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const { C } = useTheme();
  const [settings, setSettings]       = useState([]);
  const [localValues, setLocalValues] = useState({});
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [saveMsg, setSaveMsg]         = useState(null);
  const [lastSaved, setLastSaved]     = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/settings')
      .then(r => r.json())
      .then(({ settings: s }) => {
        setSettings(s || []);
        setLocalValues({});
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleChange = (key, value) => {
    setLocalValues(prev => {
      const original = settings.find(s => s.key === key)?.value;
      if (value === original) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });
    setSaveMsg(null);
  };

  const dirtyKeys = Object.keys(localValues);
  const hasDirty = dirtyKeys.length > 0;

  const handleSave = async () => {
    if (!hasDirty) return;
    setSaving(true); setSaveMsg(null);
    try {
      const updates = dirtyKeys.map(key => ({ key, value: localValues[key] }));
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error('Some settings failed to save');
      setSaveMsg({ type: 'success', text: `${updates.length} setting${updates.length > 1 ? 's' : ''} saved` });
      setLastSaved(new Date());
      load(); // reload fresh from DB
    } catch (err) {
      setSaveMsg({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setLocalValues({});
    setSaveMsg(null);
  };

  // Group by category
  const byCategory = {};
  for (const s of settings) {
    if (!byCategory[s.category]) byCategory[s.category] = [];
    byCategory[s.category].push(s);
  }

  const categoryOrder = ['slack', 'notifications', 'thresholds', 'features'];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 80 }}>
      {/* Header */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: C.text }}>
            ⚙️ Platform Settings
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: C.sub }}>
            Configure Slack channels, notification timing, intelligence thresholds and feature flags
            {lastSaved && (
              <span style={{ marginLeft: 12, color: C.muted }}>
                · Last saved {lastSaved.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {saveMsg && (
            <span style={{ fontSize: 13, color: saveMsg.type === 'success' ? C.accent : C.danger }}>
              {saveMsg.type === 'success' ? '✓' : '✗'} {saveMsg.text}
            </span>
          )}
          {hasDirty && (
            <button onClick={handleDiscard} style={{
              padding: '8px 16px', background: C.elevated, border: `1px solid ${C.border}`,
              borderRadius: 8, color: C.sub, fontSize: 13, cursor: 'pointer',
            }}>
              Discard
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!hasDirty || saving}
            style={{
              padding: '8px 20px',
              background: hasDirty && !saving ? C.accent : C.muted,
              color: hasDirty && !saving ? '#0B1929' : C.sub,
              border: 'none', borderRadius: 8, fontWeight: 700,
              fontSize: 13, cursor: hasDirty && !saving ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s',
            }}
          >
            {saving ? 'Saving…' : hasDirty ? `Save ${dirtyKeys.length} change${dirtyKeys.length > 1 ? 's' : ''}` : 'No changes'}
          </button>
        </div>
      </div>

      <div style={{ padding: '24px' }}>
        {/* Info banner */}
        <div style={{
          background: `${C.blue}12`, border: `1px solid ${C.blue}33`,
          borderRadius: 10, padding: '12px 16px', marginBottom: 24,
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: 16 }}>ℹ️</span>
          <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
            Changes take effect immediately — no redeployment needed. All API routes read from this table.
            <strong style={{ color: C.text }}> Slack channel IDs</strong> start with C0 (not the # name).
            Get them from Slack → right-click channel → Copy link → the ID is the last part.
            <strong style={{ color: C.text }}> Times</strong> are in WAT (Lagos, UTC+1).
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 80, color: C.sub }}>Loading settings…</div>
        ) : (
          categoryOrder.map(cat => {
            const catSettings = byCategory[cat] || [];
            if (!catSettings.length) return null;
            return (
              <CategoryCard
                key={cat}
                category={cat}
                settings={catSettings}
                localValues={localValues}
                onChange={handleChange}
                C={C}
              />
            );
          })
        )}

        {/* Footer note */}
        <div style={{ fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 24 }}>
          Secrets like SLACK_BOT_TOKEN and ANTHROPIC_API_KEY remain in Vercel environment variables — they are never stored here.
          Settings changes are logged with updated_at timestamp in the platform_settings table.
        </div>
      </div>
    </div>
  );
}
