import { PrismaClient } from "@/generated/prisma";

// Reuse a single PrismaClient across hot reloads in dev and across the
// worker process, instead of opening a new connection pool per import.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
