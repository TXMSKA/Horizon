import { GROUP_COLORS } from './api';
import type { GroupColor, TabGroup } from './api';

interface GroupedTab { groupId?: string | null }
export const groupId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const groupName = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
export const groupColor = (value: unknown): value is GroupColor => typeof value === 'string' && ((GROUP_COLORS as readonly string[]).includes(value) || /^#[0-9a-f]{6}$/i.test(value));
export function contiguousTabGroups(tabs: readonly GroupedTab[], groups: readonly TabGroup[]): boolean {
  const ids = new Set(groups.map(group => group.id)), seen = new Set<string>();
  let previous: string | null = null;
  for (const tab of tabs) {
    const id = tab.groupId ?? null;
    if (id !== null && (!ids.has(id) || id !== previous && seen.has(id))) return false;
    if (id !== null) seen.add(id);
    previous = id;
  }
  return groups.length === ids.size && ids.size === seen.size;
}
export function retainedTabGroups(tabs: readonly GroupedTab[], groups: readonly TabGroup[]): TabGroup[] {
  const ids = new Set(tabs.map(tab => tab.groupId));
  return groups.filter(group => ids.has(group.id));
}
export function visibleTabs<T extends GroupedTab>(tabs: readonly T[], groups: readonly TabGroup[]): T[] {
  const folded = new Set(groups.filter(group => group.folded).map(group => group.id));
  return tabs.filter(tab => !tab.groupId || !folded.has(tab.groupId));
}
// The strip draws each group's tabs after its label, so the tabs are cut into consecutive runs.
export function tabRuns<T extends GroupedTab>(tabs: readonly T[], groups: readonly TabGroup[]): { group: TabGroup | null; tabs: T[] }[] {
  const runs: { group: TabGroup | null; tabs: T[] }[] = [];
  for (const tab of tabs) {
    const group = groups.find(group => group.id === tab.groupId) ?? null, last = runs.at(-1);
    if (group && last?.group === group) last.tabs.push(tab); else runs.push({ group, tabs: [tab] });
  }
  return runs;
}
export function groupBoundaryIndex(tabs: readonly GroupedTab[], position: number): number {
  let index = Math.max(0, Math.min(position, tabs.length));
  const group = tabs[index - 1]?.groupId;
  if (group) while (tabs[index]?.groupId === group) index++;
  return index;
}
export function moveGroupedTab<T extends GroupedTab>(tabs: T[], tab: T, group: string | null): void {
  const index = tabs.indexOf(tab);
  if (index < 0) throw new Error('Unknown tab');
  const previous = tab.groupId ?? null;
  if (previous === null && group === null) return;
  tabs.splice(index, 1);
  const target = group ?? previous;
  const end = tabs.findLastIndex(tab => tab.groupId === target);
  const position = end >= 0 ? end + 1 : groupBoundaryIndex(tabs, index);
  tab.groupId = group; tabs.splice(position, 0, tab);
}
export function nearestVisibleTab(tabs: readonly GroupedTab[], groups: readonly TabGroup[], position: number, excluded?: string): number {
  const hidden = new Set(groups.filter(group => group.folded).map(group => group.id));
  if (excluded) hidden.add(excluded);
  for (let distance = 0; distance <= tabs.length; distance++) {
    for (const index of distance ? [position + distance, position - distance] : [position]) {
      const tab = tabs[index];
      if (tab && (!tab.groupId || !hidden.has(tab.groupId))) return index;
    }
  }
  return -1;
}
