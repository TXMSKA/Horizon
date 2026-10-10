// The shared Cosmic services Horizon can offer to install (task 031, shared-services contract sections 2 to 7).
export const SERVICE_IDS = ['vault', 'lyra'] as const;
export type ServiceId = typeof SERVICE_IDS[number];
// The two answers of a service's client that mean the service is missing or did not start (contract section 2).
export type ServiceReason = 'not_installed' | 'did_not_start';
export type ServiceStatus = 'unknown' | 'installed' | 'not_installed' | 'did_not_start';
// What the latest release of the service says: its installer is listed, there is no release or no installer, or the question could not be answered.
export type ServiceRelease = 'available' | 'missing' | 'unknown';
export type ServicePhase = 'offer' | 'downloading' | 'installing' | 'finish' | 'failed' | 'not-started';
export type ServiceFailure = 'checksum' | 'download' | 'install' | 'busy';
export interface ServiceDialog {
  service: ServiceId; phase: ServicePhase; release: ServiceRelease;
  // The installer's size in MB, rounded, when the release names it.
  sizeMb: number | null;
  // Off Windows there is no in-place install: Install opens the download page.
  manual: boolean;
  received: number; total: number | null; failure: ServiceFailure | null; busy: boolean;
}
export interface ServicesState { dialog: ServiceDialog | null; entries: Record<ServiceId, ServiceStatus> }
export const SERVICE_INFO: Record<ServiceId, { repo: string; asset: string; about: string; download: string }> = {
  vault: { repo: 'TXMSKA/Vault', asset: 'Vault-Setup-x64.exe', about: 'https://txmska.com/projects/vault/', download: 'https://txmska.com/projects/vault/' },
  lyra: { repo: 'TXMSKA/lyra-releases', asset: 'Lyra-Setup-x64.exe', about: 'https://txmska.com/projects/lyra/', download: 'https://txmska.com/projects/lyra/' },
};
export const emptyServicesState = (): ServicesState => ({ dialog: null, entries: { vault: 'unknown', lyra: 'unknown' } });

export type ServicesCommand =
  | { type: 'service-retry' | 'service-reinstall' | 'service-not-now' | 'service-cancel' | 'service-close' | 'service-check' }
  | { type: 'service-offer' | 'service-install'; service: ServiceId }
  | { type: 'service-page'; service: ServiceId; page: 'about' | 'download' };

export function isServiceId(value: unknown): value is ServiceId {
  return typeof value === 'string' && (SERVICE_IDS as readonly string[]).includes(value);
}
export function validateServicesCommand(value: unknown): ServicesCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SERVICES_INVALID');
  const command = value as Record<string, unknown>;
  const exact = (keys: string[]) => Object.hasOwn(command, 'type') && Object.keys(command).length === keys.length + 1 && keys.every(key => Object.hasOwn(command, key));
  if (['service-retry', 'service-reinstall', 'service-not-now', 'service-cancel', 'service-close', 'service-check'].includes(String(command.type)) && exact([])) return value as ServicesCommand;
  if ((command.type === 'service-offer' || command.type === 'service-install') && exact(['service']) && isServiceId(command.service)) return value as ServicesCommand;
  if (command.type === 'service-page' && exact(['service', 'page']) && isServiceId(command.service) && (command.page === 'about' || command.page === 'download')) return value as ServicesCommand;
  throw new Error('SERVICES_INVALID');
}

// A client's connect failure as the reason Horizon acts on; any other failure says nothing about the install.
export function serviceReason(error: unknown): ServiceReason | null {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'not_installed') return 'not_installed';
  return code === 'invalid_install' || code === 'unavailable' ? 'did_not_start' : null;
}
