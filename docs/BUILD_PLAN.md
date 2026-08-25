# FreedomCRM — MVP build plan and state

Working doc for the multi-tenant rebuild. Last updated 2026-08-20.
Read this first when resuming; it carries decisions that are not derivable from the code.

---

## Deployment — read before pushing anything

| | |
|---|---|
| Live site | https://trepin3.github.io/FreedomCRM/ |
| **Pages serves `gh-pages`, NOT `main`** | Pushing to `main` publishes nothing |
| Deploy step | `git checkout gh-pages` → `git checkout main -- index.html` → commit → push → `git checkout main` |
| `Code.gs` | Does **not** deploy via git. Paste into the Apps Script editor, save, then Deploy → Manage deployments → pencil → **New version** → Deploy. Creating a *new* deployment mints a new URL and leaves the old one live. |
| Apps Script URL | In `CONFIG.APPS_SCRIPT_URL` in `index.html` |
| `Code.gs` drift | `main` and `gh-pages` copies differ; Pages does not execute it, so it is reference only. Apps Script runs whatever was last pasted. |

---

## Built and verified live

- **Google Sign-In**, enforced server-side. `verifyGoogleToken_` checks `aud` against the client id (without that check any Google token would pass), `email_verified`, and expiry. HMAC-signed session in `localStorage`, re-verified per request. Confirmed by probe: unauthenticated and forged-token requests both return `auth_required`.
- **`Users` table** with materialised paths (`U001>U007>U042`). `migrateAgentsToUsers()` has been run; admin is `U001`.
- **Permission helpers**: `pathStartsWith_`, `isInDownline_`, `canManage_`, `downlineOf_`, `visibleOwnerIds_`.
- **User endpoints**: `myTeam`, `createUser`, `reassignUser`, `disableUser`, `promoteUser`, `demoteUser`, `revokeUser`, `pauseUser`, `resumeUser`.
- **`adminStats` / `adminLocks` scoped** to the caller's downline via `scopeNamesFor_` (matches on display name — see Known weak points).
- **`ActivityLog`** recording verified identity per action.
- Lead rail, callback day-agenda panel, readable lead detail grid.
- **Team portal** — one screen for admin and managers, scoped server-side by `myTeam`. Add, reassign, promote, demote, pause, resume, revoke.
- **Lead schema rewrite** — 58 columns, one `Leads` tab per state, rows never move. `Status` changes in place so `Lead ID` is permanent. Reservation moved off `Status` onto `Locked By`/`Locked At` + `Last Activity At`/`Call Open At`, with 15-min idle release and a 2-hour open-call ceiling. `canSee_` enforces pool/exclusive/shared visibility — unit-tested, including admin being correctly blocked from an agent's exclusive leads.

OAuth client id is shared with Agent-HUD-Workstation — same `trepin3.github.io` origin, so no Cloud Console work was needed.

- **Lead sources** in the auth spreadsheet, seeded with the three. "Other" queues as `pending`; admin adding one skips its own queue.
- **CSV upload** — file picker, drag-drop or paste. Guesses the mapping from header names, previews five mapped rows, requires name + phone. Quoted fields honoured; Excel BOM stripped; `.xlsx` refused with export instructions.
- **Name stored split** — `First Name`/`Last Name` columns with `Name` kept as the composed display value, so the UI still reads `.name`. Works whichever shape the file has.
- **State decided by ZIP**, not the state column. Vendor state columns are unreliable — the Bang Bang file had 35 rows labelled GA/TX/NC that are all Cleveland ZIPs. Mixed files split by state, one upload request per state, each with its own batch id. Rows for a state with no sheet are named and refused.
- **Blank cities filled from ZIP** via zippopotam.us (free, keyless, CORS-open), button-triggered, cached in localStorage. Not a built-in table — an invented ZIP-to-city map would put wrong data in the CRM.
- **All 51 states supported.** Sheets are created on first upload and recorded in Script Properties; the dial picker shows only states holding leads the signed-in user can see, with counts, cached 120s.
- **Batches** — every upload grouped, removable by flipping `Batch Status`, never deleted.
- **Ownership** — exclusivity, sharing and donate-to-pool, per batch and per lead. Donated leads never return to the donor's own queue (`Donated By` is checked in `getLeads`); a donated batch stays visible to the donor as a record but is read-only to them, and shows who it came from to the receiver.
- **150-lead reservation.** Locks are written as one block (columns 6-9) rather than per cell — at this size, per-cell writes timed out. Your own reservation counts as available to you, and `getLeads` returns your existing stack topped up rather than issuing a second one.
- **Force release** targets the named agent (via `body.target`, which `doPost` does not overwrite), and the agent's tab notices within ten seconds and returns to the picker. `setStatus_` refuses a disposition on a lead the caller no longer holds.
- **Lead editing** by anyone who can see a lead, logged field by field before-and-after.
- **DCID review** — scoped queue, bulk return-to-pool or archive, attempt counts preserved on return.
- **Leaderboard** — dials, policies or annual premium, over five ranges, re-ranked client-side.
- **Callbacks → Google Calendar** on booking and from the list, at the lead's local time.
- **Script tool integration** — a `$1 Bang Bang` lead opens `bang-bang.html` prefilled with first name, last name and address.

