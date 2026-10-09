export class VaultClientError extends Error {
  code: string;
  constructor(code: string, options?: ErrorOptions) { super(code, options); this.code = code; this.name = "VaultClientError"; }
}
