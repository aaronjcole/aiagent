/**
 * Tiny fetch helper for talking to the `@app/api` Fastify server.
 *
 * Base URL comes from `NEXT_PUBLIC_API_BASE_URL` (default
 * `http://localhost:3001`). All reads use `cache: 'no-store'` so server
 * components always hit the live API at request time (paired with
 * `export const dynamic = 'force-dynamic'` on data pages, the build never
 * fetches). The API is the single writer of `AuditLog` rows: every mutating
 * action below maps to an API call that records an audit entry server-side.
 */

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';

/** Error thrown for a failed API request, carrying the HTTP status and raw body. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Options for a single low-level API request. */
interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Query string params; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
}

/** Build an absolute API URL from a path and optional query params. */
function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Perform an API request, parsing JSON and throwing {@link ApiError} on failure. */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query } = options;
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError(`Could not reach API at ${API_BASE_URL}: ${message}`, 0, '');
  }

  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(`API ${method} ${path} failed (${res.status})`, res.status, text);
  }
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(`API ${method} ${path} returned non-JSON`, res.status, text);
  }
}

/**
 * Read helper for server components: returns the parsed body on success or a
 * structured failure (never throws) so pages can render a friendly message
 * when the API is unreachable.
 */
export type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Fetch and parse an API endpoint, never throwing: returns `{ ok: true, data }`
 * on success or `{ ok: false, error }` on failure so server components can render
 * a friendly message.
 * @param path API path to read.
 * @param query Optional query parameters.
 */
export async function read<T>(path: string, query?: RequestOptions['query']): Promise<ReadResult<T>> {
  try {
    const data = await request<T>(path, { query });
    return { ok: true, data };
  } catch (err) {
    // Network failures (status 0) keep their message so the UI can hint that
    // the API is unreachable. For all other failures we log the detailed
    // upstream body server-side and return a generic message — raw upstream
    // bodies must not be surfaced to the client.
    if (err instanceof ApiError) {
      if (err.status === 0) {
        return { ok: false, error: err.message };
      }
      console.error(`[api] ${err.message}${err.body ? `: ${err.body.slice(0, 1000)}` : ''}`);
      return { ok: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[api] read(${path}) failed: ${message}`);
    return { ok: false, error: 'Could not load data from the API.' };
  }
}

/** Mutating helper for client components / route handlers — throws on failure. */
export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
