/**
 * Trellus → FreedomCRM relay.  Cloudflare Worker, free tier.
 *
 * Why this exists: Trellus posts from a browser extension with an
 * Authorization header. A custom header makes the browser send a CORS
 * preflight OPTIONS request first, and Apps Script has no doOptions — the
 * request fails before any of our code runs. This Worker answers the preflight,
 * checks their bearer token, and forwards the body to Apps Script as text/plain,
 * which needs no preflight at all.
 *
 * It is also the security boundary. The Apps Script receiver trusts whoever
 * calls it, so its URL must never leave this file. Trellus gets the Worker URL
 * and TRELLUS_TOKEN; the Worker holds SHARED_SECRET and the script URL.
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

function corsHeaders(origin) {
  const ok = origin && ALLOWED_ORIGINS.some(a =>
    a.endsWith('://') ? origin.startsWith(a) : origin === a);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

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
    const body = {
      action: 'trellusEvent',
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
    return json({ ok: true, applied: out.applied, duplicate: !!out.duplicate }, 200, origin);
  }
};
