/**
 * Server-side HTTP proxy helper for Next.js App Router Route Handlers.
 */

const FORWARDED_HEADERS = ['authorization', 'x-authorization', 'content-type', 'accept'] as const;

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '[::]'
  ) {
    return true;
  }
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || /^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host) || /^169\.254\.\d+\.\d+$/.test(host)) {
    return true;
  }
  const rfc172 = /^172\.(\d+)\.\d+\.\d+$/.exec(host);
  if (rfc172 && Number(rfc172[1]) >= 16 && Number(rfc172[1]) <= 31) {
    return true;
  }
  if (host.startsWith('[') && (/^\[(fe80|fc|fd|::ffff:)/i.test(host))) {
    return true;
  }
  return false;
}

export function isAllowedUpstreamUrl(url: URL): boolean {
  if (isPrivateOrLoopbackHost(url.hostname)) return false;

  const extraOriginsRaw =
    typeof process !== 'undefined' ? process.env?.ALLOWED_UPSTREAM_ORIGINS : undefined;
  if (extraOriginsRaw) {
    const allowedSet = new Set(
      extraOriginsRaw
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    );
    if (allowedSet.has(url.origin)) return true;
  }

  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && (host === 'rex-royal.ch' || host.endsWith('.rex-royal.ch'));
}

export function parseUpstreamBaseUrl(rawTargetBase: string | null | undefined): URL | null {
  if (!rawTargetBase || typeof rawTargetBase !== 'string') return null;
  try {
    const parsed = new URL(rawTargetBase.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

export async function forwardUpstreamRequest(
  request: Request,
  pathSegments: readonly string[]
): Promise<Response> {
  const targetBase = request.headers.get('x-target-origin') || request.headers.get('x-target-base-url');
  const upstreamBase = parseUpstreamBaseUrl(targetBase);
  if (!upstreamBase) {
    return Response.json(
      { error: 'Missing or invalid X-Target-Origin header. Expected http:// or https:// base URL.' },
      { status: 400 }
    );
  }
  if (!isAllowedUpstreamUrl(upstreamBase)) {
    return Response.json(
      { error: 'Upstream origin is not in the allowed host list.' },
      { status: 403 }
    );
  }

  const incomingUrl = new URL(request.url);
  const joinedPath = Array.isArray(pathSegments) ? pathSegments.join('/') : '';
  const targetUrl = new URL(
    `${upstreamBase.pathname.replace(/\/+$/, '')}/${joinedPath}${incomingUrl.search}`,
    upstreamBase.origin
  );

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const val = request.headers.get(name);
    if (val) headers.set(name, val);
  }

  const method = request.method.toUpperCase();
  const bodyBuf = method !== 'GET' && method !== 'HEAD' ? await request.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers,
      body: bodyBuf && bodyBuf.byteLength > 0 ? bodyBuf : undefined,
    });
    const resHeaders = new Headers();
    const ct = upstream.headers.get('content-type');
    if (ct) resHeaders.set('content-type', ct);
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: resHeaders });
  } catch (err) {
    return Response.json(
      {
        error: 'Upstream connection failed',
        targetUrl: targetUrl.toString(),
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}

export interface ProxyRouteContext {
  params: Promise<{ path?: string[] }>;
}

async function handleProxyRoute(request: Request, context: ProxyRouteContext): Promise<Response> {
  const { path = [] } = await context.params;
  return forwardUpstreamRequest(request, path);
}

export {
  handleProxyRoute as GET,
  handleProxyRoute as POST,
  handleProxyRoute as PUT,
  handleProxyRoute as DELETE,
};
