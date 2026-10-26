# Sheet Metal (شركة الصفا) — project brief

Offline Arabic (RTL) web app for a sheet-metal workshop. Technicians fill paper daily sheets per machine;
the manager photographs or types them; whoever records a sheet reviews and confirms it; the admin prices
the work and keeps client accounts. Full design: https://claude.ai/artifact/4PmmCHCdxiv4j2nePuswSE

- **Admin** (Kaream) sees everything. **Staff** (the workshop manager) does everything except money.
- Runs only on the manager's Windows PC: Node + Express + better-sqlite3, vanilla JS front end in `public/`.

## Rules that must not break

1. **Money never reaches Staff.** Strip it on the server (`stripMoney` in `src/money.js`), never only in the UI.
   Money is integer piastres. No rounding anywhere.
2. **Permissions, not roles.** Routes check `requirePerm('<perm>')` (`src/permissions.js`).
3. **Confirm gate is server-side**: a sheet confirms only with zero red issues and every yellow issue acknowledged
   (`validateSheet` in `src/sheets.js`, `/confirm` in `src/routes/sheets.js`).
4. **Confirmed records are never edited or deleted** — cancelled with a reason. Every change is audited (`audit()`).
5. **Schema changes = a new entry in `src/migrations.js`.** Never edit a shipped migration.
6. **The repo will be public**: never commit `data/`, backups, client names, prices or passwords.
7. **Paper habits are features**: `~` and `//` mean "same as above"; Arabic or Western digits; thickness like "١٫٥م".
8. All UI text and error messages in simple Egyptian Arabic.

## Code map

```
src/server.js        start (PORT, default 4300)
src/app.js           Express app, session/setup/login, error handler
src/db.js            open, migrate, audit()        src/migrations.js  schema
src/auth.js          scrypt passwords, session cookie, lockout, requirePerm
src/permissions.js   permission list + role defaults
src/money.js         piastres, stripMoney
src/sheets.js        machine columns + red/yellow validation
src/backup.js        backups (startup, daily, before update, manual), restore
src/update.js        update button + rollback (GitHub releases → versions\<build>), crash recovery
src/tunnel.js        cloudflared quick/fixed link, Wi-Fi links, QR codes
src/windows.js       keep-awake, start with Windows      src/version.js  build number
src/routes/          people.js (users, clients, technicians, lookups), sheets.js, money.js, deliveries.js,
                     print.js, system.js (backups, update, share, autostart)
public/js/           app.js (shell, router, simple screens), sheet.js (entry + review), ui.js, api.js,
                     pricing.js, accounts.js, delivery.js, system.js (backups, update, مشاركة)
test/                core, money, system (backups/update/rollback against a fake GitHub) — npm test
.github/workflows/   release.yml: tests on every push; on main a Windows package + GitHub release
scripts/             check-repo.js (no data in the public repo), package.js (builds the release)
```

## Running

```
npm install
npm test
npm start                       # http://localhost:4300 — first run shows the admin setup screen
node src/cli.js create-admin <user> <password>
```
Set `SHEETMETAL_DATA` to use another data folder (tests use a temp dir).

## Installed layout (Windows)

```
SheetMetal\Start Sheet Metal.bat   sets SHEETMETAL_HOME, loops: exit code 42 = restart
SheetMetal\node\node.exe  cloudflared.exe          bundled, never in the repo
SheetMetal\data\                                  database + backups\ (an update never touches it)
SheetMetal\versions\<build>\  current.txt  previous.txt   code from the update button ("." = next to the .bat)
```
An update unpacks into `versions\<build>`, runs the new code's migrations on a copy of the data
(`cli.js check-db`), then switches `current.txt`. If the new build fails to start, the launcher
switches back by itself (`update-trial.txt`) and the old code restores the pre-update backup.
The bundled `node\node.exe` must be the same major version as `NODE_VERSION` in release.yml.

## Build order (from the design doc)

1. ✅ Core: schema, login/permissions, clients, technicians, machines, manual entry, review/confirm (no OCR).
2. ✅ Pricing (price memory, bundles), statement/receipt/delivery print pages, payments + cheques, adjustments, promises, follow-up, settings.
3. ✅ Update button + rollback, backups, tunnel + QR, phone layouts (bottom bar, one-row sheet review).
4. Printed forms with QR, photo upload, image prep + cell splitting.
5. OCR v1 + teaching from old sheets.  6. Self-retraining, technician profiles.
