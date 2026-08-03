/* ============================================================
   FAT POSSUM — Gist/Packiyo proxy Worker
   Holds the GitHub Gist PAT and Packiyo API token server-side so
   the browser app never receives them. Exposed operations:
     - GET/PATCH /gist/:id     -> https://api.github.com/gists/:id
                                  (rejects any :id other than the one
                                  known gist — not a general GitHub proxy)
     - GET/POST/PATCH /packiyo/* -> https://fatpossum.app.packiyo.com/api/v1/*
     - POST /error-log          -> appends a client-side error report to
                                    fp_error_log.json in the same gist

   ── AUTH ──
   /gist/* and /packiyo/* require a Google ID token (the same one the app
   gets from Sign In With Google) in `Authorization: Bearer <token>`. The
   Worker verifies it with Google, then checks the email against the same
   ADMIN_EMAIL / fp_users.json list the client already gates on — so this
   is enforcement of an existing rule, not a new one.

   AUTH_MODE controls whether a failed check actually blocks the request:
     'shadow'  — logs what the outcome would have been, but always lets
                 the request through. Use this to verify real traffic
                 passes cleanly before switching to enforce.
     'enforce' — actually rejects requests that fail the check (401/403).
   Flip AUTH_MODE below once shadow-mode logs look clean, then redeploy.

   Writes to fp_users.json (the user/role list) additionally require the
   admin role even in shadow mode's "would this pass" logging, since
   that file controls who can grant themselves access.
   ============================================================ */

const ALLOWED_ORIGIN   = 'https://fatpossumrecords.github.io';
const GIST_ID           = 'e79a142da6ddbc0a77560802db1ce780';
const PACKIYO_BASE      = 'https://fatpossum.app.packiyo.com/api/v1';
const ERROR_LOG_FILE    = 'fp_error_log.json';
const ERROR_LOG_MAX     = 200;

const GOOGLE_CLIENT_ID  = '955463970238-o8p7ujrhusedtkavkskjhjlh87gr1844.apps.googleusercontent.com';
const ADMIN_EMAIL       = 'patrick@fatpossum.com';
const USERS_GIST_FILE   = 'fp_users.json';
const AUTH_LOG_FILE     = 'fp_auth_shadow_log.json';
const AUTH_LOG_MAX      = 200;
const AUTH_MODE         = 'shadow'; // 'shadow' | 'enforce'

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/gist/')) {
      return handleGist(request, url, env);
    }

    if (url.pathname.startsWith('/packiyo/')) {
      return handlePackiyo(request, url, env);
    }

    if (url.pathname === '/error-log') {
      return handleErrorLog(request, env);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};

