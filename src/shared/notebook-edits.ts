import type { BrowserCommand } from './api';

type Fields = { title?: string; text?: string; note?: string };
type Edit = { notebook: string; id: string; fields: Fields; revision: number };

// Keep drafts outside the mounted item. Tab changes await flush; failures retain
// the draft and prevent a profile switch from sending it into another profile.
export class NotebookEdits {
  private drafts = new Map<string, Edit>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private work: Promise<void> = Promise.resolve();
  constructor(private send: (command: BrowserCommand) => Promise<void>, private failed: (reason: unknown) => void) {}
  fields(notebook: string, id: string): Fields { return this.drafts.get(`${notebook}:${id}`)?.fields ?? {}; }
  change(notebook: string, id: string, fields: Fields): void {
    const key = `${notebook}:${id}`, before = this.drafts.get(key);
    this.drafts.set(key, { notebook, id, fields: { ...before?.fields, ...fields }, revision: (before?.revision ?? 0) + 1 });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(this.failed); }, 400);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const next = this.work.catch(() => {}).then(async () => {
      while (this.drafts.size) {
        const [key, edit] = this.drafts.entries().next().value!;
        await this.send({ type: 'update-notebook-item', notebook: edit.notebook, id: edit.id, ...edit.fields });
        if (this.drafts.get(key)?.revision === edit.revision) this.drafts.delete(key);
      }
    });
    this.work = next;
    return next;
  }
}
