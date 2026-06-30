'use client';

/**
 * Client-side fetch helpers that route through the same-origin proxy
 * (`/api/proxy/...`) to the upstream API. Used by client components for
 * mutating actions.
 */

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/proxy${path.startsWith('/') ? path : `/${path}`}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      detail = parsed.error ?? parsed.message ?? text;
    } catch {
      /* keep raw text */
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

export const client = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};
