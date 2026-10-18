export function RegistrationBudgetForm({limit}:{limit:number}) {
  return <details className="mt-4 rounded-xl border p-3">
    <summary className="cursor-pointer text-sm font-medium text-blue-600">调整短信预算</summary>
    <form action="/api/platform-admin/registration/budget" method="post" className="mt-3 space-y-3">
      <input type="hidden" name="expected_limit" value={limit}/>
      <label className="block text-sm">每日验证次数上限<input className="mt-1 w-full rounded-lg border p-2" type="number" name="limit" min={1} max={1000000} step={1} defaultValue={limit} required/></label>
      <label className="block text-sm">调整原因<textarea className="mt-1 w-full rounded-lg border p-2" name="reason" minLength={10} maxLength={500} required placeholder="至少 10 个字，用于操作审计"/></label>
      <p className="text-xs text-slate-500">立即生效并持续用于后续每日预算；按 UTC 零点重置已用次数。本次调整不清空已用次数，低于已用次数时暂停新增验证。</p>
      <button className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">保存预算</button>
    </form>
  </details>;
}
