import './tokens.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { text } from './copy';

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing application root');
  const renderer = createRoot(root);
  try {
    const language = await window.horizon.getLanguage();
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
