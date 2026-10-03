export function desktopText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0');
}
export function desktopInputText(value: unknown, maximum: number): value is string {
  return desktopText(value, maximum) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
}
export function desktopTitle(value: unknown, maximum = 200): value is string {
  return desktopInputText(value, maximum) && !/[\t\r\n]/.test(value);
}
