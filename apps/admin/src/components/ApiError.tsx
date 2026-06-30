import { API_BASE_URL } from '../lib/api';

/** Friendly, non-crashing message shown when an API read fails. */
export function ApiUnreachable({ error }: { error: string }) {
  return (
    <div className="error">
      <strong>Could not load data from the API.</strong>
      <div className="msg">{error}</div>
      <div className="muted msg">
        Expected API base URL: <code>{API_BASE_URL}</code>. Start the API with{' '}
        <code>pnpm --filter @app/api dev</code>, or set{' '}
        <code>NEXT_PUBLIC_API_BASE_URL</code>.
      </div>
    </div>
  );
}

/**
 * Small inline warning for a non-fatal side-query failure: the main data loaded
 * but a secondary query (e.g. `/sequences`, `/research`) failed. Surfaces the
 * problem without making it look like "no data".
 */
export function ApiSideWarning({ label, error }: { label: string; error: string }) {
  return (
    <div className="msg err" role="alert" style={{ marginBottom: 12 }}>
      <strong>Could not load {label}.</strong> {error}
    </div>
  );
}
