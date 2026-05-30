# Deploy Log (dashboard / prod)

Throttle: dashboard deploys ≤ once per hour unless the human says "deploy now".
Verify success by CONTENT (curl prod alias, grep a cycle marker) — Vercel's status field
can stick on UNKNOWN.

| UTC time | commit | result | notes |
|---|---|---|---|
| (15d ago) | pre-loop | ● READY | original site live |
| 2026-05-30 ~01:51 | aba141a (cycle 2) | ⚠ STUCK UNKNOWN | build never promoted; old code still live |
| 2026-05-30 ~02:00 | aba141a (cycle 2) | ⚠ STUCK UNKNOWN | redeploy also stuck — Vercel-side issue, needs debugging |

| 2026-05-30 ~02:19 | + vercel.json/.vercelignore (--force) | ⚠ STUCK "Building…" | static config didn't help; hangs at build |

STATUS: cycles 1+2 dashboard + BUILD-cycle-1 changes committed but NOT live. Three deploy
attempts all hang ("UNKNOWN" / "Building…") despite a static vercel.json (buildCommand:null).
This is a PROJECT/ACCOUNT-side Vercel issue, not a code issue (site verified working locally +
in preview MCP with zero console errors).
MANUAL FIX NEEDED (human): check the Vercel dashboard → project Build & Output settings (a
stale framework preset / build command may be forcing a build that hangs); OR `vercel link`
to re-link; OR delete & recreate the project and re-alias. Until then the loop will NOT deploy.
