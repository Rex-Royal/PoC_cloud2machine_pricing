# Rex-Royal Cloud-to-Machine Dynamic Pricing PoC (Next.js App Router)

A standalone **Next.js 15 + React 19 + TypeScript** Proof-of-Concept web application and modular TypeScript SDK demonstrating **Version 1 (Zero Backend / Zero Firmware Changes)** cloud-to-machine dynamic pricing across heterogeneous Rex-Royal coffee machine fleets.

## Documentation & Headless Example

- **[Customer Developer & Integration Guide (PDF)](./docs/Rex-Royal_Cloud_to_Machine_Dynamic_Pricing_Guide.pdf)** — 3-page visual guide covering the 4-step workflow, smart live vs. offline routing, and the **5 Golden Guardrails**.
- **[Wire API Reference (`API_REFERENCE.md`)](./API_REFERENCE.md)** — Exact ThingsBoard (`/api`) & FtpProxy (`/api/v2`) REST/RPC payloads, headers, `cmdStack.json` framing, and full 32-parameter mapping table.
- **[Minimal Headless Script (`examples/minimal-price-push.ts`)](./examples/minimal-price-push.ts)** — Self-contained backend example runnable via `npm run example`.

> [!NOTE]
> **Browser PoC Scope vs. ERP Backend Production**: This Next.js web app stores deployment batches and one-shot schedules in browser `localStorage` and runs polling/cleanup while the tab remains open. The `/api-bridge/*` routes exist solely to bypass browser CORS; backend/ERP integrations should run `AuthService` directly (`useLocalCorsProxy: false`) alongside a server worker/cron for scheduling and `.zip` cleanup.

---

## Prerequisites & Quick Start

- **Node.js `>= 22.7.0`** (required for native TypeScript execution in `npm test` and `npm run example`)
- **npm** (`>= 10`)

```bash
git clone https://github.com/Rex-Royal/PoC_cloud2machine_pricing.git
cd PoC_cloud2machine_pricing
cp .env.example .env.local   # optional: customize default TB / FTP endpoints
npm install
npm run dev
```

