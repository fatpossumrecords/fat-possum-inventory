/* ============================================================
   FAT POSSUM — Gist/Packiyo proxy Worker
   Holds the GitHub Gist PAT and Packiyo API token server-side so
   the browser app never receives them. Only two narrow operations
   are exposed:
     - GET/PATCH /gist/:id     -> https://api.github.com/gists/:id
                                  (rejects any :id other than the one
                                  known gist — not a general GitHub proxy)
     - GET/POST/PATCH /packiyo/* -> https://fatpossum.app.packiyo.com/api/v1/*
   ============================================================ */

const ALLOWED_ORIGIN = 'https://fatpossumrecords.github.io';
const GIST_ID         = 'e79a142da6ddbc0a77560802db1ce780';
const PACKIYO_BASE    = 'https://fatpossum.app.packiyo.com/api/v1';

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
