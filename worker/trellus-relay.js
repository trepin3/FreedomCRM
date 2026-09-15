/**
 * FreedomCRM edge gateway.  Cloudflare Worker, free tier.
 *
 * Two jobs, on two paths.
 *
 * ── POST /  — the Trellus relay (unchanged) ─────────────────────────────────
 * Trellus posts from a browser extension with an Authorization header. A custom
 * header makes the browser send a CORS preflight OPTIONS request first, and
 * Apps Script has no doOptions — the request fails before any of our code runs.
 * This Worker answers the preflight, checks their bearer token, and forwards the
 * body to Apps Script as text/plain, which needs no preflight at all.
 *
 * ── GET|POST /api  — the CRM gateway ────────────────────────────────────────
 * Apps Script's /exec URL returns a Google "Page Not Found" page instead of the
 * app for roughly a quarter of requests — measured over hours, spaced twenty
 * seconds apart, with nobody dialling. The script itself answers in single-digit
 * milliseconds when it runs at all, so this is Google's routing failing ahead of
 * our code rather than anything the app does.
 *
 * The browser already retried, but badly: three attempts three seconds apart, on
 * the agent's machine, triggered only by JSON.parse happening to throw. Nine
 * seconds of an agent's time to paper over a failure that comes back instantly.
 *
 * Retrying here instead costs tens of milliseconds, because this runs next door
 * to Google rather than across the agent's home wifi. It also retries for the
 * right reason: the specific shape of that error page, not any parse failure.
 *
 * It is also the security boundary, and the reason the deployment URL is no
 * longer baked into a page. Rotating a flaky Apps Script deployment becomes a
 * secret update here — instant, no gh-pages deploy, no window where half the
 * agents are on the old URL and half on the new one.
 *
 * ── Secrets (wrangler secret put NAME, or the dashboard) ────────────────────
 *   TRELLUS_TOKEN   the bearer token Trellus sends. You generate it, you give
 *                   it to them, and it is the only thing they ever hold.
 *   SHARED_SECRET   from setupTrellus() in the Apps Script editor.
 *   SCRIPT_URL      the /exec URL of the FreedomCRM web app.
 */

const ALLOWED_ORIGINS = [
  'https://trepin3.github.io',
  'https://app.trellus.ai',
  'chrome-extension://'          // matched by prefix; extension ids vary
];

// How many times to go back to Apps Script, and how long to wait between.
// Short, because the failure is immediate — it is a routing miss, not a timeout,
// so there is nothing to wait for. Four attempts at the observed ~25% failure
// rate leaves roughly one request in 250 getting through to the agent.
const ORIGIN_ATTEMPTS = 4;
const ORIGIN_BACKOFF_MS = [0, 120, 400, 900];

// Google's failure page, which arrives with a 200 and an HTML body. Matching the
// shape explicitly rather than treating every unparseable response as this one:
// a genuine application error should reach the agent, not be retried four times
// and then reported as something else.
function looksLikeGoogleMiss(status, text) {
  if (status >= 500) return true;
  if (!text) return true;
  const head = text.slice(0, 2000);
  if (head.indexOf('"ok"') !== -1 || head.trimStart().startsWith('{')) return false;
  return /Page Not Found|unable to open the file|Sorry, unable|accounts\.google\.com|<html/i.test(head);
}

