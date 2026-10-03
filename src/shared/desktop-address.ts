import type { ProjectSummary } from './api';

export const desktopAddress = (name: string) => `horizon://desktop/${name.toLowerCase().replace(/\s+/g, '-').replace(/[<>"/\\?#%{}|^`]/g, '')}`;

export function desktopSuggestions(projects: readonly ProjectSummary[], query: string) {
  const search = query.toLocaleLowerCase();
  return projects.filter(project => `${project.name} ${desktopAddress(project.name)}`.toLocaleLowerCase().includes(search)).slice(0, 3)
    .map(project => ({ kind: 'project' as const, url: desktopAddress(project.name), title: project.name }));
}
