# Trellus activity signals — as built

> **Superseded.** This file originally proposed a `call.started` event posted to
> the Cloudflare Worker alongside the existing completion webhook. Trellus built
> something different and better suited: `window.postMessage` from the extension
> into the CRM page. The webhook contract is **unchanged** and still owns every
> outcome. What follows is what actually exists.

## Two channels, different jobs

| | Transport | Carries | Owns |
|---|---|---|---|
| **Webhook** | extension → Worker → Apps Script | outcome, duration, timestamps | dispositions, attempts, call records |
| **Activity signal** | extension → `postMessage` → CRM page → Apps Script | session id, lead id, timestamps | keeping a rep's stack alive |

Nothing was removed. The activity signal answers one question the webhook
could not: *is this rep on a call right now?*

## Why it was needed

A rep dialling through Trellus never clicks anything in the CRM. No `tel:`
navigation, no `callStarted`, and with the tab behind a carrier portal, no
heartbeat either. Their first long call of a session could age their whole
stack out from under a live conversation.

Measured against the release rules with the presence cache cold: a 25-minute
first call released **150 of 150 leads** without a start signal, and **0** with
one.

## The message

```json
{
  "source": "trellus-extension",
  "target": "freedomcrm",
  "type": "trellus:call.started",
  "version": 1,
  "payload": {
    "event_id":   "call.started:session_123",
    "session_id": "session_123",
    "lead_id":    "OH-000513",
    "direction":  "outbound",
    "started_at": "2026-09-14T19:00:00.000Z",
    "timestamp":  "2026-09-14T19:00:00.000Z"
  }
}
```

At hangup: `type` is `trellus:call.completed`, `event_id` is
`call.completed:session_123`, and the payload adds `ended_at`. Same
`session_id` and `lead_id` identify the attempt. `started_at` may be null.

## What the CRM does

**Validation** — rejects anything failing `event.source === window`,
`event.origin === window.location.origin`, `source`, `target`, `version`, a
known `type`, or a payload missing `session_id` / `lead_id`. Ten rejection
cases are covered by test.

**Deduplication** — by `event_id`, in a set capped at 500. Redials carry their
own session id, so the id is safe to key on.

**Parallel dialling** — active sessions are held in a Map, added on start and
removed on completion. A completion is relayed **even while other legs are
still live**, because `Call Open At` belongs to the lead, not the agent —
leaving it set on a finished call is exactly the stuck flag to avoid. The rep
stays protected regardless: the release rules hold an owner's entire stack
while *any* row they own has an open call.

**The lead attached to the call** — never whichever card is on screen. A rep
parallel dialling is looking at one lead and talking to another.

## Security

Trellus are explicit that this is an activity hint, not authentication — any
script on the page could post one.

So the CRM trusts the **session** for *who* and refuses to trust the **message**
for *what*. The relay runs on the agent's own authenticated session, and the
backend will only touch a lead **that agent already holds**. A forged message
can do nothing except keep the sender's own stack alive, which they could do by
pressing a button anyway.

It writes no disposition and no attempt. Outcomes remain the webhook's job.

## Stale-session recovery

Trellus note that a missed completion must never hold leads forever. Three
layers:

1. Completion clears `Call Open At` at hangup rather than waiting for a ceiling.
2. The page drops locally-tracked sessions after 2 hours.
3. `releaseStale_` frees any call open longer than `OPEN_CALL_CEILING_MS`, and
   since `sweepLocks()` this actually runs on a timer rather than only when
   somebody happens to request that state.

## Status

Built and deployed on the CRM side. **Not yet in the published Chrome Store
build** — until Trellus ship it, no messages arrive and nothing changes.
