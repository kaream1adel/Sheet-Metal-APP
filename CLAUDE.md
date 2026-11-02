# شركة الصفا — project brief (v2, rebuilt from the Excel workbook)

Offline Arabic (RTL) web app for a sheet-metal workshop. Technicians write daily paper sheets per machine
(التناية، المقص، الليزر، البنش); the sheet is photographed (AI reading) or typed, reviewed (red / yellow) and
approved by the manager; the admin prices each sheet and posts it to the client's account; collections,
expenses, cheques, partners and suppliers all go through one double-entry ledger.
The first version of the app was cancelled; git history keeps its code (e.g. `git show fd5faa1:src/ai.js`).

- **Admin** sees everything. **Staff** (the workshop manager) does operations and records expense vouchers,
  and never sees money (prices, totals, balances, cash).
- Runs on the manager's Windows PC: Node 22 (see «Node version» below) + Express + better-sqlite3 (WAL), vanilla ES modules in `public/`
  (no framework, no build step except icons). Phones reach it over Wi-Fi or a Cloudflare tunnel (QR).

## Rules that must not break

1. **The repo is public.** Never commit `data/`, backups, the Excel workbook (any `.xlsx`), real client /
   partner names, amounts, prices or passwords. Tests use invented names. `scripts/check-repo.js` runs in CI.
2. **Money = integer millimes** (1 EGP = 1000), never floats in the DB (migration 2's triggers refuse a
   non-integer in every money column; a module adding a money column adds `integerMoneyTriggers(table, [col])`
   from `src/migrations/foundation.js` to its own migration). The only rounding: `mulRound(qty, rate)`
   (round half up) at the item level. Display: 2 decimals, thousands separators, Western digits.
3. **Money never reaches staff**: `stripMoney(user, data)` (`src/money.js`) on the server, never only in the UI.
   It removes keys by NAME: `amount, rate, balance, debit, credit, discount, total(s), min_charge, credit_limit,
   opening/closing(_text), price, cost, expected, counted, difference, balance_text, ...` and anything ending in
   `_amount _rate _price _cost _balance _total _millimes _money _debit _credit`. Name every money field so.
   Free text can carry amounts too: partners (list, one, similar, statement) are money.view only; supplier and
   worker statements are money.view only; a client statement without money.view has no `description`/`reason`;
   `/api/audit` needs `reports` and `money.view`.
4. **The ledger is the single source of truth for every balance** (`src/ledger.js`). Every document posts one
   balanced transaction through `post()`. Posted transactions are never edited or deleted: cancel = `reverse()`
   with a reason. Every change is audited (`audit()`) inside the same DB transaction.
5. **Permissions, not roles** (`requirePerm` / `requireAny`, `src/permissions.js`).
6. **Schema changes only via migrations**, in your module's file and id range (below). Never edit a shipped one.
7. All UI text and errors in professional Egyptian Arabic (glossary in the spec), RTL, **no emojis** —
   Phosphor icons via `scripts/build-icons.js`. Balances in words: «لنا عنده» / «له عندنا» / «خالص».
8. Paper habits are features: `~` `//` `〃` = same as above; Arabic-Indic or Western digits; «١٫٥م اسود».
9. Month lock: a posting dated in a locked month is refused server-side (`assertMonthOpen`).

## Modules, ownership and migration ranges

| module | server | front end | migrations (ids) |
|---|---|---|---|
| foundation | everything not listed below | `app.js ui.js api.js grid.js statement.js parties.js settings.js` | `src/migrations/foundation.js` (1-99) |
| operations | `src/routes/operations.js` (+ `src/photos.js`, `src/ai.js` if needed) | `public/js/modules/operations.js` | `operations.js` (100-199) |
| pricing | `src/routes/pricing.js` | `public/js/modules/pricing.js` | `pricing.js` (200-299) |
| treasury | `src/routes/treasury.js` | `public/js/modules/treasury.js` | `treasury.js` (300-399) |
| reports | `src/routes/reports.js` | `public/js/modules/reports.js` | `reports.js` (400-499) |
| import | `src/routes/import.js` (+ `src/import/`, `src/import/cli.js` exporting `run(args)`) | `public/js/modules/import.js` | `import.js` (500-599) |

The foundation migration already creates **every** table of the data model, so a module only needs a
migration to add something new. Each module file exports `MIGRATIONS = [{ id, name, sql }]`; `src/db.js`
merges all files, sorts by id, checks ranges and applies each id once.
Module routers are mounted at `/api/<module>` (import: `/api/import`). operations, pricing, treasury,
reports and import are built (unknown paths answer 404).
The Excel import (`src/import/`) posts through the treasury functions with `ctx.importRunId` and
writes its own work batches (txn kind `import_work`, doc_type `pricing_batch`); everything it creates
carries `import_run_id`, and a rollback reverses those transactions.
If `src/photos.js` exists, `server.js` calls its `startPhotoJobs/stopPhotoJobs`.
Dates: every stored date is a real calendar day — `parseDate / isRealDate / requireDate` in `src/util.js`
(2026-02-31 is refused); module date helpers delegate to them. `test/e2e.test.js` walks the whole product
over HTTP and crawls every GET endpoint as staff for money leaks — keep it passing when adding endpoints.

## Code map

