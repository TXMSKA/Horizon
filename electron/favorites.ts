import { randomUUID } from 'node:crypto';
import type { Bookmark, FavoriteFolder, FavoriteItem, FavoriteLink, FavoriteParent, FavoritesTree } from '../src/shared/api';
import { isWebURL } from './browsing';

export const FAVORITE_FOLDER_LIMIT = 1000;
export const FAVORITE_LINK_LIMIT = 10000;
export const FAVORITE_DEPTH_LIMIT = 8;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const controls = /[\x00-\x1f\x7f-\x9f]/;

export function favoriteName(value: unknown): string {
  if (typeof value !== 'string' || controls.test(value)) throw new Error('FAVORITE_NAME_INVALID');
  const name = value.trim();
  if (!name) throw new Error('FAVORITE_NAME_EMPTY');
  if (name.length > 80) throw new Error('FAVORITE_NAME_LONG');
  return name;
}

export function favoriteTitle(value: unknown): string {
  if (typeof value !== 'string' || controls.test(value) || value.length > 200) throw new Error('FAVORITE_TITLE_INVALID');
  return value;
}

export function favoriteURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || !isWebURL(value)) throw new Error('FAVORITE_URL_INVALID');
  return value;
}

export function favoriteId(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
export function favoriteParent(value: unknown): value is FavoriteParent { return value === 'bar' || value === 'other' || favoriteId(value); }

export function migrateBookmarks(bookmarks: Bookmark[]): FavoritesTree {
  return { bar: bookmarks.map(({ url, title, createdAt }) => ({ kind: 'link', id: randomUUID(), url, title, createdAt })), other: [] };
}

export function validFavorites(value: unknown): value is FavoritesTree {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tree = value as Record<string, unknown>;
  if (Object.keys(tree).length !== 2 || !Array.isArray(tree.bar) || !Array.isArray(tree.other)) return false;
  let folders = 0;
  const ids = new Set<string>();
  const timestamp = (time: unknown) => typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 && time <= 8640000000000000;
  const exact = (entry: Record<string, unknown>, keys: string[]) => Object.keys(entry).length === keys.length && keys.every(key => Object.hasOwn(entry, key));
  const walk = (items: unknown[], depth: number): boolean => items.length <= 100000 && Array.from(items).every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    if (!favoriteId(entry.id) || ids.has(entry.id) || !timestamp(entry.createdAt)) return false;
    ids.add(entry.id);
    if (entry.kind === 'link') {
      // Version four accepted these values; editing limits must not strand a migrated store.
      return exact(entry, ['kind', 'id', 'url', 'title', 'createdAt']) && isWebURL(entry.url)
        && typeof entry.title === 'string' && entry.title.length <= 4096 && !entry.title.includes('\0');
    }
    if (entry.kind === 'folder') {
      folders++;
      return depth < FAVORITE_DEPTH_LIMIT && exact(entry, ['kind', 'id', 'name', 'createdAt', 'children'])
        && typeof entry.name === 'string' && entry.name.length >= 1 && entry.name.length <= 80
        && entry.name === entry.name.trim() && !controls.test(entry.name) && Array.isArray(entry.children)
        && walk(entry.children, depth + 1);
    }
    return false;
  });
  return walk(tree.bar, 0) && walk(tree.other, 0) && folders <= FAVORITE_FOLDER_LIMIT;
}

export function favoriteLocation(tree: FavoritesTree, id: string): { item: FavoriteItem; siblings: FavoriteItem[]; index: number; depth: number; parent: FavoriteParent; root: 'bar' | 'other' } | undefined {
  const search = (siblings: FavoriteItem[], depth: number, parent: FavoriteParent, root: 'bar' | 'other'): ReturnType<typeof favoriteLocation> => {
    for (let index = 0; index < siblings.length; index++) {
      const item = siblings[index]!;
      if (item.id === id) return { item, siblings, index, depth, parent, root };
      if (item.kind === 'folder') { const found = search(item.children, depth + 1, item.id, root); if (found) return found; }
    }
    return undefined;
  };
  return search(tree.bar, 0, 'bar', 'bar') ?? search(tree.other, 0, 'other', 'other');
}

export function favoriteDestination(tree: FavoritesTree, parent: FavoriteParent): { items: FavoriteItem[]; depth: number } {
  if (parent === 'bar' || parent === 'other') return { items: tree[parent], depth: 0 };
  const location = favoriteLocation(tree, parent);
  if (!location || location.item.kind !== 'folder') throw new Error('FAVORITE_FOLDER_NOT_FOUND');
  return { items: location.item.children, depth: location.depth + 1 };
}

export function favoriteCounts(tree: FavoritesTree): { folders: number; links: number } {
  let folders = 0, links = 0;
  const walk = (items: FavoriteItem[]) => items.forEach(item => {
    if (item.kind === 'folder') { folders++; walk(item.children); } else links++;
  });
  walk(tree.bar); walk(tree.other); return { folders, links };
}

