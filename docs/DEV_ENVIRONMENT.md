# Development environment

Agents are live on production. This sets up a second, completely separate copy
so we can build Trellus without touching a real lead.

**The separation is total.** Staging is its own Apps Script project, so it gets
its own auth spreadsheet, its own state spreadsheets, its own users and its own
session secret. There is no configuration shared between them and no code path
from one to the other. A staging session token is not even valid in production —
different `SESSION_SECRET`.

---

## How the front end picks a backend

`index.html` resolves the environment at load:

| Where it's running | Backend |
|---|---|
| `trepin3.github.io` | production |
| `localhost`, `127.0.0.1`, a LAN IP, anything else | staging |

Nothing you run locally can reach production data. There is no flag to set and
nothing to remember before you start working.

Staging shows an orange banner across the top of every screen. If you ever don't
see that banner locally, stop — you are on production.

**The escape hatch:** `?env=prod` forces production from localhost, for
reproducing a live bug. It is not sticky, it dies with the page, and the banner
turns red and says so. Use it read-only.

---

## One-time setup

### 1. The staging Apps Script project

1. **script.google.com** → **New project**, name it `FreedomCRM — STAGING`.
2. Paste the entire contents of `Code.gs` into it. Same file, unmodified.
3. Run `setupAuth()`. Grant permissions when asked.
   Creates the staging auth spreadsheet, seeds you as admin, mints a secret.
4. Run `createAllStateSheets()`.
5. Run `seedDummyLeads()`.
6. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Copy the `/exec` URL.

> Keeping the code identical between the two projects is what makes staging
> worth having. When you change `Code.gs`, paste it into staging first, prove it
> there, then paste it into production.

### 2. Point the front end at it

In `index.html`, find `ENVIRONMENTS` and fill in the staging URL:

```js
staging: {
  name: 'staging',
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/PASTE_HERE/exec'
}
```

Leave the `prod` entry alone.

### 3. Authorise localhost for Google Sign-In

Google Identity Services refuses to load on an origin the OAuth client doesn't
know, and it does not work from `file://` at all. You must serve over http.

1. **console.cloud.google.com** → **APIs & Services → Credentials**
2. Open client `416228276690-41m3pskc2ga2he06jvgusp23j1fvaepk`
3. Under **Authorized JavaScript origins**, add:
   - `http://localhost:8000`
4. Save. Changes can take a few minutes.

Adding localhost does not weaken production — an attacker would need to be
serving on your machine's localhost to use it.

---

## Working locally

```sh
cd "WM & Associates/FreedomCRM"
python3 -m http.server 8000
```

Then open **http://localhost:8000/** — not `127.0.0.1`, and not the file
directly, because the port and hostname have to match the authorised origin
exactly.

Edit `index.html`, refresh, repeat. Nothing is built and nothing is watched.

---

## Shipping to production

Unchanged, and still two separate steps:

**Front end** — from `main`, with everything committed:

```sh
git checkout gh-pages
git checkout main -- index.html
git commit -m "Deploy: <what changed>"
git push origin gh-pages
git checkout main
```

**Backend** — `Code.gs` never travels through git. Paste it into the production
Apps Script editor, then **Deploy → Manage deployments → pencil → New version**.
A *new deployment* mints a new URL and breaks every signed-in agent.

The staging URL living in `index.html` ships to production too. That is fine and
intentional: production never reads it, because the hostname check picks `prod`
before the staging entry is ever touched.

---

## Editor functions worth knowing in staging

Run these from the staging project only. In production they are destructive.

| Function | What it does |
|---|---|
| `seedDummyLeads()` | Fills the state sheets with fake leads |
| `removeDummyLeads()` | Takes them back out |
| `clearAllLeads()` | Empties every state sheet |
| `poolReport()` | Counts what's reserved, dialled, available |
| `inspectLeadRow(state)` | Dumps one row against the schema |
| `checkClock()` | Script timezone vs real time |

---

## Next: Trellus

Trellus needs a receiver the browser extension can post call events to, which
Apps Script can't be — no custom response headers, so no CORS preflight. The
plan on file is a Cloudflare Worker in front of the staging Apps Script.

Build it against staging first. Dummy leads mean a wrong disposition or a
double-release costs nothing, which is exactly the freedom this environment
exists to give.
