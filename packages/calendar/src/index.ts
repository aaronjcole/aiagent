/**
 * @app/calendar — CalendarProvider interface plus mock (default) and Google
 * (stub) adapters, and a config-driven factory. Provides free/busy availability
 * and idempotent event creation per SPEC.md §5.
 */

export * from './types.js';
export { MockCalendarProvider } from './mock.js';
export { GoogleCalendarProvider } from './google.js';
export { createCalendarProvider, type CalendarConfigInput } from './factory.js';
