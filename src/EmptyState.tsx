import { Download, History, SearchX, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { Language } from './shared/api';

function EmptyState({ language, icon: Icon, title, reason, action, onAction }: {
  language: Language; icon: LucideIcon; title: CopyKey; reason: CopyKey; action: CopyKey; onAction: () => void;
}) {
  return <li className="empty-state"><Icon aria-hidden="true" /><div><h2>{text(title, language)}</h2><p>{text(reason, language)}</p><button className="text-button" type="button" onClick={onAction}>{text(action, language)}</button></div></li>;
}

export function EmptyHistory({ language, privateWindow = false, onAction }: { language: Language; privateWindow?: boolean; onAction: () => void }) {
  return <EmptyState language={language} icon={History} title={privateWindow ? 'privateHistoryTitle' : 'emptyHistoryTitle'} reason={privateWindow ? 'privateHistory' : 'emptyHistory'} action="browseWeb" onAction={onAction} />;
}
export function EmptyBookmarks({ language, onAction }: { language: Language; onAction: () => void }) {
  return <EmptyState language={language} icon={Star} title="emptyBookmarksTitle" reason="emptyBookmarks" action="browseWeb" onAction={onAction} />;
}
export function EmptyDownloads({ language, privateWindow = false, onAction }: { language: Language; privateWindow?: boolean; onAction: () => void }) {
  return <EmptyState language={language} icon={Download} title={privateWindow ? 'privateDownloadsTitle' : 'emptyDownloadsTitle'} reason={privateWindow ? 'privateDownloads' : 'emptyDownloads'} action="openDownloadsFolder" onAction={onAction} />;
}
export function NoResults({ language, onAction }: { language: Language; onAction: () => void }) {
  return <EmptyState language={language} icon={SearchX} title="noResultsTitle" reason="noResults" action="clearFilter" onAction={onAction} />;
}
