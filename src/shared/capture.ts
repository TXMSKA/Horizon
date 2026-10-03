import type { CaptureRect, ProjectSummary } from './api';

export function captureProjects(projects: readonly ProjectSummary[], inUse: string | null, search = ''): ProjectSummary[] {
  const query = search.trim().toLocaleLowerCase();
  return projects.filter(project => project.name.toLocaleLowerCase().includes(query)).sort((a, b) =>
    Number(b.id === inUse) - Number(a.id === inUse) || b.usedAt - a.usedAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function validCaptureRect(value: unknown, image: { width: number; height: number }): value is CaptureRect {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rect = value as CaptureRect;
  return Object.keys(rect).length === 4 && ['x', 'y', 'width', 'height'].every(key => Object.hasOwn(rect, key) && Number.isSafeInteger(rect[key as keyof CaptureRect]))
    && rect.x >= 0 && rect.y >= 0 && rect.width >= 8 && rect.height >= 8
    && rect.x + rect.width <= image.width && rect.y + rect.height <= image.height;
}
