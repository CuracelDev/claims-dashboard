'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  {
    section: 'ANALYTICS',
    items: [
      { href: '/',               icon: '📊', label: 'Claims Dashboard' },
      { href: '/query-builder',  icon: '🤖', label: 'AI Query Builder' },
    ],
  },
  {
    section: 'OPERATIONS',
    items: [
      { href: '/reports',         icon: '📝', label: 'Daily Reports' },
      { href: '/reports/weekly',  icon: '📅', label: 'Weekly Summary' },
    ],
  },
  {
    section: 'COMING SOON',
    items: [
      { href: '/tasks',  icon: '✅', label: 'Task Management',   disabled: true },
      { href: '/errors', icon: '🔴', label: 'Error Tracking',    disabled: true },
      { href: '/okrs',   icon: '🎯', label: 'OKR Tracker',       disabled: true },
      { href: '/slack',  icon: '💬', label: 'Slack Intelligence', disabled: true },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 min-h-screen bg-gray-900 text-white flex flex-col">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-gray-700">
        <div className="text-sm font-bold text-white">Curacel</div>
        <div className="text-xs text-gray-400">Health Ops Platform</div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
        {NAV.map(group => (
          <div key={group.section}>
            <div className="text-xs font-semibold text-gray-500 px-2 mb-1 tracking-wider">
              {group.section}
            </div>
            <ul className="space-y-0.5">
              {group.items.map(item => {
                const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
                return (
                  <li key={item.href}>
                    {item.disabled ? (
                      <span className="flex items-center gap-2 px-2 py-2 rounded-md text-sm text-gray-600 cursor-not-allowed">
                        <span>{item.icon}</span>
                        <span>{item.label}</span>
                        <span className="ml-auto text-xs bg-gray-800 px-1.5 py-0.5 rounded text-gray-500">Soon</span>
                      </span>
                    ) : (
                      <Link
                        href={item.href}
                        className={`flex items-center gap-2 px-2 py-2 rounded-md text-sm transition-colors ${
                          active
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                        }`}
                      >
                        <span>{item.icon}</span>
                        <span>{item.label}</span>
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-700">
        <div className="text-xs text-gray-500">v4.1 — Phase 2</div>
      </div>
    </aside>
  );
}
