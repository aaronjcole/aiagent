/**
 * @app/shared — cross-cutting contracts shared by every package.
 * No dependency on @app/db or any provider package.
 */
export * from './constants.js';
export * from './errors.js';
export * from './ids.js';
export * from './logger.js';
export * from './env.js';
export * from './schemas/index.js';
