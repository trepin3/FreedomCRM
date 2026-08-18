# FreedomCRM — MVP build plan and state

Working doc for the multi-tenant rebuild. Last updated 2026-08-17.
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

OAuth client id is shared with Agent-HUD-Workstation — same `trepin3.github.io` origin, so no Cloud Console work was needed.

## Not built

Team portal UI · lead sources · upload + column mapping · lead visibility/exclusivity · 150-lead reservation · leaderboard AP · add-to-calendar · DCID review + archive · sold workspace · stat drill-downs · Trellus receiver.

`docs/planned_lead_schema.gs` holds the designed 59-column schema. It was written into `Code.gs` and **reverted**, because it renames `Locked By`/`Locked At` and breaks every existing lead function. Re-apply only as part of the lead rewrite.

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

Still owed to Ajinkya: production origin, webhook URL, final disposition vocabulary, bearer token (shared securely), confirmation `lead_id` loads from URL. **Do not send the token or URL until the receiver exists and is tested.**

Unmatched `rep_email`: record the call against the lead, flag unattributed in the log, credit nobody.

---

## Build order

**Launch week:** schema rebuild → team portal → lead sources → upload with mapping → visibility + dial-session toggle → reservation → leaderboard AP → add-to-calendar.

**After:** DCID review + archive · sold workspace + follow-ups · stat drill-down modals · Trellus receiver · automatic calendar post-verification.

Kepler chose to build the **team portal before the lead schema rewrite**, so agents can be onboarded while the deeper work lands. Do not build portal features that assume the new lead columns.

---

## Known weak points

- **Stat scoping matches on display name**, because dispositions record names not ids. `agent_id` is in the planned schema and should replace this during the lead rewrite. Until then, `Users` display names must match the names written into lead rows.
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