## Not built

**Sold workspace + ERS follow-ups** · **stat drill-down modals** · **Trellus receiver** · **automatic calendar insert**.

The last two are blocked on things outside the code: Trellus needs the Cloudflare Worker relay, and calendar insert needs Google's review of the `calendar.events` scope.

**Still unproven:** the 72-hour callback hold (`Callback Hold Until`) has never actually expired in use, and no second agent has been handed a lead whose hold lapsed. Everything else in the dial round-trip has now been exercised live.

`docs/planned_lead_schema.gs` was the design sketch; it is now **applied** in `Code.gs` and kept only for reference. Two deliberate departures from it: `Locked By`/`Locked At` keep their old names rather than becoming `Reserved By`/`Reserved At` (name-based lookups meant renaming was the only thing that actually broke callers), and disposition extras keep their old names so `rowToObj`'s derived field names stay stable for the UI.

**Migration is not automatic.** After pasting `Code.gs`, run `migrateLeadSchema()` once. It folds the six old tabs into one, derives `Status` from the source tab, assigns `Lead ID`s, backfills `AP Amount`, and renames old tabs with an `_old` suffix rather than deleting them — so it is reversible. `seedDummyLeads()` re-seeds test data in the new shape.

---

## Decisions (all confirmed by Kepler)

**Hierarchy.** Admin → managers → managers → agents, arbitrary depth. Materialised path on each user answers downline, visibility and lead access from one column.

**Lead visibility.** Visible if (`visibility = pool` AND `owner_id` in my path) OR I own it OR my id is in `shared_with`. Exclusivity needs its own flag — path alone does not give it, since admin's id is in everyone's path.

**Donate to pool.** Has a downline (managers with reports, admin): `owner_id` stays, `visibility` → pool, so it lands in their own branch. No downline (agents, childless managers): `owner_id` → `parent_id`. Confirmation names the destination. Skips leads currently reserved.

**Statuses.** Rows never move between tabs; `status` changes in place, so `lead_id` is permanent.
- DCID = "Doesn't Care In Denial" — crash out / not interested. Returnable to pool after manager or admin review.
- Wrong number returnable once the number is corrected.
- Callbacks return 24h after the appointment if not cleared; held for the booking agent 72h, then open pool.
- Sold returnable — admin or the selling agent directly, anyone else flags for admin approval.

**Reservation.** 150 leads per agent for Trellus autodial. Priority: never-dialled first, then longest since last dial. 4-hour cooldown, ignored if it would starve the batch. Released after **15 min idle**; an open call holds it, ceiling **2 hours**. Per-agent sort, wrapped in `LockService`.

**Accounts.** Status `active` / `paused` / `revoked`. Promote agent→manager: admin or the manager above them. Demote / revoke / pause / resume: **admin only**. Demote and revoke roll reports up to the parent; **pause deliberately does not** (temporary, tree intact). Pause and revoke release reservations.

**Lead sources.** Seeded `$1 Bang Bang`, `$1 Goat`, `DashlyPro`. Required on upload. "Other" → free text → `pending` row → admin approves/renames/rejects; admin sees who submitted.

**Upload.** CSV paste, column mapping with preview, batch-tagged. Name + phone required. Duplicate phone skipped **within the same owner's pool only**; cross-pool matches flagged, not blocked. Uploader sees their own batches; batch removal is a **status flip, never a row delete**. Managers remove their own, admin removes any.

**Leaderboard.** AP = monthly premium × 12. Ranges day / week / month / year / all-time, per agent. Stays company-wide; everything else scopes.

**Editing.** All users can edit any lead they can see. Log before-and-after values — the activity log is the only record of who changed what.

**Calendar.** Ship one-click add-to-calendar (`.ics` with 1-day and 30-minute reminders) now. Automatic insert needs the sensitive `calendar.events` scope and Google verification — start that queue early, swap later.

