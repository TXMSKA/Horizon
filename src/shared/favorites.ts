import type { FavoriteItem, FavoriteLink, FavoritesTree } from './api';

export function favoriteLinks(items: FavoriteItem[]): FavoriteLink[] {
  return items.flatMap(item => item.kind === 'link' ? [item] : favoriteLinks(item.children));
}

export function allFavoriteLinks(tree: FavoritesTree): FavoriteLink[] {
  return favoriteLinks([...tree.bar, ...tree.other]);
}

export function favoriteLocation(tree: FavoritesTree, id: string): { item: FavoriteItem; parent: string; position: number; depth: number } | null {
  const visit = (items: FavoriteItem[], parent: string, depth: number): ReturnType<typeof favoriteLocation> => {
    for (let position = 0; position < items.length; position++) {
      const item = items[position]!;
      if (item.id === id) return { item, parent, position, depth };
      if (item.kind === 'folder') { const found = visit(item.children, item.id, depth + 1); if (found) return found; }
    }
    return null;
  };
  return visit(tree.bar, 'bar', 1) ?? visit(tree.other, 'other', 1);
}

export function favoriteChildren(tree: FavoritesTree, parent: string): FavoriteItem[] | null {
  if (parent === 'bar' || parent === 'other') return tree[parent];
  const found = favoriteLocation(tree, parent);
  return found?.item.kind === 'folder' ? found.item.children : null;
}

export function canMoveFavorite(tree: FavoritesTree, id: string, parent: string): boolean {
  const source = favoriteLocation(tree, id), destination = favoriteChildren(tree, parent);
  if (!source || !destination || parent === id) return false;
  if (source.item.kind === 'link') return true;
  const contains = (items: FavoriteItem[]): boolean => items.some(item => item.id === parent || item.kind === 'folder' && contains(item.children));
  if (contains(source.item.children)) return false;
  const height = (items: FavoriteItem[]): number => Math.max(0, ...items.filter(item => item.kind === 'folder').map(item => 1 + height(item.children)));
  const depth = parent === 'bar' || parent === 'other' ? 0 : favoriteLocation(tree, parent)!.depth;
  return depth + 1 + height(source.item.children) <= 8;
}

export function filterFavorites(items: FavoriteItem[], query: string, language: string): FavoriteItem[] {
  const needle = query.trim().toLocaleLowerCase(language);
  if (!needle) return items;
  return items.flatMap(item => {
    if ((item.kind === 'link' ? `${item.title} ${item.url}` : item.name).toLocaleLowerCase(language).includes(needle)) return [item];
    if (item.kind === 'link') return [];
    const children = filterFavorites(item.children, query, language);
    return children.length ? [{ ...item, children }] : [];
  });
}

// Reserve the overflow control only when the complete row cannot fit.
export function favoritesOverflow(widths: readonly number[], available: number, overflowWidth = 28, gap = 6): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
  if (total <= available) return widths.length;
  let used = 0, visible = 0;
  for (const width of widths) {
    if (used + width + gap + overflowWidth > available) break;
    used += width + gap; visible++;
  }
  return visible;
}
