import { createHash } from 'node:crypto';

export function parseWorkbenchSearch(params: URLSearchParams) {
  const profile = (params.get('profile') ?? '').trim();
  const content = (params.get('content') ?? '').trim();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (profile.length > 120 || content.length > 120) throw new Error('搜索内容最多 120 字');
  for (const date of [from, to]) {
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date)) throw new Error('日期格式不正确');
  }
  if (from && to && from > to) throw new Error('开始日期不能晚于结束日期');
  // Date-only filters are calendar days in the product's China timezone.
  const since = from ? Date.parse(`${from}T00:00:00+08:00`) : null;
  const until = to ? Date.parse(`${to}T00:00:00+08:00`) + 86_400_000 : null;
  const active = Boolean(profile || content || from || to);
  const scope: 'conversations' | `search:${string}` = active ? `search:${createHash('sha256').update(JSON.stringify([profile,content,from,to,params.get('status') ?? 'all'])).digest('hex').slice(0,24)}` : 'conversations';
  return { profile, content, since, until, active, scope };
}

export function likeLiteral(value: string) { return `%${value.replace(/[\\%_]/g, '\\$&')}%`; }
