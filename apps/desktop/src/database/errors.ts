import { DrizzleQueryError } from 'drizzle-orm';

export function databaseErrorCause(error: unknown): unknown {
    return error instanceof DrizzleQueryError ? (error.cause ?? error) : error;
}
