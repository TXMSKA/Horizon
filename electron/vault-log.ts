type Scalar = string | number | boolean | null;
const secretName = /password|username|token|authorization|cookie|secret|master|recovery|content|body/i;
const tokenValue = /(?:Bearer\s+\S+|[A-Za-z0-9_-]{40,}|[a-f0-9]{64,})/i;
export function vaultLogFields(fields: Record<string, Scalar>): Record<string, Scalar> {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, secretName.test(name) || typeof value === 'string' && tokenValue.test(value) ? '[redacted]' : value]));
}
export function vaultAudit(event: 'unlock' | 'hello' | 'lock' | 'fill' | 'copy' | 'add' | 'import' | 'permission', outcome: 'allowed' | 'denied'): void {
  // Only fixed identifiers reach this sink. Entry data and service errors do not.
  console.info(JSON.stringify(vaultLogFields({ time: new Date().toISOString(), actor: 'horizon', event, outcome })));
}
