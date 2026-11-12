# Frontend and UX Audit

**Date:** 2026-11-11

---

## Extension Frontend (Chrome MV3)

### popup.ts (/popup/popup.html)
- **Framework:** Plain TypeScript + DOM
- **Purpose:** ARM/DISARM controls; settings form for paper capital
- **Status:** ✅ Working. Localhost URL hardcoding **FIXED** — now uses `getApiBaseUrl()` with build-time override support.
- **Two-step arming:** DISARMED → ARMED_PENDING → ARMED correctly implemented.

### sidepanel.ts (/sidepanel/sidepanel.html)
- **Framework:** Plain TypeScript + DOM
- **Purpose:** Live position monitor, signal feed (10 entries), MAX-priority alert queue
- **Status:** ✅ Working. MAX-only alerts (not CRITICAL/INFO) correctly filtered.
- **React requirement:** Not converted to React. The side panel is a compact utility view — imperative DOM is acceptable here given its limited scope.

### dashboard.ts (/dashboard/dashboard.ts)
- **Framework:** Plain TypeScript + DOM (5 panels: strategy performance, capital chart, regime heatmap, options flow, alert queue)
- **Status:** ⚠ Imperative DOM. The dashboard.ts is a background extension page not in the manifest — it has no HTML wrapper in the manifest and is not directly user-accessible.
- **React requirement:** See React dashboard (public/app.html) for the full React implementation.

## React Quantitative Trading Terminal (public/app.html)

**NEW in this session** — full React dashboard served by NestJS at `/app.html`.

### Technology
- React 18.3.1 + ReactDOM
- esbuild (IIFE bundle, chrome120 target)
- TypeScript with separate `src/frontend/tsconfig.json` (jsx: react)
- Build: `npm run build:frontend` → `public/app.js`
- Bundle size: 283.8kb (includes React, ReactDOM, all components)

### Components
| Component | File | Description |
|-----------|------|-------------|
| App | App.tsx | Main layout: TopBar + 2-col grid |
| TopBar | TopBar.tsx | Clock, session phase badge, 4 connection dots |
| EngineCard | EngineCard.tsx | Paper/live P&L cards with drawdown |
| PositionsTable | PositionsTable.tsx | Positions showing lots AND units |
| SignalList | SignalList.tsx | Ranked signals with score + R:R |
| LiveControls | LiveControls.tsx | 2-step ARM/CONFIRM/DISARM/KILL |
| SquareOffTimer | SquareOffTimer.tsx | Countdown to all 6 IST cutoffs |
| RiskCenter | RiskCenter.tsx | Paper + live risk state machine |
| SystemHealth | SystemHealth.tsx | Health checks + debug stats |

### Design Principles
- Dark-first (#0b0d12 background)
- Monospace font throughout (SF Mono / Fira Code)
- Accent colors: #00d4aa (paper), #3b82f6 (live), #22c55e (long), #ef4444 (short/danger)
- No animations except ARMED_PENDING pulse
- High-density layout, minimal chrome

### Open Items
- No candlestick charts yet (Phase 9: add Lightweight Charts)
- No settings panel in React dashboard (uses popup.ts)
- No navigation between the 13 specified panels yet — currently overview-only
- No virtual scrolling on positions table
