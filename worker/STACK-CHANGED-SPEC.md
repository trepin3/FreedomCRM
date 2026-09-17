# `freedomcrm:stack.changed` — when to refresh the task list

Live on `trepin3.github.io/FreedomCRM` now. Nothing listens for a reply, so it
is safe to ignore until you are ready.

## The problem it solves

A rep's stack is not static. FreedomCRM reserves them a stack of leads and then
**changes it underneath the dialer**:

- **Topped up.** Reloading refills to 150 — dispositioned leads drop out, new
  ones come in. Same session, different leads.
- **Emptied.** They work through it.
- **Pulled.** An admin can release a stack, and it ages out on its own after an
  hour with no dialling. Those leads go back to the pool and someone else can
  reserve them.
- **Switched.** Changing state reserves a different stack entirely.

A task list built once at load time is wrong after any of those. We had a rep
looking at *"No dialable tasks available"* while the CRM behind it held a full
stack of 150.

**The pulled case is the one that matters most.** A dialer still working a stack
the rep no longer owns is calling prospects another agent is now working.

## The message

Same envelope as yours, pointing the other way. `window.postMessage`, targeted
at our own origin.

```json
{
  "source": "freedomcrm",
  "target": "trellus-extension",
  "type": "freedomcrm:stack.changed",
  "version": 1,
  "payload": {
    "reason": "loaded",
    "agent_email": "brad@example.com",
    "state": "NC",
    "count": 150,
    "leads": [
      { "lead_id": "NC-000101", "phone": "9195550101", "name": "Ada Lovelace", "state": "NC" }
    ]
  }
}
```

| `reason` | When | What we would expect |
|---|---|---|
| `loaded` | a stack was reserved or refilled | replace the task list with `leads` |
| `empty` | nothing available in that state | clear the task list |
| `released` | the stack was pulled or aged out | **clear the task list and stop dialling it** |
| `requested` | you asked | replace the task list |

`leads` is the complete stack, not a delta — replacing wholesale is simpler than
reconciling and cannot drift. Leads with no phone number are omitted.

## Asking for it

If your adapter initialises after a stack has already loaded, you would
otherwise hear nothing until the next reload. Two ways round that:

- We answer `trellus:present` with a `stack.changed` carrying `reason:
  "requested"`, so your existing presence ping is already enough.
- Or send `trellus:stack.request` with the usual envelope
  (`source: "trellus-extension"`, `target: "freedomcrm"`, `version: 1`) and we
  reply the same way.

Both are no-ops when no stack is loaded.

## Validation

Mirror of what you asked us to do: check `event.source === window`,
`event.origin === window.location.origin`, then `source`, `target`, `version`
and `type`.

We do the same on the way in, and a `stack.request` from any other origin is
answered with nothing.

## What it is not

Not authentication, and not a licence check — the same footing you put your own
signals on. It is a hint that the queue you hold is stale.

It carries the prospect's number because a task needs something to dial. Phones
are sent exactly as stored; our own dialling path is what normalises them to
E.164, and formatting them twice in two places would eventually put two
different numbers in front of the same prospect.
