import { PrismaClient } from '@prisma/client';

/**
 * Singleton PrismaClient. In dev with hot-reload (tsx watch / Next), modules can
 * be re-evaluated repeatedly; without this guard each reload would open a new
 * connection pool and exhaust the database. We stash the instance on globalThis.
 */
const globalForPrisma = globalThis as unknown as {
  __aiagentPrisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__aiagentPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__aiagentPrisma = prisma;
}
