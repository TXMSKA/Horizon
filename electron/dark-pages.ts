import type { CommandLine } from 'electron';
import type { DarkPagesMode, DarkStrength, DarkTone } from '../src/shared/api';

export const DARK_FILTERS = {
  strength: { soft: 'brightness(1.15) contrast(0.9)', standard: '', deep: 'brightness(0.85) contrast(1.05)' },
  tone: { neutral: '', warm: 'sepia(0.12)' },
} as const;

// Chromium darkens image backgrounds without adapting raster ink, leaving MediaWiki diagrams unreadable.
// Keep content images on a light plate and invert the images MediaWiki marks as safe for dark pages.
export const MEDIAWIKI_DARK_CSS = `.skin-invert, .mw-invert { color-scheme: only light !important; filter: invert(1) hue-rotate(180deg) !important; }
img.mw-file-element { color-scheme: only light !important; }`;

export function darkPagesActive(mode: DarkPagesMode, systemDark: boolean): boolean { return mode === 'on' || mode === 'system' && systemDark; }
export function setDarkPagesSwitch(commandLine: CommandLine, active: boolean): void {
  if (active) commandLine.appendSwitch('blink-settings', 'forceDarkModeEnabled=true');
  else commandLine.removeSwitch('blink-settings');
}
export function darkPagesCSS(active: boolean, enabled: boolean, strength: DarkStrength, tone: DarkTone): string {
  if (!active) return '';
  if (!enabled) return ':root { color-scheme: only light !important; }';
  const filter = [DARK_FILTERS.strength[strength], DARK_FILTERS.tone[tone]].filter(Boolean).join(' ');
  return filter ? `:root { filter: ${filter} !important; }\n${MEDIAWIKI_DARK_CSS}` : MEDIAWIKI_DARK_CSS;
}
