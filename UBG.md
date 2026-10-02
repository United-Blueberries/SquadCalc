# UBG fork notes

Fork of [sh4rkman/SquadCalc](https://github.com/sh4rkman/SquadCalc), kept current with GitHub **Sync fork** (upstream → fork only).

## Fork-only files (never conflict)
- `src/js/squadMainbaseProtection.js` — mainbase protection (MBC) zones + all their logic (3x3 map list, show/hide rules)
- `Dockerfile`, `.dockerignore`, `docker-compose.yml` (host-specific settings go in an untracked `docker-compose.override.yml` on the server)
- `UBG.md`

## Patched upstream spots (`grep -rn "UBG" src public`)
- `src/js/squadLayer.js` — import, `createMainbaseProtections(this)` in `init()`, `updateMainbaseProtections(this)` in `_renderFromSolver()`
- `src/js/squadObjective.js` — import, hover preview in `_handleMouseOver` / `_handleMouseOut`
- `src/js/squadSettings.js` — import, `mainbaseProtection` setting
- `src/components/dialogs/settings.html` — MBC checkbox row
- `public/locales/*/settings.json` — `mainbaseProtection` string
- `src/js/squadCalc.js` — `loadTheme()` pins map overlay color to firebrick
- `src/components/shared/_variables.scss` — purple theme colors
- `public/img/favicons/*` — UBG icons under upstream file names

## Syncing
1. GitHub → Sync fork (or `git merge upstream/master`); resolve conflicts in the spots above.
2. If upstream reworks flag selection again, re-check `updateMainbaseProtections()` (uses `selectedFlags`, `confirmedStep`, `perspectiveMain`, `_farMain()`, `solver.stepCount`).
3. `npm run build`, then `docker compose up --build -d`.
