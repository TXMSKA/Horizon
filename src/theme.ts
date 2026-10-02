import type { Contrast, Theme } from './shared/api';

let theme: Theme = window.horizon.initialTheme;
let contrast: Contrast = window.horizon.initialContrast;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(value: Theme, pair: Contrast): void {
  theme = value;
  contrast = pair;
  document.documentElement.dataset.theme = theme === 'system' ? systemTheme.matches ? 'amber' : 'daylight' : theme;
  document.documentElement.dataset.contrast = contrast;
}
systemTheme.addEventListener('change', () => { if (theme === 'system') applyTheme(theme, contrast); });