// ── SHARED GIST HELPERS ─────────────────────────────────────────
// Server-side equivalent of the client's fetchGistFile()/save pattern —
// same truncation-fallback handling (see app.js's fetchGistFile comment).
async function readGistFile(fileName, env) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Authorization: `token ${env.GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fp-gist-proxy',
    },
  });
  if (!res.ok) throw new Error('gist fetch failed: HTTP ' + res.status);
  const gist = await res.json();
  const file = gist.files && gist.files[fileName];
  if (!file) return null;
  if (file.truncated || !file.content) {
    const rawRes = await fetch(file.raw_url);
    if (!rawRes.ok) throw new Error('gist raw fetch failed: HTTP ' + rawRes.status);
    return await rawRes.text();
  }
  return file.content;
}

async function writeGistFile(fileName, content, env) {
  await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${env.GIST_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fp-gist-proxy',
    },
    body: JSON.stringify({ files: { [fileName]: { content } } }),
  });
}

async function appendToGistLog(fileName, entry, maxEntries, env) {
  let log = [];
  try {
    const content = await readGistFile(fileName, env);
    if (content) log = JSON.parse(content) || [];
  } catch (e) { log = []; }
  log.unshift(entry);
  if (log.length > maxEntries) log = log.slice(0, maxEntries);
  await writeGistFile(fileName, JSON.stringify(log), env);
}

// ── AUTH ─────────────────────────────────────────────────────
async function verifyIdToken(idToken) {
  if (!idToken) return { ok: false, reason: 'missing token' };
  let info;
  try {
    const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!res.ok) return { ok: false, reason: 'token rejected by Google (HTTP ' + res.status + ')' };
    info = await res.json();
  } catch (e) {
    return { ok: false, reason: 'tokeninfo request failed: ' + e.message };
  }
  if (info.aud !== GOOGLE_CLIENT_ID) return { ok: false, reason: 'token audience mismatch' };
  if (info.email_verified !== 'true' && info.email_verified !== true) return { ok: false, reason: 'email not verified' };
  if (!info.email) return { ok: false, reason: 'no email in token' };
  return { ok: true, email: String(info.email).toLowerCase() };
}

async function authorizeEmail(email, env) {
  if (email === ADMIN_EMAIL.toLowerCase()) return { ok: true, role: 'admin' };
  try {
    const content = await readGistFile(USERS_GIST_FILE, env);
    const data = content ? JSON.parse(content) : { users: [] };
    const found = (data.users || []).find(u => (u.email || '').toLowerCase() === email);
    if (!found) return { ok: false, reason: 'not in authorized user list' };
    return { ok: true, role: found.role || 'full' };
  } catch (e) {
    return { ok: false, reason: 'could not load user list: ' + e.message };
  }
}

// Verifies the request's Authorization header. Always returns a result —
// callers decide what to do with it based on AUTH_MODE.
async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const verify = await verifyIdToken(idToken);
  if (!verify.ok) return verify;
  const authz = await authorizeEmail(verify.email, env);
  if (!authz.ok) return { ok: false, reason: authz.reason, email: verify.email };
  return { ok: true, email: verify.email, role: authz.role };
}

async function logAuthCheck(route, method, result, env) {
  try {
    await appendToGistLog(AUTH_LOG_FILE, {
      ts: new Date().toISOString(),
      route, method,
      ok: result.ok,
      email: result.email || '',
      role: result.role || '',
      reason: result.reason || '',
      mode: AUTH_MODE,
    }, AUTH_LOG_MAX, env);
  } catch (e) { /* never let logging itself break the request */ }
}

// Runs the auth check for a gist/packiyo request. Returns null to let the
// request proceed, or a Response to short-circuit it (enforce mode only).
async function checkAuth(request, url, env, { writingUsersFile } = {}) {
  const result = await authenticate(request, env);

  // Only log failures (the interesting case), in both shadow and enforce
  // mode. Logging every routine pass costs 2 extra GitHub API calls (read
  // + write the log file) per request — for Packiyo calls in particular
  // that's pure added GitHub-quota overhead they never had before, and at
  // this app's request volume it's enough to burn through the PAT's hourly
  // rate limit and start failing real Gist saves. Shadow mode only needs
  // to answer "what would fail" — it doesn't need a pass tally badly
  // enough to risk that.
  if (!result.ok) {
    await logAuthCheck(url.pathname, request.method, result, env);
  }

  if (writingUsersFile && result.ok && result.role !== 'admin') {
    const blocked = { ok: false, reason: 'non-admin write to ' + USERS_GIST_FILE, email: result.email };
    await logAuthCheck(url.pathname, request.method, blocked, env);
    if (AUTH_MODE === 'enforce') {
      return new Response('Forbidden — admin only', { status: 403, headers: corsHeaders() });
    }
    return null;
  }

  if (AUTH_MODE === 'enforce' && !result.ok) {
    return new Response('Unauthorized: ' + result.reason, { status: 401, headers: corsHeaders() });
  }
  return null;
}

async function handleGist(request, url, env) {
  const id = url.pathname.split('/')[2];
  if (id !== GIST_ID) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'PATCH') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  let writingUsersFile = false;
  let bodyText;
  if (request.method === 'PATCH') {
    bodyText = await request.text();
    try {
      const parsed = JSON.parse(bodyText);
      writingUsersFile = !!(parsed.files && parsed.files[USERS_GIST_FILE]);
    } catch (e) { /* malformed body — let GitHub's API reject it below */ }
  }

  const blocked = await checkAuth(request, url, env, { writingUsersFile });
  if (blocked) return blocked;

  const upstream = await fetch(`https://api.github.com/gists/${id}`, {
    method: request.method,
    headers: {
      Authorization: `token ${env.GIST_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fp-gist-proxy',
    },
    body: request.method === 'PATCH' ? bodyText : undefined,
  });

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

async function handlePackiyo(request, url, env) {
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  const blocked = await checkAuth(request, url, env, {});
  if (blocked) return blocked;

  const path = url.pathname.replace(/^\/packiyo/, '');
  const upstream = await fetch(PACKIYO_BASE + path + url.search, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${env.PACKIYO_TOKEN}`,
      Accept: request.headers.get('Accept') || '*/*',
      'Content-Type': request.headers.get('Content-Type') || 'application/vnd.api+json',
    },
    body: request.method === 'GET' ? undefined : await request.text(),
  });

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...corsHeaders(),
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    },
  });
}

async function handleErrorLog(request, env) {
  // Deliberately not auth-gated — error reporting (including auth-related
  // errors, or errors before a user is signed in) should never be blocked.
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  let entry;
  try {
    entry = await request.json();
  } catch (e) {
    return new Response('Bad request', { status: 400, headers: corsHeaders() });
  }

  // Only keep known fields, each capped, so a malformed or huge payload can't
  // blow up the log or the gist's storage budget.
  const clean = {
    ts:        new Date().toISOString(),
    message:   String(entry.message || '').slice(0, 500),
    stack:     String(entry.stack || '').slice(0, 2000),
    url:       String(entry.url || '').slice(0, 300),
    view:      String(entry.view || '').slice(0, 100),
    user:      String(entry.user || '').slice(0, 200),
    userAgent: String(entry.userAgent || '').slice(0, 300),
  };

  try {
    await appendToGistLog(ERROR_LOG_FILE, clean, ERROR_LOG_MAX, env);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}
