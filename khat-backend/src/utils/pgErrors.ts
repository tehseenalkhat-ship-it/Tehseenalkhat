// Maps common Postgres error codes to a clean HTTP response instead of leaking
// raw constraint names/SQL to the client. Returns null for anything it doesn't
// recognize, so callers can fall back to a generic 500 + server-side log.
type PgLikeError = { code?: string; constraint?: string; message?: string };

export function mapPgError(err: unknown): { status: number; body: { error: string } } | null {
  const pgErr = err as PgLikeError;
  if (!pgErr?.code) return null;

  switch (pgErr.code) {
    case '23505': // unique_violation
      return { status: 409, body: { error: 'This already exists (unique constraint violated).' } };
    case '23503': // foreign_key_violation
      return { status: 400, body: { error: 'Invalid reference — one of the IDs provided does not exist.' } };
    case '23514': // check_violation
      return { status: 400, body: { error: 'Invalid value — check the allowed options for this field.' } };
    default:
      return null;
  }
}
