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
   ============================================================ */

const ALLOWED_ORIGIN = 'https://fatpossumrecords.github.io';
const GIST_ID         = 'e79a142da6ddbc0a77560802db1ce780';
const PACKIYO_BASE    = 'https://fatpossum.app.packiyo.com/api/v1';
const ERROR_LOG_FILE  = 'fp_error_log.json';
const ERROR_LOG_MAX   = 200;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

async function handleGist(request, url, env) {
  const id = url.pathname.split('/')[2];
  if (id !== GIST_ID) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'PATCH') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  const upstream = await fetch(`https://api.github.com/gists/${id}`, {
    method: request.method,
    headers: {
      Authorization: `token ${env.GIST_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fp-gist-proxy',
    },
    body: request.method === 'PATCH' ? await request.text() : undefined,
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
    const getRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `token ${env.GIST_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fp-gist-proxy',
      },
    });
    const gist = await getRes.json();
    let log = [];
    const file = gist.files && gist.files[ERROR_LOG_FILE];
    if (file) {
      const content = (file.truncated || !file.content)
        ? await (await fetch(file.raw_url)).text()
        : file.content;
      try { log = JSON.parse(content) || []; } catch (e) { log = []; }
    }
    log.unshift(clean);
    if (log.length > ERROR_LOG_MAX) log = log.slice(0, ERROR_LOG_MAX);

    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${env.GIST_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fp-gist-proxy',
      },
      body: JSON.stringify({ files: { [ERROR_LOG_FILE]: { content: JSON.stringify(log) } } }),
    });

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
