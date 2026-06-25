// 颜色名 → ANSI 前景色代码
const FG_MAP: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37',
  gray: '90', grey: '90',
  redBright: '91', greenBright: '92', yellowBright: '93', blueBright: '94',
  magentaBright: '95', cyanBright: '96', whiteBright: '97',
};

const BG_MAP: Record<string, string> = {
  black: '40', red: '41', green: '42', yellow: '43',
  blue: '44', magenta: '45', cyan: '46', white: '47',
  gray: '100', grey: '100',
};

export function fgAnsi(color: string | undefined): string {
  if (!color) return '';
  return FG_MAP[color] ?? '';
}

export function bgAnsi(color: string | undefined): string {
  if (!color) return '';
  return BG_MAP[color] ?? '';
}
