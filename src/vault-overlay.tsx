import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VaultSuggestionCard } from './Vault';
import { applyTheme } from './theme';
import type { VaultOverlayState } from './shared/api';

// The view of the sign-in suggestion: transparent around the card, so only the card covers the page.
const api = window.horizonVault!;
applyTheme(api.initialTheme, api.initialContrast);
document.documentElement.dataset.vaultOverlay = '';

function Card({ view }: { view: VaultOverlayState & { suggestion: NonNullable<VaultOverlayState['suggestion']> } }) {
  const { id } = view.suggestion;
  const onSize = useCallback((width: number, height: number) => { void api.resize(id, width, height).catch(() => undefined); }, [id]);
  return <VaultSuggestionCard key={id} suggestion={view.suggestion} windows={view.windows} language={view.language} command={api.command} onSize={onSize} />;
}

function Overlay() {
  const [view, setView] = useState<VaultOverlayState | null>(null);
  useEffect(() => {
    let live = true;
    void api.getState().then(next => { if (live) setView(next); }, () => undefined);
    const stop = api.onState(next => setView(next));
    // Arrow down in the page moves the keyboard here.
    const focus = api.onFocus(() => { document.querySelector<HTMLButtonElement>('.vault-account:not(:disabled)')?.focus(); });
    return () => { live = false; stop(); focus(); };
  }, []);
  useEffect(() => {
    if (!view) return;
    applyTheme(view.theme, view.contrast); document.documentElement.lang = view.language;
  }, [view]);
  return view?.suggestion ? <Card view={{ ...view, suggestion: view.suggestion }} /> : null;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><Overlay /></StrictMode>);
