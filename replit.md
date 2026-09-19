# BackSpyne

BackSpyne is a local-first RF intelligence dashboard for authorized environments, helping operators explore nearby WiFi/BLE telemetry, track signal proximity, coordinate scan nodes, and review privacy-bounded sensing signals.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + Tailwind CSS

## Where things live

- `artifacts/backspyne/src/App.tsx` — public landing/auth portal plus operator dashboard, live API/SSE telemetry integration, and permission-first hardware scan
- `artifacts/backspyne/src/index.css` — BackSpyne visual tokens and responsive styling
- `artifacts/api-server/src/routes/` — shared health, authenticated operator, SSE, and signed local-node ingestion routes
- `lib/api-spec/openapi.yaml` — shared API contract source of truth
- `lib/db/src/schema/` — shared database schema for sessions, nodes, RF identities, telemetry, and governed evidence
- `scanner/` — cross-platform authorized local bridge for BLE, OS-native WiFi observation, ESP32/CSI serial input, signed upload, and simulator mode

## Architecture decisions

- The dashboard is local-first but now has a real authenticated persistence path: demo fixtures remain available until a signed local bridge produces live observations.
- The UI makes the simulated-data boundary visible and keeps the authorized-environments disclaimer close to the telemetry surface.
- The dashboard is designed around defensive observation only; it does not attempt to access WiFi/BLE hardware directly from the browser.
- Replit-managed Clerk owns browser sessions. The API uses Clerk cookie middleware; scanner nodes use a separate HMAC-signed local-node protocol and never receive Clerk credentials.
- Sensing output is limited to conservative environmental heuristics with explicit uncertainty and a non-medical boundary. No synthetic heart-rate, apnea, fall, or identity claim is presented as validated.
- BackSpyne uses a dense command-surface layout with a radar visualization, device ledger, sensing view, and network-node view as the primary navigation model.

## Product

BackSpyne provides a live-feeling operations dashboard for discovering nearby RF targets, locking onto a target, reviewing signal history, preserving ghost/offline sightings, decoding vendors, exporting a device ledger, and coordinating local scan nodes. Sensing and model workflows are represented as an extensible surface for future ESP32/CSI adapters.

## User preferences

- Keep the experience privacy-first, camera-free, and explicit about authorization and telemetry provenance.

## Gotchas

- Real WiFi/BLE/CSI capture requires a separate authorized hardware or local service adapter; the browser dashboard intentionally does not bypass direct hardware permissions.
- The BackSpyne workflow provides `PORT` and `BASE_PATH`; use the managed workflow instead of starting Vite manually.
- The API workflow listens on port 8080 and the scanner defaults to `http://127.0.0.1:8080/api`; configure `BACKSPYNE_API_URL` when the bridge is remote.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
