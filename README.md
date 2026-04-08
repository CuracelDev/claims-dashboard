# Curacel Claims Intel Dashboard

Internal health operations platform for managing insurance claims, team performance, QA tracking, and AI-powered analytics.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Database | Supabase (PostgreSQL) or PostgreSQL on GCP |
| AI | Azure OpenAI (GPT-4) |
| Data Source | Metabase API |
| Integrations | Slack, Google APIs, n8n |
| Charting | Recharts |
| Hosting | Vercel or GCP (Docker) |

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
# Database (choose one)
# Option 1: Direct PostgreSQL (for GCP deployment)
DATABASE_URL=postgresql://user:password@host:5432/database

# Option 2: Supabase (for local dev / Vercel)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Slack
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_WEBHOOK_HEALTHOPS=https://hooks.slack.com/services/...

# AI - Azure OpenAI (primary)
AZURE_OPENAI_API_KEY=your-azure-openai-key
AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_VERSION=2025-01-01-preview

# AI - Anthropic Claude (fallback/legacy)
ANTHROPIC_API_KEY=sk-ant-...

# Metabase (Health database queries)
METABASE_URL=https://your-metabase-instance.com
METABASE_USERNAME=your-username
METABASE_PASSWORD=your-password

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
├── supabase.js          # Database client (auto-switches Supabase/PostgreSQL)
├── supabase-compat.js   # PostgreSQL compatibility layer
├── metabase.js          # Metabase API client
├── azure-openai.js      # Azure OpenAI client
└── insurerMapping.js    # HMO ID ↔ Name mappings
public/
├── curacel-logo.svg     # Favicon and branding
└── curacel-logo.png     # Logo asset
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

### Metabase

Direct Metabase integration provides real-time claims data:
- Claims dashboard pulls live aggregates via Metabase API
- Query Builder generates and executes SQL via Metabase
- Supports cached queries with configurable TTL

## Deployment

### Vercel (Default)

Deployed automatically via Vercel on push to `main`.

```bash
# Manual deploy
vercel --prod
```

### GCP (Docker)

For GCP deployment with PostgreSQL:

1. Set `DATABASE_URL` in your environment
2. Deploy via GitHub Actions workflow (`.github/workflows/deploy.yml`)
3. App runs on port 3030 by default

```bash
# Build and run locally with Docker
docker build -t claims-dashboard .
docker run -p 3030:3030 --env-file .env.local claims-dashboard
```

## Contributing

1. Create a feature branch from `main`
2. Make changes and test locally
3. Push and create a pull request
4. Merge after review

## Recent Changes

### April 2026
- **Azure OpenAI Migration** — Switched AI provider from Anthropic Claude to Azure OpenAI
- **Metabase Integration** — Claims dashboard now pulls real-time data from Metabase
- **GCP Deployment** — Added support for PostgreSQL on GCP with Docker deployment
- **Supabase Compatibility Layer** — Database abstraction supports both Supabase and direct PostgreSQL
- **UI Improvements** — Added Curacel favicon, fixed textarea overflow, improved badge styling
- **Next.js 16** — Upgraded to Next.js 16 with Turbopack

## License

Internal use only — Curacel © 2026
