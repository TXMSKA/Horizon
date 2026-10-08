import type { BrowserCommand, BrowserState, SyncRemoteWindow } from './api';

type RemoteTabHost = { command(command: BrowserCommand): Promise<unknown>; getState(): Promise<BrowserState> };
export async function openRemoteGroup(host: RemoteTabHost, window: SyncRemoteWindow, groupId: string): Promise<void> {
  const group = window.groups.find(group => group.id === groupId), tabs = window.tabs.filter(tab => tab.group === groupId);
  if (!group || !tabs.length) throw new Error('SYNC_CHANGED');
  const before = await host.getState();
  if (before.privateWindow || !before.sync.switches.tabs) throw new Error('SYNC_CHANGED');
  if (before.tabs.length + tabs.length > 200) throw new Error('SYNC_TAB_LIMIT');
  const created: string[] = [];
  let current = before;
  try {
    for (const tab of tabs) {
      await host.command({ type: 'new-tab', input: tab.url, background: true });
      const next = await host.getState(), previous = new Set(current.tabs.map(tab => tab.id));
      const added = next.tabs.filter(tab => !previous.has(tab.id));
      // Do not assign someone else's tab if another action ran while IPC was pending.
      if (next.activeProfileId !== before.activeProfileId || added.length !== 1 || added[0]!.url !== tab.url) throw new Error('SYNC_CHANGED');
      created.push(added[0]!.id); current = next;
    }
    await host.command({ type: 'create-tab-group', id: created[0]! });
    const state = await host.getState(), id = state.tabs.find(tab => tab.id === created[0])?.groupId;
    if (!id) throw new Error('SYNC_CHANGED');
    await host.command({ type: 'close-tab-group-editor', id });
    await host.command({ type: 'update-tab-group', id, name: group.title });
    for (const tab of created.slice(1)) await host.command({ type: 'add-tab-to-group', id: tab, group: id });
    await host.command({ type: 'activate-tab', id: created[0]! });
  } catch (reason) {
    // A retry must not duplicate a group that was only partly opened.
    for (const id of created.reverse()) await host.command({ type: 'close-tab', id });
    throw reason;
  }
}
