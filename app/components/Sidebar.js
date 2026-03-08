'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const C = {
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  accent: "#00E5A0",
};

const NAV = [
  {
    section: 'ANALYTICS',
    items: [
      { href: '/',              icon: '📊', label: 'Claims Dashboard',  sub: 'Real-time monitoring' },
      { href: '/query-builder', icon: '⚡', label: 'Query Builder',     sub: 'SQL generator & templates' },
    ],
  },
  {
    section: 'OPERATIONS',
    items: [
      { href: '/reports',        icon: '📝', label: 'Daily Reports',   sub: 'Team reporting' },
      { href: '/reports/weekly', icon: '📅', label: 'Weekly Summary',  sub: 'Aggregated view' },
    ],
  },
  {
    section: 'COMING SOON',
    items: [
      { href: '/tasks',  icon: '✅', label: 'Task Management',    sub: 'Track work items',    disabled: true },
      { href: '/errors', icon: '🔴', label: 'Error Tracking',     sub: 'Batch monitoring',    disabled: true },
      { href: '/okrs',   icon: '🎯', label: 'OKR Tracker',        sub: 'Goals & progress',    disabled: true },
      { href: '/slack',  icon: '💬', label: 'Slack Intelligence',  sub: 'AI summaries',        disabled: true },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside style={{
      width: 200, minHeight: '100vh', background: C.card,
      borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column',
      flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{ padding: '20px 16px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#0B0F1A' }}>C</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Claims Intel</div>
            <div style={{ fontSize: 10, color: C.muted }}>Curacel Health Ops</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 8px', overflowY: 'auto' }}>
        {NAV.map(group => (
          <div key={group.section} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.muted, padding: '0 8px', marginBottom: 4, letterSpacing: '0.08em' }}>
              {group.section}
            </div>
            {group.items.map(item => {
              const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
              if (item.disabled) {
                return (
                  <div key={item.href} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, marginBottom: 2, opacity: 0.4, cursor: 'not-allowed' }}>
                    <span style={{ fontSize: 14 }}>{item.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: C.muted, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        {item.label}
                        <span style={{ fontSize: 9, background: C.elevated, color: C.muted, padding: '1px 5px', borderRadius: 4 }}>Soon</span>
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 8, marginBottom: 2,
                    background: active ? '#00E5A015' : 'transparent',
                    border: active ? `1px solid #00E5A030` : '1px solid transparent',
                    cursor: 'pointer', transition: 'all .15s',
                  }}>
                    <span style={{ fontSize: 14 }}>{item.icon}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: active ? C.accent : C.text }}>{item.label}</div>
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
      <div style={{ padding: '12px 16px', borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 10, color: C.muted }}>v4.1 — Phase 2</div>
      </div>
    </aside>
  );
}
