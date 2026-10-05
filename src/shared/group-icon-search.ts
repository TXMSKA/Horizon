export interface GroupIconResult { name: string; es: readonly string[] }
export type GroupIconSearch = (query: string) => GroupIconResult[];
type Tags = Readonly<Record<string, readonly string[]>>;
const words = (value: string): string[] => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// People type plurals ("trees", "árboles") and the tags hold the singular.
const singulars = (word: string): string[] => word.length < 4 ? [] : [word.replace(/s$/, ''), word.replace(/es$/, '')];
const starts = (typed: string, candidate: string) => candidate.startsWith(typed) || singulars(typed).includes(candidate);
const whole = (typed: string, candidate: string) => candidate === typed || singulars(typed).includes(candidate);
// Lucide's English tags and Horizon's Spanish entries are two tables; each Spanish entry lists the icon's Spanish name first, then its tags.
export function createGroupIconSearch(english: Tags, spanish: Tags): GroupIconSearch {
  const index = Object.entries(english).map(([name, tags]) => {
    const es = spanish[name] ?? [], title = [...new Set([...words(name), ...words(es[0] ?? '')])];
    return { icon: { name, es }, name: words(name).join(' '), title, every: [...new Set([...title, ...tags.flatMap(words), ...es.flatMap(words)])] };
  });
  return query => {
    const typed = words(query);
    const matches = (candidates: readonly string[], test: (typed: string, candidate: string) => boolean) => typed.every(word => candidates.some(candidate => test(word, candidate)));
    // A name or a whole tag word answers better than a word that only starts like the query ("trip" and "triple").
    const rank = (entry: typeof index[number]) => entry.name === typed.join(' ') ? 0 : matches(entry.title, starts) ? 1 : matches(entry.every, whole) ? 2 : 3;
    return index.filter(entry => matches(entry.every, starts)).map(entry => ({ entry, rank: rank(entry) })).sort((a, b) => a.rank - b.rank).map(({ entry }) => entry.icon);
  };
}
