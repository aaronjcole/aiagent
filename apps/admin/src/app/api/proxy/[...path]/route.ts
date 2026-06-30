/**
 * Generic same-origin proxy to the `@app/api` Fastify server.
 *
 * Client components call `/api/proxy/<path>` so the upstream base URL stays
 * server-side and CORS is avoided. Mutating actions (approve/reject, suppress,
 * trigger research, simulate inbound, toggle setting, start outbound) go
 * through here; the upstream API is what writes the `AuditLog` row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { API_BASE_URL } from '../../../../lib/api';

/** Force dynamic handling so every proxied request hits the live upstream API. */
export const dynamic = 'force-dynamic';

/** Forward a request to the upstream API and relay its status/body (with timeout). */
async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  const search = req.nextUrl.search;
  const target = `${API_BASE_URL}/${path.join('/')}${search}`;

  const method = req.method;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  let body: string | undefined;
  if (hasBody) {
    body = await req.text();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(target, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body || undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Log the concrete upstream target server-side; never leak it to the client.
    if (cause instanceof Error && cause.name === 'AbortError') {
      console.error(`[proxy] upstream request to ${target} timed out after 15s`);
      return NextResponse.json({ error: 'Upstream API timed out.' }, { status: 504 });
    }
    console.error(`[proxy] could not reach upstream API at ${target}: ${message}`);
    return NextResponse.json({ error: 'Could not reach the API.' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

/** Route context carrying the catch-all `path` segments. */
interface Ctx {
  params: { path: string[] };
}

/** Proxy a GET request to the upstream API. */
export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  return forward(req, params.path);
}
/** Proxy a POST request to the upstream API. */
export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  return forward(req, params.path);
}
/** Proxy a PUT request to the upstream API. */
export async function PUT(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  return forward(req, params.path);
}
/** Proxy a DELETE request to the upstream API. */
export async function DELETE(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  return forward(req, params.path);
}
