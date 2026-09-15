# FreedomCRM edge gateway — deployment

Free Cloudflare account, no card. Ten minutes.

One Worker, two paths:

| Path | Who calls it | What it does |
|---|---|---|
| `POST /` | Trellus | relays call events — **unchanged, do not repoint them** |
| `GET\|POST /api` | the CRM front end | proxies to Apps Script and retries its routing miss |

---

## The gateway, and why

Apps Script's `/exec` URL returns a Google "Page Not Found" page instead of the
app for roughly **a quarter of requests** — measured over hours, spaced twenty
seconds apart, with nobody dialling. The script answers in single-digit
milliseconds when it runs, so this is Google's routing failing ahead of our code.

The browser already retried, but badly: three attempts three seconds apart, on
the agent's machine, triggered only by `JSON.parse` happening to throw. Nine
seconds of an agent's time to cover a failure that comes back instantly.

Retrying at the edge costs tens of milliseconds, and retries for the right
reason — the shape of that error page, not any parse failure. Four attempts take
a 25% failure rate to about **one request in 250**.

**POSTs are treated more carefully than GETs.** `sold` and `dcid` are not
idempotent, and replaying one that actually landed would disposition a lead
twice. So an error *page* is retried for both (the script never ran, nothing
happened), but a request that *threw* is only retried for a GET, because that
case is ambiguous — it may have run and the reply was lost. The browser's retry
never drew that distinction.

### Rotating a flaky deployment

This is the other reason it exists. The deployment URL is no longer baked into
`index.html`, so replacing it is a **secret update here** — instant, no
`gh-pages` deploy, and no window where half the agents are on the old URL and
half on the new one. Update `SCRIPT_URL`, done.

### Testing the gateway

```sh
curl -s "WORKER_URL/api?action=ping"
```

Expect `{"ok":true,"version":"…"}`. Run it twenty times — every one should
succeed, where the raw `/exec` URL fails about a quarter of the time. The
`X-Gateway-Attempts` response header says how many tries it took.

```sh
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code} " "WORKER_URL/api?action=ping"; done
```

---

## The Trellus relay

## 1. Create the Worker

1. **dash.cloudflare.com** → **Workers & Pages** → **Create** → **Worker**
2. Name it `trellus-relay`. Deploy the placeholder.
3. **Edit code**, delete what is there, paste all of `trellus-relay.js`, **Deploy**.

## 2. Add the three secrets

**Settings → Variables and Secrets → Add**, and choose **Secret**, not Text — a
plain variable is readable from the dashboard by anyone with access.

| Name | Value |
|---|---|
| `SHARED_SECRET` | the string `setupTrellus()` printed |
| `SCRIPT_URL` | the FreedomCRM `/exec` URL |
| `TRELLUS_TOKEN` | a token you generate — see below |

Generate the token:

```sh
openssl rand -hex 32
```

Keep a copy. It is the only credential Trellus ever holds, and rotating it means
setting it here and sending them the new one.

## 3. Test it before anyone else sees it

Replace `WORKER_URL`, `YOUR_TOKEN` and use a real Lead ID.

**A wrong token must be refused:**

```sh
curl -i -X POST "WORKER_URL" \
  -H "Authorization: Bearer wrong" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"t1","lead_id":"OH-000513","outcome":"no_answer"}'
```
Expect **401**.

**A real event should apply:**

```sh
curl -i -X POST "WORKER_URL" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"t2","lead_id":"OH-000513","rep_email":"corey@example.com",
       "outcome":"no_answer","duration":"12"}'
```
Expect **200** and `"applied":"call recorded"`. Check the lead's `Attempts` went
up and `Last Call Agent` is set. `no_answer` deliberately does **not** change
Status — the lead stays dialable.

**Sending it twice must not apply it twice:**

```sh
# exactly the same command again
```
Expect **200** with `"duplicate":true`, and `Attempts` unchanged. This is the
one that matters most: an extension retrying on a flaky connection must not
disposition a lead twice.

**An unknown outcome must not guess:**

```sh
curl -s -X POST "WORKER_URL" -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"t3","lead_id":"OH-000513","outcome":"left_message_2"}'
```
Expect `"applied":"unknown outcome — left for a human"`. Status untouched.

**A lead that does not exist:**

```sh
curl -i -X POST "WORKER_URL" -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"t4","lead_id":"OH-999999","outcome":"sale"}'
```
Expect **404**.

Then open the `ProcessedEvents` tab in the auth spreadsheet — every test should
be there with its key, outcome and result.

**Clean up:** the tests above put real values on `OH-000513`. Reset its
`Attempts`, `Last Call Agent`, `Last Call Start` and `Status Reason` by hand
before that lead goes back into rotation, and delete the `t1`–`t4` rows from
`ProcessedEvents` so the keys are free if you test again.

## 4. Only then, send Trellus

- **Webhook URL** — the Worker URL. **Never the Apps Script URL.**
- **Bearer token** — `TRELLUS_TOKEN`, over something better than email.
- **Origin** — `https://trepin3.github.io`
- **Lead id in the URL** — `https://trepin3.github.io/FreedomCRM/?lead_id={lead_id}`
- **Outcomes we understand** — `sale`, `not_interested`, `dnc`, `wrong_number`,
  `callback`, `no_answer`, `voicemail`, `busy`, `failed`, `abandoned`.
  Ask which of these they actually send, and what else. Anything unrecognised is
  recorded and flagged rather than guessed, so a mismatch shows up in
  `ProcessedEvents` instead of quietly killing leads.

## Why the Apps Script URL stays here

The receiver authenticates with `SHARED_SECRET` and nothing else — it has no
idea who is calling. Anyone with that URL and the secret can disposition any
lead. The Worker is what stands between Trellus and that, which is the entire
reason it exists, so the split only holds if the script URL never leaves this
Worker's config.