Open **[http://localhost:4173](http://localhost:4173)** in your browser.

### Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts the Next.js development server on `http://localhost:4173` |
| `npm run build` | Builds the production Next.js application |
| `npm start` | Starts the production Next.js server on `http://localhost:4173` |
| `npm run typecheck` | Runs strict TypeScript type-checking (`tsc --noEmit`) |
| `npm test` | Runs the automated unit & integration test suite (`node --experimental-transform-types --test tests/*.test.ts`) |
| `npm run example` | Runs the headless integration walkthrough in offline `--demo` mode |

---

## Architecture & Directory Structure

```text
PoC_cloud2machine_pricing/
├── package.json                              # Dependencies (fflate, Tailwind CSS v4, React Query) & #package subpath imports
├── postcss.config.mjs                        # Tailwind CSS v4 PostCSS plugin (@tailwindcss/postcss)
├── tsconfig.json
├── next.config.ts
├── .env.example                              # Default ThingsBoard / FtpProxy URL environment template
├── LICENSE                                   # MIT License
├── API_REFERENCE.md                          # Wire-level ThingsBoard + FtpProxy V2 REST/RPC contract & 32-key table
├── docs/
│   └── Rex-Royal_Cloud_to_Machine_Dynamic_Pricing_Guide.pdf  # 3-page customer integration overview & guardrails
├── examples/
│   └── minimal-price-push.ts                 # Standalone headless ERP/backend price push example
├── packages/
│   ├── firmware-core/src/                    # Pure functional firmware codecs, pricing & layout engine (#firmware-core)
│   │   ├── index.ts
│   │   ├── backup-zip-parser.ts              # Optional legacy Backup_MN*.zip (CSV/XML) fallback & sample detection
│   │   ├── cmd-stack.ts                      # FtpProxy cmdStack.json (base64(JSON)||) encoder/decoder
│   │   ├── layout-engine.ts                  # Parses config.json, clusters layouts, validates slot compatibility
│   │   ├── pricing-engine.ts                 # Price formatting, 5-Rappen rounding, 32-key priceList.json export
│   │   ├── pricing-scheduler.ts              # Grace-window cleanup & schedule evaluation helpers
│   │   ├── sample-layouts.ts                 # Synthetic 3×5 & 4×6 layouts for simulator fallback
│   │   ├── types.ts                          # Domain interfaces, firmware constants & strict TypeScript enums
│   │   └── zip-codec.ts                      # fflate-backed ZIP builder/reader enforcing add_priceList_<layoutKey>.zip
│   ├── cloud-client/src/                     # Transport, ThingsBoard JWT auth, FTP HTTP client & proxy (#cloud-client)
│   │   ├── index.ts
│   │   ├── auth-service.ts                   # ThingsBoard JWT authentication & customer scope resolution
│   │   ├── http-client.ts                    # Isolated HTTP client with automatic JWT refresh & no-store reads
│   │   └── proxy-bridge.ts                   # Next.js server-side CORS proxy with host allowlist & SSRF checks
│   └── fleet-sync/src/                       # Orchestration workflows & offline sync reconciliation (#fleet-sync)
│       ├── index.ts
│       ├── coffee-machine-service.ts         # Device discovery, FTP config/backup I/O, 2-way MQTT RPC probe
│       └── dynamic-pricing-service.ts        # Batch deploy, baseline snapshots, queue reconciliation & batch cancel
├── src/
│   ├── globals.css                           # Tailwind CSS v4 stylesheet & corporate UI design tokens
│   ├── app/
│   │   ├── layout.tsx                        # Next.js App Router root layout with QueryProvider
│   │   ├── page.tsx                          # Main entry page
│   │   └── api-bridge/
│   │       ├── tb/[...path]/route.ts         # Next.js Route Handler proxying ThingsBoard REST APIs
│   │       └── ftp/[...path]/route.ts        # Next.js Route Handler proxying FtpProxy REST APIs
│   ├── components/
│   │   ├── DynamicPricingDashboard.tsx       # Top-level Dynamic Pricing Studio orchestrator UI
│   │   ├── QueryProvider.tsx                 # Client @tanstack/react-query QueryClientProvider
│   │   ├── auth/
│   │   │   └── AuthForm.tsx                  # ThingsBoard login & environment configuration form/modal
│   │   ├── debug/
│   │   │   └── DebuggerConsole.tsx           # Live TB/FTP HTTP & RPC request/response inspector drawer
│   │   ├── fleet/
│   │   │   ├── CustomerCombobox.tsx          # Searchable customer hierarchy selector
│   │   │   └── FleetSelectionView.tsx        # Machine discovery, group filtering & selection table
│   │   ├── layout/
│   │   │   └── TopHeader.tsx                 # Step navigation, environment badge, and locale switcher
│   │   └── pricing/
│   │       ├── OfflineQueuePanel.tsx         # Pending cmdStack queue, cleanup status & baseline restore UI
│   │       ├── PricingGroupsPanel.tsx        # Layout-clustered groups, online readiness & schedule controls
│   │       ├── ProductsPricingTable.tsx      # Per-product single-price editor (updates all 24 price fields) & deploy triggers
│   │       └── UnavailableMachinesBanner.tsx # Warning banner for machines missing FTP config
│   ├── hooks/                                # React Query polling & client workspace hooks
│   │   ├── useAuthSession.ts                 # Login, React Query JWT keepalive & local session persistence
│   │   ├── useFleetSelection.ts              # Customer/group machine discovery, config loading & React Query polling
│   │   ├── useLatestRef.ts                   # Mutable ref helper synchronized with latest React state
│   │   ├── useOfflineQueueAndSchedules.ts    # React Query offline queue watcher, scheduled deployments & restore
│   │   └── usePricingGroups.ts               # Layout clustering, price edits & batch deploy
│   ├── i18n/
│   │   └── translations.ts                   # Multi-locale dictionary (en_US, de_DE, fr_FR)
│   └── utils/
│       └── dashboardStorage.ts               # Browser sessionStorage/localStorage persistence & presets
└── tests/
    ├── core-and-bridge.test.ts               # DEFLATE ZIP, backup XML/CSV, HTTP 401 refresh, proxy & schedule tests
    ├── fixtures.ts                           # Shared test fixtures, factories & cloud connection reset helper
    ├── dynamic-pricing.test.ts               # Layout clustering, ZIP codec, SSRF guard & locale parity tests
    └── offline-and-scheduler.test.ts         # Offline queue cleanup & scheduled Happy Hour window tests
```