```
src/server.js          start (PORT, default 4300)       src/cli.js  create-admin · check-db · import-excel
src/app.js             Express app, session/setup/login, /api/audit, mounts every router, Arabic errors
src/db.js              open (data/safa.sqlite), migration loader, audit(), isLegacyDatabase()
src/migrations/        foundation.js = all tables + seeds (accounts, categories, materials, general prices, sequences)
src/ledger.js          post · reverse · balance · partyBalance(s) · statement · accountBalances · nextSerial
                       · isMonthLocked/assertMonthOpen/lockMonth/unlockMonth · CONTROL_ACCOUNT · SECTIONS/MACHINES
src/money.js           parseMoney · formatMoney · mulRound · roundMillimes · balanceWords · stripMoney · isMoneyKey
src/permissions.js     PERMISSIONS, ROLE_PERMISSIONS (admin all; staff operations.*, workorders, expenses.record)
src/auth.js            scrypt passwords, session cookie, lockout, requireUser/requirePerm/requireAny
src/routes/            users.js · parties.js (CRUD, aliases, similar names, balances, /statement) ·
                       lookups.js (lookups, technicians, materials, expense categories, general prices read) ·
                       system.js (backups, update, share/QR, autostart, settings, AI key, month locks)
src/backup.js update.js tunnel.js windows.js version.js settings.js util.js paths.js   generic infrastructure
public/js/app.js       shell (right sidebar menu = the spec's screens, phone bottom bar), hash router, login/setup
public/js/ui.js        h, fill, icon, button, pageHead, field, formModal, confirmModal, modal, toast(+undo), pill,
                       notice, emptyState, underConstruction, skeleton, loadInto, tabs, dataTable, money/num/date,
                       balanceText/balanceCell, parseNum/parseMoneyInput, fold
public/js/grid.js      createGrid(): the Excel-like editable grid (typed white / computed grey, Enter down,
                       Tab across, ditto ~ // 〃, marks red/yellow, totals row, phone cards)
public/js/statement.js renderStatement(box, partyId, opts) · registerDocOpener(docType, fn)
public/js/parties.js   party lists, create/edit form, party file (tabs from modules)
public/js/settings.js  الإعدادات tabs (import tab from module import)
public/js/modules/     one file per module: screens + `export const routes`
public/css/app.css     the one design system (tokens on :root, grid, statement, phone, A4 print)
installer/ scripts/ .github/workflows/release.yml   Windows installer, packaging, CI (tests + release)
```

## Front-end contracts for module builders

- Route: `{ path: '#/x/:id', screen: async (main, params, ctx) => {}, perm: 'p' | any: ['p','q'] }` in your
  module's `routes`. `ctx = { state, can, canAny, go, refresh, loadLookups, query }`.
  The menu in `app.js` is fixed; its hrefs already point at the routes in the stubs — keep those paths.
- Client-file tabs: `async (box, party, ctx)` — `clientPricingSheetTab` (pricing), `clientWorkOrdersTab`
  (operations), `clientFollowUpsTab` (reports). Homes: `reports.homeAdmin`, `operations.homeStaff`.
  Settings tab: `import.importSettingsTab(box, ctx)`.
- A statement row opens its document: `registerDocOpener('<doc_type>', (row) => ...)` (row.doc_id).
- Every screen: `pageHead`, skeleton while loading, `emptyState` with the next action, inline errors
  (`field().setError`, `formModal` maps `ApiError.data.field`), toasts with undo where possible.

## Running

```
npm install                         # npm: C:\Users\karea\node20\npm
npm test                            # = node --test test/   (node\node.exe is the bundled Node)
npm start                           # http://localhost:4300 — first run shows the admin setup screen
node src/cli.js create-admin <user> <password>
```
Set `SHEETMETAL_DATA` to use another data folder (tests use a temp dir). The old database
`data/sheet-metal.sqlite` is never opened; `check-db` reports it as "old database" so the old app's
update button can install this version. Backups are `data/backups/safa_*.sqlite`.

## Installed layout (Windows)

`SheetMetal-Setup.exe` installs to `C:\SheetMetal`; re-running a newer one upgrades the code and never touches
`data\`. `Start Sheet Metal.bat` loops on exit code 42 (restart after update/rollback); `versions\<build>`,
`current.txt`, `previous.txt`, `update-trial.txt` drive the update button and automatic rollback.
Setup only replaces the code it ships: it refuses a non-empty folder that is not a previous install and never
deletes or overwrites `data\`, `versions\` or the pointer files. It writes `setup-build.txt`; the launcher runs
that code when it is newer than `current.txt`'s build, and the app then adopts the pointers (`adoptInstalledCode`).
The bundled `node\node.exe` must be the same major version as `NODE_VERSION` in release.yml.

## Node version

**Node 22 is the one version.** Every `SheetMetal-Setup.exe` so far bundled Node 22 (CI has used
`NODE_VERSION: '22'` since the first release), and the update button refuses a package whose `node_abi`
differs from the installed `node\node.exe`, so moving releases to 20 would strand every install, including
the old app's update path into this version. CI runs the tests on 22, i.e. on what users run.
The dev copy's `node\node.exe` here is still 20.19.1 (npm at `C:\Users\karea\node20`): fine for writing
code, but switch it to a Node 22 build (and reinstall `node_modules`) before testing a release locally.
`engines` stays `>=20`.
