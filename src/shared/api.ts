export type Language = 'en' | 'es';
export type WindowAction = 'minimize' | 'maximize' | 'close';

export interface HorizonAPI {
  getLanguage(): Promise<Language>;
  windowAction(action: WindowAction): Promise<void>;
}

export const IPC = {
  language: 'horizon:language',
  windowAction: 'horizon:window-action',
} as const;
