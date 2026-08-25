# Trellus relay — deployment

Free Cloudflare account, no card. Ten minutes.

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
