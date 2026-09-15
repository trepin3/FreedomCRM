# `call.started` — spec for Trellus

One extra event. Same endpoint, same bearer token, same body shape as today,
plus one field.

## Why we're asking

Trellus currently posts once, at the end of a call. FreedomCRM reserves a rep a
stack of ~150 leads and releases it when nothing says they're still working — so
the completion event doubles as our "this rep is alive" signal.

That works until a rep's **first** call of a session runs long. The CRM tab is
usually behind a carrier portal or a quoter by then, our in-page heartbeat stops
when the tab is hidden, and no completion has arrived yet. Nothing anywhere says
the rep is on a call, and their stack ages out from underneath a live
conversation. Simulated against our release rules: **150 of 150 leads released
mid-call without a start signal, 0 with one.**

## The change

Add `"event"` to the payload you already send.

| `event` | When |
|---|---|
| `"call.started"` | the moment dialling begins |
| `"call.completed"` | what you send today |

**The field is optional and defaults to `call.completed`.** Your current
integration keeps working with no change — we deployed it that way on purpose so
you can roll this out whenever suits you.

## `call.started` payload

```json
{
  "event": "call.started",
  "session_id": "abc123",
  "lead_id": "NC-001042",
  "rep_email": "brad@example.com",
  "started_at": "2026-09-14T14:32:11Z"
}
```

| Field | Required | Notes |
|---|---|---|
| `event` | yes | literal `call.started` |
| `session_id` | yes | **must match the `session_id` of the eventual `call.completed`** |
| `lead_id` | yes | the id we handed you |
| `rep_email` | no | we credit whoever holds the lead, so this is nice-to-have |
| `started_at` | no | ISO 8601. We stamp server-side if absent |

No outcome, no duration — there isn't one yet.

## Delivery semantics

- **Fire and forget.** Don't retry, don't block the dial on our response. A lost
  start event costs us nothing that the completion won't fix.
- **Redelivery is safe.** The handler is idempotent — a repeated start rewrites
  the same two cells.
- **Out-of-order is safe.** A start arriving after its own completion is
  detected and ignored, so it can't reopen a finished call.
- The completion event is unchanged in every respect.

## Response

`200` with `{"ok": true, "applied": "call opened"}`.

A start for a session we've already seen completed returns
`200 {"ok": true, "ignored": "call already completed"}` — success, nothing to do.

## What we do with it

Mark the call open on that lead, which holds the rep's whole stack for as long
as the call runs (capped at 2 hours, so a browser that dies mid-call can't sit on
150 leads forever). We do **not** increment attempts or write a disposition —
the completion event still owns both.