**Nobody but Kepler ever opens the Sheets.** Every correction path must exist in-app.

---

## Trellus integration (spec received 2026-08-17)

Their model: our CRM owns assignment and locking; the active lead is addressable at `?lead_id=…`; they take over the call button, place the call, and POST the result.

**Blocker:** they POST **browser-side** from the extension's background worker with `Authorization: Bearer <token>`. A custom header forces a CORS preflight, and Apps Script has no `doOptions` — the request fails before our code runs. **Needs a Cloudflare Worker** (free tier) to answer the preflight, check the bearer token, and forward to Apps Script. The token lives in Worker config, not the public repo.

Origin to send them is `https://trepin3.github.io` — the Worker is the *webhook URL*, a separate field, and does not host the page.

Idempotency key is `call.completed:{session_id}`; return 200/204 if already applied. Store keys in a `ProcessedEvents` tab.

**Built 2026-08-24.** `?lead_id=OH-000513` opens straight to that lead after
sign-in. `leadById` resolves an id to a lead with the caller's own visibility
applied. `trellusEvent` receives results, keyed on `call.completed:{session_id}`
in a `ProcessedEvents` tab so a retry acknowledges rather than dispositions
twice. `setupTrellus()` mints the shared secret the Worker carries.

An outcome we have not agreed records the call and flags it rather than guessing
a disposition — guessing takes a live lead out of the pool. An unmatched
`rep_email` still records the call against the lead and marks it unattributed.

**Remaining: the Cloudflare Worker.** The receiver trusts its caller, so the
Apps Script URL must never go to Trellus — the Worker URL does. The Worker
answers the preflight, checks their bearer token, and forwards with the shared
secret.

Still owed to Ajinkya: production origin, webhook URL, final disposition vocabulary, bearer token (shared securely), confirmation `lead_id` loads from URL. **Do not send the token or URL until the receiver exists and is tested.**

Unmatched `rep_email`: record the call against the lead, flag unattributed in the log, credit nobody.

---

## Build order

**Launch week:** schema rebuild → team portal → lead sources → upload with mapping → visibility + dial-session toggle → reservation → leaderboard AP → add-to-calendar.

**After:** DCID review + archive · sold workspace + follow-ups · stat drill-down modals · Trellus receiver · automatic calendar post-verification.

Kepler chose to build the **team portal before the lead schema rewrite**, so agents can be onboarded while the deeper work lands. Do not build portal features that assume the new lead columns.

---

## Functions to run from the editor

| | |
|---|---|
| `inspectSheets()` | Read-only. Tabs and row counts per state, and whether each is migrated. |
| `migrateLeadSchema()` | Once. Skips states already migrated. Renames old tabs, never deletes. |
| `backfillNameParts()` | After any schema column is added. Widens sheets, rewrites the header, splits `Name`. Fills blanks only, so re-running is safe. |
| `seedDummyLeads()` | Test data in the new shape. Appends. |
| `setupAuth()` | Once, already done. Creates the auth spreadsheet. |

## Known weak points

- **Stat scoping matches on display name**, because dispositions record names not ids. `agent_id` is in the planned schema and should replace this during the lead rewrite. Until then, `Users` display names must match the names written into lead rows.
- **`listStates_` opens every registered spreadsheet.** Fine at a handful of states; at 20+ the 120s cache is the only thing keeping sign-in fast. If it gets slow, store per-state counts in the auth sheet and refresh them on upload and disposition.
- **Multi-timezone states** use whichever zone holds most of the population, so a west-Texas or Florida-panhandle lead can be an hour off inside the TCPA window. Only a ZIP-level timezone lookup fixes this properly.
- **Volume ceiling**: comfortable to ~10k *active* leads per state; 10–25k noticeable; 25k+ painful; beyond needs a real database. Archiving keeps the active count down independently of history.
- 150-lead reservations mean 10 concurrent agents need ~1,500 available leads in a state.
- No transactions. `LockService` covers ordinary contention only.
- `ActivityLog` will be the fastest-growing tab — roll it monthly (`ActivityLog_2026-08`) before it slows sign-in.
- The `Agents` tab is legacy; `findAgent_` falls back to it. Safe to delete once everyone is confirmed in `Users`.
- All lead data as of 2026-08-17 is dummy and disposable — no migration risk on the schema rewrite.

## Outstanding non-code items

- Rotate the Apps Script deployment URL — the pre-auth one was open and is in a public repo's history.
- Start Google OAuth verification for `calendar.events`.
- Add real agents to `Users` before they try to sign in; they are locked out until then.
