# Curacel Claims Intel Dashboard

Internal health operations platform for managing insurance claims, team performance, QA tracking, and AI-powered analytics.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 14 (App Router) |
| Database | Supabase (PostgreSQL) |
| AI | Anthropic Claude |
| Integrations | Slack, Google APIs, n8n |
| Charting | Recharts |
| Hosting | Vercel |

## Features

- **Claims Dashboard** — Daily claims analytics by insurer with trend visualization
- **Query Builder** — AI-powered SQL generation for ad-hoc reporting
- **QA Tracker** — Quality assurance flag monitoring (fed by n8n automations)
- **Team Reports** — Daily work summaries and submission tracking
- **Ops Overview** — Attendance grid and operational metrics
- **Weekly Targets** — Goal tracking and progress visualization
- **Task Management** — Assignment and status tracking
- **Prism AI** — Slack-integrated AI assistant for operations queries
- **Tools Suite** — Batch splitter, insurer feedback, UAPOM matcher, report converter

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Supabase account
- Slack workspace (for notifications)

### Installation

```bash
git clone https://github.com/CuracelDev/claims-dashboard.git
cd claims-dashboard
npm install
```

### Environment Variables

Create `.env.local` in the project root:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Slack
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_WEBHOOK_HEALTHOPS=https://hooks.slack.com/services/...

# AI
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Nova Health API (for insurer sync)
NOVA_API_URL=https://api.health.curacel.co/nova-api
NOVA_API_KEY=your-nova-api-key
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Production Build

```bash
npm run build
npm start
```

## Project Structure

```
app/
├── page.js              # Main claims dashboard
├── layout.js            # Root layout with providers
├── api/                 # API routes
│   ├── claims/          # Claims data endpoints
│   ├── reports/         # Report generation
│   ├── qa-flags/        # QA flag management
│   ├── slack/           # Slack integrations
│   ├── generate-sql/    # AI SQL generation
│   └── tools/           # Utility endpoints
├── components/          # Shared components
├── context/             # React context providers
└── lib/                 # Utilities
    ├── auth.js          # Authentication helpers
    ├── nav.js           # Navigation config
    └── settings.js      # App settings
lib/
├── supabase.js          # Supabase client
└── insurerMapping.js    # HMO ID ↔ Name mappings
```

## Database Schema (Supabase)

| Table | Purpose |
|-------|---------|
| `claims_daily` | Aggregated daily claims by insurer |
| `team_members` | Staff profiles, PINs, roles |
| `daily_reports` | Daily work submissions |
| `qa_flags` | Quality assurance flags (from n8n) |
| `platform_settings` | Key/value configuration |
| `sessions` | Auth session tokens |
| `audit_log` | Activity tracking |
| `prism_logs` | AI chat history |
| `targets` | Weekly team targets |
| `target_logs` | Target progress entries |
| `tasks` | Task assignments |

## Data Integrations

### n8n Automations

External n8n workflows push data to:
- `POST /api/qa-flags` — QA flag updates
- `POST /api/claims` — Daily claims aggregates

### Nova Health API

Insurer mappings are sourced from Nova Health:
- Endpoint: `GET /nova-api/hmos`
- Used to map Metabase `hmo_id` to insurer names

### Metabase (WIP)

Direct Metabase integration for real-time claims data is in development on the `fix/metabase-switch` branch.

## Deployment

Deployed automatically via Vercel on push to `main`.

```bash
# Manual deploy
vercel --prod
```

## Contributing

1. Create a feature branch from `main`
2. Make changes and test locally
3. Push and create a pull request
4. Merge after review

## License

Internal use only — Curacel © 2026
