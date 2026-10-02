import { readFileSync } from 'node:fs';

const css = readFileSync('src/tokens.css', 'utf8');
const high = css.match(/:root\[data-contrast="high"\]\s*\{([^}]+)\}/)?.[1];
if (!high) throw new Error('Missing high-contrast semantic pair.');
const declarations = source => Object.fromEntries([...source.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
const standard = declarations(css.replace(high, ''));
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
const surfaces = roles.filter(key => key.startsWith('surface-'));
// Horizon rules, dividers and popover rims are decoration; the frame is the actionable boundary.
const decoration = ['divider', 'border-popover', 'border-subtle', 'graphic-horizon', 'switch-edge'];
// Named profile colours are graphic foregrounds and must pass on every surface, including selected rows.
const foregrounds = roles.filter(key => !key.startsWith('surface-') && !decoration.includes(key) && key !== 'on-accent');
let failed = false;
let checks = 0;
for (const [theme, variables, light] of [['amber', standard, false], ['daylight', standard, true], ['contrast-dark', contrast, false], ['contrast-light', contrast, true]]) {
  const check = (role, surface, threshold) => {
    const value = resolve(role, variables, light);
    if (value === undefined && role.startsWith('outline-') && variables === standard) return Infinity;
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
}
if (failed) process.exit(1);
console.log(`${checks} contrast pairs passed across four palettes.`);
