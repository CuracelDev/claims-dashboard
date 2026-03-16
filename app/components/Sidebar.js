'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from '../context/ThemeContext';

const NAV = [
  {
    section: 'ANALYTICS',
    items: [
      { href: '/',              icon: '📊', label: 'Claims Dashboard', sub: 'Real-time monitoring' },
      { href: '/query-builder', icon: '⚡', label: 'Query Builder',    sub: 'SQL generator & templates' },
    ],
  },
  {
    section: 'OPERATIONS',
    items: [
      { href: '/reports',        icon: '📝', label: 'Daily Reports',   sub: 'Team reporting',   exact: true },
      { href: '/reports/weekly', icon: '📅', label: 'Weekly Summary',  sub: 'Aggregated view' },
      { href: '/team',           icon: '👥', label: 'Team Management', sub: 'Members & metrics' },
      { href: '/tasks',          icon: '✅', label: 'Task Management', sub: 'Assign & track work' },
    ],
  },
  {
    section: 'INTELLIGENCE',
    items: [
      { href: '/qa',      icon: '🔍', label: 'QA Flag Tracker', sub: 'Claims quality audit' },
      { href: '/ops',     icon: '⚡', label: 'Ops Overview',     sub: 'Team performance' },
      { href: '/targets', icon: '🎯', label: 'Targets',          sub: 'Weekly goals & alerts' },
    ],
  },
  {
    section: 'TOOLS',
    items: [
      { href: '/tools',  icon: '🔧', label: 'Operational Tools', sub: 'Utilities & batch ops' },
      { href: '/tools/insurer-feedback',   icon: '📋', label: 'Insurer Feedback',  sub: 'JBL & insurer review' },
    ],
  },
  {
    section: 'SYSTEM',
    items: [
      { href: '/settings', icon: '⚙️', label: 'Settings', sub: 'Slack, alerts & config' },
    ],
  },
  {
    section: 'COMING SOON',
    items: [
      { href: '/errors', icon: '🔴', label: 'Error Tracking',    disabled: true },
      { href: '/okrs',   icon: '🎯', label: 'OKR Tracker',       disabled: true },
      { href: '/slack',  icon: '💬', label: 'Slack Intelligence', disabled: true },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { theme, C, toggle } = useTheme();

  const isActive = (item) => {
    if (item.exact) return pathname === item.href;
    if (item.href === '/') return pathname === '/';
    return pathname === item.href || pathname.startsWith(item.href + '/');
  };

  return (
    <aside style={{
      width: 240, minHeight: '100vh', background: C.sidebarBg,
      borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column',
      position: 'fixed', top: 0, left: 0, zIndex: 100,
      transition: 'background 0.2s, border-color 0.2s',
    }}>
      {/* Logo */}
      <div style={{ padding: '20px 18px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, background: C.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 700, color: '#0B0F1A',
          }}>C</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Claims Intel</div>
            <div style={{ fontSize: 10, color: C.muted }}>Curacel Health Ops</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 10px', overflowY: 'auto' }}>
        {NAV.map(group => (
          <div key={group.section} style={{ marginBottom: 22 }}>
            <div style={{
              fontSize: 10, fontWeight: 600, color: C.muted,
              padding: '0 8px', marginBottom: 4, letterSpacing: '0.08em',
            }}>
              {group.section}
            </div>
            {group.items.map(item => {
              const active = isActive(item);
              if (item.disabled) {
                return (
                  <div key={item.href} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 8, marginBottom: 2,
                    opacity: 0.35, cursor: 'not-allowed',
                  }}>
                    <span style={{ fontSize: 15 }}>{item.icon}</span>
                    <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 13, color: C.muted }}>{item.label}</span>
                      <span style={{
                        fontSize: 9, background: C.elevated, color: C.muted,
                        padding: '1px 5px', borderRadius: 4,
                      }}>Soon</span>
                    </div>
                  </div>
                );
              }
              return (
                <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 8, marginBottom: 2,
                    background: active ? `${C.accent}15` : 'transparent',
                    border: active ? `1px solid ${C.accent}30` : '1px solid transparent',
                    cursor: 'pointer', transition: 'all .15s',
                  }}>
                    <span style={{ fontSize: 15 }}>{item.icon}</span>
                    <div>
                      <div style={{
                        fontSize: 13, fontWeight: active ? 600 : 400,
                        color: active ? C.accent : C.text,
                      }}>{item.label}</div>
                      {item.sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{item.sub}</div>}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div style={{ padding: '12px 18px', borderTop: `1px solid ${C.border}` }}>
        {/* Theme Toggle */}
        <button
          onClick={toggle}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '8px 12px', cursor: 'pointer', marginBottom: 10,
            transition: 'all 0.2s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14 }}>{theme === 'dark' ? '🌙' : '☀️'}</span>
            <span style={{ fontSize: 12, color: C.sub }}>{theme === 'dark' ? 'Dark Mode' : 'Light Mode'}</span>
          </div>
          {/* Toggle pill */}
          <div style={{
            width: 32, height: 18, borderRadius: 9, position: 'relative',
            background: theme === 'dark' ? C.accent : C.muted,
            transition: 'background 0.2s',
          }}>
            <div style={{
              width: 12, height: 12, borderRadius: '50%', background: '#fff',
              position: 'absolute', top: 3,
              left: theme === 'dark' ? 16 : 4,
              transition: 'left 0.2s',
            }} />
          </div>
        </button>

        <div style={{ fontSize: 10, color: C.muted }}>v6.0 — Phase 6</div>
      </div>
    </aside>
  );
}
