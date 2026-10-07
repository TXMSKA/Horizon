import type { Contrast, Theme } from './shared/api';

let theme: Theme = window.horizon.initialTheme;
let contrast: Contrast = window.horizon.initialContrast;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const systemContrast = matchMedia('(forced-colors: active)');
export function applyTheme(value: Theme, pair: Contrast): void {
  theme = value;
  contrast = pair;
  document.documentElement.dataset.theme = theme === 'system' ? systemTheme.matches ? 'amber' : 'daylight' : theme;
  // System accessibility keeps priority without overwriting the saved choice.
  document.documentElement.dataset.contrast = systemContrast.matches ? 'high' : contrast;
}
systemTheme.addEventListener('change', () => { if (theme === 'system') applyTheme(theme, contrast); });
systemContrast.addEventListener('change', () => applyTheme(theme, contrast));
