import { Search } from 'lucide-react';

export function ConversationSearch({ en, status, values }: { en: boolean; status: string; values: Record<string,string|undefined> }) {
  const input = 'min-w-0 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs';
  return <form action="/workbench" className="mt-2 space-y-2" role="search">
    <input type="hidden" name="status" value={status}/>
    <div className="flex gap-1"><input name="profile" defaultValue={values.profile} maxLength={120} aria-label={en?'Customer profile or note':'客户资料或备注'} placeholder={en?'Name, contact or notes':'姓名、联系方式、人工或 AI 备注'} className={input}/><button className="shrink-0 rounded-lg bg-blue-50 p-2 text-blue-700" aria-label={en?'Search':'搜索'}><Search size={17}/></button></div>
    <details open={Boolean(values.content || values.from || values.to)} className="text-xs text-slate-600"><summary className="cursor-pointer">{en?'Advanced search':'高级搜索'}</summary><div className="mt-2 space-y-2">
      <input name="content" defaultValue={values.content} maxLength={120} aria-label={en?'Message content':'消息内容'} placeholder={en?'Message content':'消息内容（与客户条件同时满足）'} className={input}/>
      <label className="block">{en?'Last activity from (China time)':'最后活动开始日期（北京时间）'}<input type="date" name="from" defaultValue={values.from} className={input}/></label>
      <label className="block">{en?'Through':'结束日期（含当天）'}<input type="date" name="to" defaultValue={values.to} className={input}/></label>
      <button className="rounded-lg bg-blue-600 px-3 py-2 text-white">{en?'Apply filters':'应用筛选'}</button>
      <a className="ml-3" href={`/workbench?status=${status}`}>{en?'Clear':'清除'}</a>
    </div></details>
  </form>;
}
