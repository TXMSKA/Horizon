import './tokens.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { text } from './copy';
import { applyTheme } from './theme';

applyTheme(window.horizon.initialTheme, window.horizon.initialContrast);

// Removing the old key before sending prevents StrictMode or a reload from migrating it twice.
try {
  const saved = localStorage.getItem('horizon-theme');
  localStorage.removeItem('horizon-theme');
  if (window.horizon.themeMigration && (saved === 'amber' || saved === 'daylight')) void window.horizon.command({ type: 'migrate-theme', value: saved }).catch(() => {});
} catch { /* Storage may be unavailable; the main process remains the source of the theme. */ }

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing application root');
  const renderer = createRoot(root);
  try {
    const [language, state] = await Promise.all([window.horizon.getLanguage(), window.horizon.getState()]);
    applyTheme(state.theme, state.contrast);
    document.documentElement.lang = language;
    document.title = text('product', language);
    renderer.render(<StrictMode><App language={language} /></StrictMode>);
  } catch {
    const language = navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
    document.documentElement.lang = language;
    renderer.render(<main className="startup-error" role="alert">{text('startupError', language)}</main>);
  }
}

void start();
