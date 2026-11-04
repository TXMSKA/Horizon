import type { HorizonAPI, VaultOverlayAPI } from './shared/api';

declare global {
  interface Window {
    horizon: HorizonAPI;
    // Present only in the view that draws the sign-in suggestion.
    horizonVault?: VaultOverlayAPI;
  }
}
