// app/lib/nav.js
// ─────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for navigation + guest access rules.
// Import GUEST_ROUTES from here — do NOT redefine it anywhere else.
// AuthGate.js and Sidebar BOTH import from this file.
// ─────────────────────────────────────────────────────────────
// Routes accessible without any login (guests + public)
export const GUEST_ROUTES = ['/', '/query-builder'];
export function isGuestRoute(route) {
  return GUEST_ROUTES.includes(route);
}
export const NAV = [
  {
    section: 'ANALYTICS',
    items: [
      {
        label: 'Claims Dashboard',
        sub: 'Real-time monitoring',
        route: '/',
        icon: '📊',
        public: true,
      },
      {
        label: 'Query Builder',
        sub: 'SQL generator & templates',
        route: '/query-builder',
        icon: '⚡',
        public: true,
      },
    ],
  },
  {
    section: 'OPERATIONS',
    items: [
      { label: 'Daily Reports',   sub: 'Team reporting',      route: '/reports',        icon: '📋' },
      { label: 'Weekly Summary',  sub: 'Aggregated view',     route: '/reports/weekly', icon: '📅' },
      { label: 'Team Management', sub: 'Members & metrics',   route: '/team',           icon: '👥' },
      { label: 'Task Management', sub: 'Assign & track work', route: '/tasks',          icon: '✅' },
    ],
  },
  {
    section: 'INTELLIGENCE',
    items: [
      { label: 'QA Flag Tracker', sub: 'Claims quality audit',  route: '/qa',      icon: '🔍' },
      { label: 'Ops Overview',    sub: 'Team performance',       route: '/ops',     icon: '⚡' },
      { label: 'Targets',         sub: 'Weekly goals & alerts',  route: '/targets', icon: '🎯' },
      { label: 'Error Tracker',   sub: 'Claim errors from Slack',route: '/errors',  icon: '⚠️' },
      { label: 'Audit Log',       sub: 'Activity trail',         route: '/audit',   icon: '🗂️' },
    ],
  },
  {
    section: 'TOOLS',
    items: [
      { label: 'Operational Tools', sub: 'Utilities & batch ops', route: '/tools',                  icon: '🔧' },
      { label: 'Insurer Feedback',  sub: 'JBL & insurer review',  route: '/tools/insurer-feedback', icon: '💬' },
    ],
  },
  {
    section: 'SYSTEM',
    items: [
      { label: 'Settings', sub: 'Slack, alerts & config', route: '/settings', icon: '⚙️' },
    ],
  },
];
