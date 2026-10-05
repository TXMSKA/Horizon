import { randomUUID } from 'node:crypto';
import type { FavoriteItem, FavoritesTree, HistoryEntry } from '../src/shared/api';
import { FAVORITE_DEPTH_LIMIT, FAVORITE_FOLDER_LIMIT, FAVORITE_LINK_LIMIT, favoriteCounts, favoriteLinks } from './favorites';
import type { ImportedFavorites, ImportedHistoryEntry, ImportedItem } from './import';

export const HISTORY_LIMIT = 10000;

export interface FavoritesMerge { links: number; skipped: number }

// Folders are matched by name at the same place and reused, new ones follow the source's order after what is already there,
// and a link whose address the profile already has anywhere is not repeated.
export function mergeFavorites(tree: FavoritesTree, imported: Pick<ImportedFavorites, 'bar' | 'other'>): FavoritesMerge {
  const known = new Set(favoriteLinks([...tree.bar, ...tree.other]).map(link => link.url));
  const counts = favoriteCounts(tree);
  const result = { links: 0, skipped: 0 };
  let folders = counts.folders;
  const merge = (items: FavoriteItem[], source: ImportedItem[], depth: number): void => {
    for (const item of source) {
      if (item.kind === 'link') {
        if (known.has(item.url)) continue;
        if (counts.links + result.links >= FAVORITE_LINK_LIMIT) { result.skipped++; continue; }
        items.push({ kind: 'link', id: randomUUID(), url: item.url, title: item.title, createdAt: item.createdAt });
        result.links++;
        continue;
      }
      const existing = items.find(entry => entry.kind === 'folder' && entry.name === item.name);
      if (existing?.kind === 'folder') { merge(existing.children, item.children, depth + 1); continue; }
      // Past the nesting or folder limits a folder gives its contents to the folder above.
      if (depth >= FAVORITE_DEPTH_LIMIT || folders >= FAVORITE_FOLDER_LIMIT) { merge(items, item.children, depth); continue; }
      const folder: FavoriteItem = { kind: 'folder', id: randomUUID(), name: item.name, createdAt: item.createdAt, children: [] };
      folders++;
      merge(folder.children, item.children, depth + 1);
      if (folder.children.length) items.push(folder); else folders--;
    }
  };
  merge(tree.bar, imported.bar, 0);
  merge(tree.other, imported.other, 0);
  return result;
}

// The later visit and the larger count win, so importing the same file twice changes nothing.
export function mergeHistory(existing: readonly HistoryEntry[], imported: readonly ImportedHistoryEntry[]): { history: HistoryEntry[]; imported: number } {
  const entries = new Map(existing.map(entry => [entry.url, entry]));
  const changed = new Set<string>();
  for (const item of imported) {
    const current = entries.get(item.url);
    if (!current) { entries.set(item.url, { ...item }); changed.add(item.url); continue; }
    const next = { url: current.url, title: current.title || item.title, lastVisit: Math.max(current.lastVisit, item.lastVisit), visitCount: Math.max(current.visitCount, item.visitCount) };
    if (next.title === current.title && next.lastVisit === current.lastVisit && next.visitCount === current.visitCount) continue;
    entries.set(item.url, next); changed.add(item.url);
  }
  const history = [...entries.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, HISTORY_LIMIT);
  return { history, imported: history.filter(entry => changed.has(entry.url)).length };
}
