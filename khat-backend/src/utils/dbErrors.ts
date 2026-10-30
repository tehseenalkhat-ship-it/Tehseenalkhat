// Convert common MySQL constraint failures into safe HTTP responses rather than
// exposing constraint names or SQL details to API clients.
type DatabaseError = { code?: string; errno?: number };

export function mapDatabaseError(err: unknown): { status: number; body: { error: string } } | null {
  const databaseError = err as DatabaseError;
  const code = databaseError?.code;
  const errno = databaseError?.errno;

  if (code === 'ER_DUP_ENTRY' || errno === 1062) {
    return { status: 409, body: { error: 'This already exists (unique constraint violated).' } };
  }
  if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2' || errno === 1451 || errno === 1452) {
    return { status: 400, body: { error: 'Invalid reference — one of the IDs provided does not exist.' } };
  }
  if (code === 'ER_CHECK_CONSTRAINT_VIOLATED' || errno === 3819) {
    return { status: 400, body: { error: 'Invalid value — check the allowed options for this field.' } };
  }
  if (code === 'ER_BAD_NULL_ERROR' || errno === 1048) {
    return { status: 400, body: { error: 'A required field is missing.' } };
  }
  return null;
}
