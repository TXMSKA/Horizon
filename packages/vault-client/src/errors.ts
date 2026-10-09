export class VaultClientError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "VaultClientError"; }
}
