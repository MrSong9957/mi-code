// Cron 匹配器：检查当前时间是否匹配 cron 表达式
//
// 物理本质：对照闹钟时间表看"现在该响了吗"。
// cron 格式：分 时 日 月 周（5 位）
// * = 任意值，*/N = 每 N 个单位，具体数字 = 精确匹配

/**
 * 检查 cron 表达式是否匹配给定时间
 *
 * @param cronExpr - 5 位 cron 表达式（分 时 日 月 周）
 * @param date - 要检查的时间
 * @param timezone - 可选时区（如 'Asia/Shanghai'、'America/New_York'），不传则用本地时间
 * @returns 是否匹配
 */
export function matchesCron(cronExpr: string, date: Date, timezone?: string): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const values = timezone
    ? getDatePartsInTimezone(date, timezone)
    : [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];

  for (let i = 0; i < 5; i++) {
    if (!matchField(fields[i]!, values[i]!)) {
      return false;
    }
  }

  return true;
}

/**
 * 用 Intl.DateTimeFormat 提取指定时区的日期各部分
 * 物理本质：把 UTC 时间"翻译"成目标时区的本地时间再读数
 */
function getDatePartsInTimezone(date: Date, timezone: string): number[] {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);

  const get = (type: string): number => {
    const part = parts.find(p => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };

  // weekday: 'Mon' → 需要转换为 0-6（0=周日）
  const weekdayMap: Record<string, number> = {
    'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6,
  };
  const weekdayPart = parts.find(p => p.type === 'weekday');
  const weekday = weekdayPart ? (weekdayMap[weekdayPart.value] ?? 0) : 0;

  // hour: '24' 表示午夜，需要转为 0
  let hour = get('hour');
  if (hour === 24) hour = 0;

  return [get('minute'), hour, get('day'), get('month'), weekday];
}

// 匹配单个 cron 字段
// 支持格式：
// - "*"  : 任意值
// - "*/N": 每 N 个单位
// - "N-M": 范围（含两端）
// - "N"  : 精确匹配
// - "N,M": 多个值（逗号分隔）
function matchField(field: string, value: number): boolean {
  // 通配符
  if (field === '*') return true;

  // 间隔：*/N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return false;
    return value % step === 0;
  }

  // 范围：N-M
  if (field.includes('-') && !field.startsWith('-')) {
    const [start, end] = field.split('-').map(s => parseInt(s.trim(), 10));
    if (isNaN(start!) || isNaN(end!)) return false;
    return value >= start! && value <= end!;
  }

  // 逗号分隔：N,M,K
  if (field.includes(',')) {
    const parts = field.split(',');
    return parts.some(p => matchField(p.trim(), value));
  }

  // 精确匹配
  const num = parseInt(field, 10);
  if (isNaN(num)) return false;
  return num === value;
}