function corsHeaders(origin) {
  const ok = origin && ALLOWED_ORIGINS.some(a =>
    a.endsWith('://') ? origin.startsWith(a) : origin === a);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

const sleep = ms => (ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/**
 * The CRM gateway. Proxies to Apps Script and retries the routing miss.
 *
 * A POST here is not necessarily safe to repeat — `sold` and `dcid` are not
 * idempotent, and replaying one that actually landed would disposition a lead
 * twice. That is why the two failure kinds are treated differently:
 *
 *   an error PAGE came back  the script did not run; nothing happened; retry
 *   the request itself threw  ambiguous — it may have run and the reply was
 *                             lost — so only a GET is retried
 *
 * The browser's own retry never drew that distinction and replayed everything.
 */
async function handleApi(request, env, origin) {
  const scriptUrl = String(env.SCRIPT_URL || '').trim();
  if (!scriptUrl) {
    return json({ error: 'gateway misconfigured: SCRIPT_URL is not set' }, 500, origin);
  }

  const inUrl = new URL(request.url);
  const target = scriptUrl + (inUrl.search || '');
  const isGet = request.method === 'GET';

  // Read once. The body cannot be streamed twice, and every attempt needs it.
  let body = null;
  if (!isGet) {
    try { body = await request.text(); }
    catch (e) { return json({ error: 'could not read request body' }, 400, origin); }
  }

  let lastDetail = '';
  for (let i = 0; i < ORIGIN_ATTEMPTS; i++) {
    await sleep(ORIGIN_BACKOFF_MS[i] || 0);
    let res, text;
    try {
      res = await fetch(target, isGet ? { method: 'GET', redirect: 'follow' } : {
        method: 'POST',
        // text/plain on purpose: application/json would trigger a preflight on
        // the hop to Apps Script, which is the problem this Worker exists for.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body,
        redirect: 'follow'
      });
      text = await res.text();
    } catch (e) {
      lastDetail = 'fetch failed: ' + String(e);
      if (isGet) continue;                 // safe to repeat
      break;                               // a POST may already have landed
    }

    if (!looksLikeGoogleMiss(res.status, text)) {
      // Straight through, including application errors — those are answers.
      return new Response(text, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Attempts': String(i + 1),
          ...corsHeaders(origin)
        }
      });
    }
    lastDetail = 'origin returned a non-JSON page (HTTP ' + res.status + ')';
  }

  // Shaped like every other response so the client's existing error handling
  // reads it without a special case.
  return json({ error: 'The CRM backend did not respond. Please try again.',
                detail: lastDetail, gateway: true }, 502, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    // The CRM gateway. Kept on its own path so the Trellus relay at the root
    // stays exactly as Trellus already have it configured.
    if (path === '/api') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      if (request.method !== 'GET' && request.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405, origin);
      }
      return handleApi(request, env, origin);
    }

    // The whole reason this Worker exists.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, origin);
    }

    // Their token. Compared in full rather than by prefix, and only after the
    // preflight, so a wrong token still gets a clean CORS response instead of a
    // browser error that tells them nothing.
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    // Trim the stored value too. Copying `openssl rand -hex 32` out of a
    // terminal usually brings a trailing newline with it, and an exact compare
    // then rejects the correct token with no way to see why.
    const expected = String(env.TRELLUS_TOKEN || '').trim();
    if (!expected) {
      return json({ error: 'worker misconfigured: TRELLUS_TOKEN is not set' }, 500, origin);
    }
    if (token !== expected) {
      return json({ error: 'unauthorized', hint: 'token did not match' }, 401, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'body was not json' }, 400, origin);
    }

    // Only ever this action. A relay that forwards whatever action it is handed
    // is an open door into every endpoint the CRM has.
    // Absent means completion, which is all Trellus sent before the start
    // signal existed. Their original integration keeps working with no change
    // on their side.
    const event = String(payload.event || payload.type || 'call.completed')
      .trim().toLowerCase();
    if (event !== 'call.started' && event !== 'call.completed') {
      return json({ error: 'unknown event', got: event,
                    expected: ['call.started', 'call.completed'] }, 400, origin);
    }

    const body = {
      action: 'trellusEvent',
      event:  event,
      secret: String(env.SHARED_SECRET || '').trim(),
      session_id: payload.session_id || payload.sessionId || '',
      lead_id:    payload.lead_id    || payload.leadId    || '',
      rep_email:  payload.rep_email  || payload.repEmail  || '',
      outcome:    payload.outcome    || payload.disposition || '',
      started_at: payload.started_at || payload.startedAt || '',
      ended_at:   payload.ended_at   || payload.endedAt   || '',
      duration:   payload.duration   || ''
    };

    if (!body.session_id) return json({ error: 'session_id required' }, 400, origin);
    if (!body.lead_id)    return json({ error: 'lead_id required' },    400, origin);

    let res;
    try {
      // text/plain on purpose: application/json would trigger a preflight on
      // the hop to Apps Script, which is the problem we came here to avoid.
      res = await fetch(String(env.SCRIPT_URL || '').trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow'
      });
    } catch (e) {
      // 502 rather than 500: retrying is the right thing for them to do.
      return json({ error: 'crm unreachable', detail: String(e) }, 502, origin);
    }

    const text = await res.text();
    let out;
    try { out = JSON.parse(text); }
    catch (e) { return json({ error: 'crm returned non-json', status: res.status }, 502, origin); }

    if (out.error) {
      // not_found and not_permitted are their problem to fix, so 4xx. Anything
      // else is ours, so 5xx and worth a retry.
      const theirs = ['not_found', 'no lead_id', 'no session_id'].includes(out.error);
      return json(out, theirs ? 404 : 500, origin);
    }

    // 200 on a duplicate too. A retried delivery already applied is a success
    // from their side, and telling them otherwise invites an endless retry.
    return json({ ok: true, applied: out.applied, duplicate: !!out.duplicate,
                  ignored: out.ignored }, 200, origin);
  }
};