export function favoritePosition(position: number, length: number): void {
  if (!Number.isSafeInteger(position) || position < 0 || position > length) throw new Error('FAVORITE_POSITION_INVALID');
}

function favoriteRoom(items: FavoriteItem[], item: FavoriteItem['kind']): void {
  if (items.length >= 100000) throw new Error(item === 'link' ? 'FAVORITE_LINK_LIMIT' : 'FAVORITE_FOLDER_LIMIT');
}

export function addFavorite(tree: FavoritesTree, parent: FavoriteParent, position: number, url: string, title: string): FavoriteLink {
  favoriteURL(url); favoriteTitle(title);
  const { items } = favoriteDestination(tree, parent); favoritePosition(position, items.length);
  if (favoriteCounts(tree).links >= FAVORITE_LINK_LIMIT) throw new Error('FAVORITE_LINK_LIMIT');
  favoriteRoom(items, 'link');
  const link: FavoriteLink = { kind: 'link', id: randomUUID(), url, title, createdAt: Date.now() };
  items.splice(position, 0, link); return link;
}

export function createFavoriteFolder(tree: FavoritesTree, parent: FavoriteParent, position: number, name: string): FavoriteFolder {
  const clean = favoriteName(name);
  const { items, depth } = favoriteDestination(tree, parent); favoritePosition(position, items.length);
  if (depth >= FAVORITE_DEPTH_LIMIT) throw new Error('FAVORITE_DEPTH_LIMIT');
  if (favoriteCounts(tree).folders >= FAVORITE_FOLDER_LIMIT) throw new Error('FAVORITE_FOLDER_LIMIT');
  favoriteRoom(items, 'folder');
  const folder: FavoriteFolder = { kind: 'folder', id: randomUUID(), name: clean, createdAt: Date.now(), children: [] };
  items.splice(position, 0, folder); return folder;
}

export function moveFavorite(tree: FavoritesTree, id: string, parent: FavoriteParent, position: number): void {
  const source = favoriteLocation(tree, id);
  if (!source) throw new Error('FAVORITE_NOT_FOUND');
  const destination = favoriteDestination(tree, parent);
  if (source.siblings !== destination.items) favoriteRoom(destination.items, source.item.kind);
  if (source.item.kind === 'folder') {
    if (parent === id || containsFolder(source.item, parent)) throw new Error('FAVORITE_CYCLE');
    let maxDepth = 1;
    const walk = (folder: FavoriteFolder, depth: number) => { maxDepth = Math.max(maxDepth, depth); folder.children.forEach(item => { if (item.kind === 'folder') walk(item, depth + 1); }); };
    walk(source.item, 1);
    if (destination.depth + maxDepth > FAVORITE_DEPTH_LIMIT) throw new Error('FAVORITE_DEPTH_LIMIT');
  }
  favoritePosition(position, destination.items.length);
  source.siblings.splice(source.index, 1);
  const index = source.siblings === destination.items && position > source.index ? position - 1 : position;
  destination.items.splice(index, 0, source.item);
}

export type DeletedFavorite = { item: FavoriteItem; parent: FavoriteParent; root: 'bar' | 'other'; position: number };

export function deletedFavorite(tree: FavoritesTree, id: string): DeletedFavorite {
  const location = favoriteLocation(tree, id);
  if (!location) throw new Error('FAVORITE_NOT_FOUND');
  return { item: structuredClone(location.item), parent: location.parent, root: location.root, position: location.index };
}

export function restoreFavorite(tree: FavoritesTree, deleted: DeletedFavorite): void {
  const parent = deleted.parent === 'bar' || deleted.parent === 'other' || favoriteLocation(tree, deleted.parent)?.item.kind === 'folder' ? deleted.parent : deleted.root;
  const { items, depth } = favoriteDestination(tree, parent), counts = favoriteCounts(tree);
  const restored = favoriteCounts({ bar: [deleted.item], other: [] });
  if (counts.links + restored.links > FAVORITE_LINK_LIMIT) throw new Error('FAVORITE_LINK_LIMIT');
  if (counts.folders + restored.folders > FAVORITE_FOLDER_LIMIT) throw new Error('FAVORITE_FOLDER_LIMIT');
  favoriteRoom(items, deleted.item.kind);
  const height = (item: FavoriteItem): number => item.kind === 'link' ? 0 : 1 + Math.max(0, ...item.children.map(height));
  if (depth + height(deleted.item) > FAVORITE_DEPTH_LIMIT) throw new Error('FAVORITE_DEPTH_LIMIT');
  items.splice(parent === deleted.parent ? Math.min(deleted.position, items.length) : items.length, 0, structuredClone(deleted.item));
}

function containsFolder(folder: FavoriteFolder, id: string): boolean {
  return folder.children.some(item => item.kind === 'folder' && (item.id === id || containsFolder(item, id)));
}

export function favoriteLinks(items: FavoriteItem[]): FavoriteLink[] {
  return items.flatMap(item => item.kind === 'link' ? [item] : favoriteLinks(item.children));
}
