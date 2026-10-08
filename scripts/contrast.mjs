import { readFileSync } from 'node:fs';

// The suggested group colours are the roles named in the shared API; reading its source keeps this check free of a build.
const apiSource = readFileSync('src/shared/api.ts', 'utf8');
const GROUP_COLORS = [...(apiSource.match(/GROUP_COLORS = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'(\w+)'/g)].map(match => match[1]);
if (!GROUP_COLORS.length) throw new Error('Missing group colours.');
const MARKETPLACE_THEMES = [...(apiSource.match(/MARKETPLACE_THEMES = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'(\w+)'/g)].map(match => match[1]);
if (!MARKETPLACE_THEMES.length) throw new Error('Missing marketplace themes.');

const css = readFileSync('src/tokens.css', 'utf8');
const high = css.match(/:root\[data-contrast="high"\]\s*\{([^}]+)\}/)?.[1];
if (!high) throw new Error('Missing high-contrast semantic pair.');
const declarations = source => Object.fromEntries([...source.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
// Each marketplace theme owns one semantic block; its colour scheme says whether it is checked as a light or a dark palette.
const blocks = Object.fromEntries(MARKETPLACE_THEMES.map(theme => {
  const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing ${theme} semantic roles.`);
  const scheme = /color-scheme:\s*(only light|dark);/.exec(block)?.[1];
  if (!scheme) throw new Error(`Missing ${theme} colour scheme.`);
  return [theme, { block, light: scheme === 'only light' }];
}));
const standard = declarations(Object.values(blocks).reduce((source, { block }) => source.replace(block, ''), css.replace(high, '')));
const paletteRoles = Object.keys(standard).filter(key => key.startsWith('palette-amber-'));
for (const theme of MARKETPLACE_THEMES) for (const key of paletteRoles) if (!Object.hasOwn(standard, key.replace('palette-amber-', `palette-${theme}-`))) throw new Error(`Missing ${theme} role: ${key}`);
const contrast = { ...standard, ...declarations(high) };
const roles = Object.keys(contrast).filter(key => contrast[key].startsWith('light-dark('));
const resolve = (key, variables, light) => {
  const value = variables[key];
  const pair = /^light-dark\(var\(--([\w-]+)\), var\(--([\w-]+)\)\)$/.exec(value);
  if (pair) return resolve(pair[light ? 1 : 2], variables, light);
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  return alias ? resolve(alias[1], variables, light) : value;
};
const luminance = hex => {
  if (!/^#[a-f\d]{6}$/i.test(hex)) throw new Error(`Contrast requires an opaque palette colour: ${hex}`);
  const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const ratio = (a, b) => {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};
const surfaces = roles.filter(key => key.startsWith('surface-') && key !== 'surface-overlay');
// Horizon rules, dividers and popover rims are decoration; the frame is the actionable boundary.
const decoration = ['divider', 'border-popover', 'border-subtle', 'graphic-horizon', 'switch-edge'];
// Named profile colours are graphic foregrounds and must pass on every surface, including selected rows.
const foregrounds = roles.filter(key => !key.startsWith('surface-') && !decoration.includes(key) && key !== 'on-accent');
let failed = false;
let checks = 0;
const palettes = [
  ['amber', standard, false], ['daylight', standard, true],
  ...MARKETPLACE_THEMES.map(theme => [theme, { ...standard, ...declarations(blocks[theme].block) }, blocks[theme].light]),
  ['contrast-dark', contrast, false], ['contrast-light', contrast, true],
];
for (const [theme, variables, light] of palettes) {
  const check = (role, surface, threshold) => {
    const value = resolve(role, variables, light);
    if (value === undefined && role.startsWith('outline-') && !theme.startsWith('contrast-')) return Infinity;
    const contrast = ratio(value, resolve(surface, variables, light));
    checks++;
    if (contrast < threshold) {
      failed = true;
      console.error(`${theme}: ${role} on ${surface} = ${contrast.toFixed(2)} < ${threshold}`);
    }
    return contrast;
  };
  for (const role of foregrounds) {
    const threshold = role.startsWith('text-') || role === 'accent' ? 4.5 : 3;
    let minimum = Infinity;
    const on = role === 'graphic-sun' ? ['surface-page', 'surface-ground'] : surfaces;
    for (const surface of on) minimum = Math.min(minimum, check(role, surface, threshold));
    if (minimum < Infinity) console.log(`${theme}: ${role} minimum ${minimum.toFixed(2)}:1 (required ${threshold}:1)`);
  }
  check('on-accent', 'accent', 4.5);
  for (const colour of roles.filter(key => key.startsWith('profile-'))) check('on-accent', colour, 4.5);
  // The suggested group colours are palette roles drawn as they are: the underline on the tab strip, the name on the label's wash, the dot and the chosen icon on the editor's surfaces.
  const palette = name => variables[`palette-${theme}-${name}`];
  for (const role of GROUP_COLORS) {
    const colour = palette(role), strip = ratio(colour, palette('chrome')), label = ratio(colour, palette('wash'));
    const editor = Math.min(ratio(colour, palette('surface')), ratio(colour, palette('surface-3')));
    checks += 3;
    if (strip < 3 || label < 4.5 || editor < 3) { failed = true; console.error(`${theme}: group ${role} ${colour} strip ${strip.toFixed(2)}:1, label ${label.toFixed(2)}:1, editor ${editor.toFixed(2)}:1`); }
    console.log(`${theme}: group ${role} ${colour} strip ${strip.toFixed(2)}:1 (3:1), label ${label.toFixed(2)}:1 (4.5:1), editor ${editor.toFixed(2)}:1 (3:1)`);
  }
}
if (failed) process.exit(1);
console.log(`${checks} contrast pairs passed across ${palettes.length} palettes.`);
