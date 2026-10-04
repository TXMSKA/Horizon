export function webTabTitle(tab: { url: string; title: string }, home: string): string {
  if (!tab.url || tab.url === 'about:blank') return home;
  return tab.title && tab.title !== tab.url ? tab.title : tab.url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '');
}
