import { readFileSync } from 'node:fs';

const css = readFileSync('src/tokens.css', 'utf8');
const variables = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
const roles = Object.keys(variables).filter(key => variables[key].startsWith('light-dark('));
const resolve = (key, theme) => {
  const value = variables[key];
  const pair = /^light-dark\(var\(--([\w-]+)\), var\(--([\w-]+)\)\)$/.exec(value);
  if (!pair) return value;
  return resolve(pair[theme === 'daylight' ? 1 : 2], theme);
};
const luminance = hex => {
  if (!/^#[a-f\d]{6}$/i.test(hex)) throw new Error('Contrast requires an opaque palette colour.');
  const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const ratio = (a, b) => {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};
const surfaces = roles.filter(key => key.startsWith('surface-'));
// Dividers only separate content that already reads apart, so WCAG 1.4.11 does not set them a ratio.
const foregrounds = roles.filter(key => !key.startsWith('surface-') && key !== 'divider');
let failed = false;
let checks = 0;
for (const theme of ['amber', 'daylight']) {
  for (const role of foregrounds) {
    const threshold = role.startsWith('text-') || role === 'accent' ? 4.5 : 3;
    let minimum = Infinity;
    for (const surface of surfaces) {
      const contrast = ratio(resolve(role, theme), resolve(surface, theme));
      checks++;
      minimum = Math.min(minimum, contrast);
      if (contrast < threshold) {
        failed = true;
        console.error(`${theme}: ${role} on ${surface} = ${contrast.toFixed(2)} < ${threshold}`);
      }
    }
    console.log(`${theme}: ${role} minimum ${minimum.toFixed(2)}:1 (required ${threshold}:1)`);
  }
}
if (failed) process.exit(1);
console.log(`${checks} contrast pairs passed.`);
