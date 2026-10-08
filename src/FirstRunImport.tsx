import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { BrowserState, ImportSource, Language } from './shared/api';
import { ImportDialog } from './Import';
import { settingsError } from './Settings';

// The first run offers the import once, only when another browser is there to read.
export function FirstRunImport({ state, language, returnFocus, onOpen }: { state: BrowserState; language: Language; returnFocus: RefObject<HTMLElement | null>; onOpen: (open: boolean) => void }) {
  const [sources, setSources] = useState<ImportSource[] | null>(null), [dismissed, setDismissed] = useState(false);
  const finish = useCallback(() => { setDismissed(true); void window.horizon.command({ type: 'finish-first-run' }).catch(() => {}); }, []);
  useEffect(() => {
    let current = true;
    window.horizon.command({ type: 'list-import-sources' }).then(found => { if (current) { if (found.length) setSources(found); else finish(); } }, () => { if (current) setDismissed(true); });
    return () => { current = false; };
  }, [finish]);
  const open = sources !== null && !dismissed;
  useEffect(() => { onOpen(open); return () => onOpen(false); }, [open, onOpen]);
  if (!open) return null;
  return <ImportDialog sources={sources} language={language} profileName={state.profiles.find(profile => profile.id === state.activeProfileId)?.name ?? ''} firstRun vault={state.vault} progress={state.importProgress} opener={returnFocus} describe={reason => settingsError(reason, language)} onClose={finish} />;
}
