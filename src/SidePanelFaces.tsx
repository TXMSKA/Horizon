import { text } from './copy';
import type { Language } from './shared/api';

export function SidePanelFaces({ face, language, onDesktop, onLyra }: { face: 'desktop' | 'lyra'; language: Language; onDesktop: () => void; onLyra: () => void }) {
  return <div className="settings-segmented panel-faces" role="radiogroup" aria-label={text('desktop', language)} onKeyDown={event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); if (event.key === 'Home' || event.key !== 'End' && face === 'lyra') onDesktop(); else onLyra();
    }
  }}>{(['desktop', 'lyra'] as const).map(value => <button key={value} type="button" role="radio" tabIndex={face === value ? 0 : -1} aria-checked={face === value} onClick={value === 'desktop' ? onDesktop : onLyra}>{text(value, language)}</button>)}</div>;
}
