import type { HorizonAPI } from './shared/api';

declare global {
  interface Window {
    horizon: HorizonAPI;
  }
}
