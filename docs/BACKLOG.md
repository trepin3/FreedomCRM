# Backlog

Nothing here is broken. This is what I would fix next, and why — written down so
it does not have to be re-derived.

As of 2026-09-20: `Code.gs` repo and deployment both on `2026-09-16.event-perf`,
`main` pushed, `gh-pages` identical to `main`, working tree clean.

---

## 1. Cache `usersAll_` per execution

**The one worth doing first.** `usersAll_` re-reads the Users sheet on every
call and there are **50 `userByEmail_` call sites**. A single request reads that
sheet three or four times — `verifySession_`, then the dispatch, then again
inside the handler.

This is the same pattern that caused three separate problems this week:

- `backfillTrellusOwners` hit the six-minute execution limit resolving a user
  per row
- `repairAgentAttribution` did seven hundred sheet reads on the run that
  mattered
- `alreadyProcessed_` scanned the entire event log on every dial, which is what
  produced *"A call couldn't be logged"*

It is not hurting yet only because Users is fifteen rows. A one-line memo cache
removes the whole category.

## 2. `leadRowById_` scans every state sheet

Runs on every Trellus event. The state-prefix guess means it usually hits the
right sheet first, so it is fine at four states and gets worse with each one
added. An id→(state,row) index in Script Properties, written on upload, would
make it a lookup.

## 3. Archive `ProcessedEvents`

Growing about 1,600 rows a day. The dedupe no longer scans the whole tab, but
`appendRow` slows on a very large sheet. Fine for roughly a year; a yearly
archive-and-truncate avoids ever thinking about it again.

## 4. `HEAD /api` returns 405

The gateway only accepts GET and POST, so a `curl -I` health check gets a 405.
Harmless — nothing in the app sends HEAD — but it makes external monitoring
report a false failure.

---

## Not code

**Delete the test accounts.** `Test`, `Tester`, `Testing` and `Ajinkya Test` are
live rows in Users. They can sign in and reserve leads. Nothing has gone wrong;
it is simply real access nobody intends to use.

**Audio quality on Trellus.** Reported 2026-09-16, never resolved — it got
buried under the logging bug, which turned out to be unrelated and ours. Audio
is entirely their side: their WebRTC, their carrier. If it is still happening it
needs to go back to Ajinkya as its own conversation.

**Appointment Autopilot is dormant.** Built, deployed, and the UI has still
never been opened. Sending is blocked regardless: `beneficinsurance.com` has SPF
`-all` authorising only GoDaddy, so Brevo mail is hard-rejected. That is a DNS
change, not a code change. No DMARC either.

**Google OAuth verification.** Agents still see "Google hasn't verified this
app." Needs a homepage and privacy policy on `webdevus.com`.

---

## Known limits, not bugs

**The disposition audit cannot detect a lost event.** `THEIRS TO EXPLAIN` counts
leads with a recorded call but no event — and `Last Call Start` is written *by*
the event handler. So an event that never arrived leaves no trace to count.
A zero there means "nothing recorded is missing its event", not "nothing was
lost". Settling that properly needs Trellus's own call count for a window.

**Apps Script fails in waves.** Measured at roughly 25% over hours, then twelve
consecutive clean requests the next day. The gateway's four attempts absorb it;
`X-Gateway-Attempts` on any response says how hard it is currently working.
