export interface GroupPalette { chrome: string; wash: string; colors: Readonly<Record<string, string>> }
export interface HSV { h: number; s: number; v: number }

const channels = (hex: string): number[] => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
const hex = (rgb: readonly number[]): `#${string}` => `#${rgb.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('')}`;
export function colorContrast(first: string, second: string): number {
  const luminance = (value: string) => channels(value).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function hexToHSV(color: string): HSV {
  const [r, g, b] = channels(color) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = !delta ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: max ? delta / max * 100 : 0, v: max * 100 };
}
export function hsvToHex({ h, s, v }: HSV): `#${string}` {
  const hue = ((h % 360) + 360) % 360 / 60, chroma = v / 100 * s / 100, x = chroma * (1 - Math.abs(hue % 2 - 1)), base = v / 100 - chroma;
  const rgb = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return hex(rgb.map(value => value + base));
}
// A group colour is the underline on the tab strip (3:1) and the name on the label's wash (4.5:1).
export function adjustedGroupColor(color: string, chrome: string, wash: string): `#${string}` {
  if (![color, chrome, wash].every(value => /^#[a-f\d]{6}$/i.test(value))) throw new Error('Invalid group color');
  const reaches = (value: string) => colorContrast(value, chrome) >= 3 && colorContrast(value, wash) >= 4.5;
  if (reaches(color)) return color.toLowerCase() as `#${string}`;
  const rgb = channels(color), high = Math.max(...rgb), low = Math.min(...rgb), lightness = (high + low) / 2;
  const saturation = high === low ? 0 : (high - low) / (1 - Math.abs(2 * lightness - 1));
  const { h } = hexToHSV(color);
  const atLightness = (value: number) => {
    const chroma = (1 - Math.abs(2 * value - 1)) * saturation, brightness = value + chroma / 2;
    return hsvToHex({ h, v: brightness * 100, s: brightness ? chroma / brightness * 100 : 0 });
  };
  // The colour keeps its hue, so only lightness moves, and the nearest passing value changes it least.
  for (let step = 1; step <= 1000; step++) {
    for (const direction of [-1, 1]) {
      const candidate = atLightness(Math.min(1, Math.max(0, lightness + direction * step / 1000)));
      if (reaches(candidate)) return candidate;
    }
  }
  return colorContrast('#ffffff', wash) > colorContrast('#000000', wash) ? '#ffffff' : '#000000';
}
export function groupPaint(color: string, palette: GroupPalette): `#${string}` {
  return adjustedGroupColor(palette.colors[color] ?? color, palette.chrome, palette.wash);
}
