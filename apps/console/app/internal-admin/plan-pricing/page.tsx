import { redirect } from 'next/navigation';
import { PlatformAdminShell } from '../../../components/platform-admin-shell';
import { fetchPlatformAdminSession } from '../../../lib/platform-admin-session';
import { platformAdminLoad } from '../../../lib/platform-admin-proxy';
export const dynamic='force-dynamic';
type Price={plan_version_id:string;plan_code:string;name:string;version:number;status:string;price_minor:string;list_price_minor:string|null;annual_price_minor:string;effective_from:string};
const yuan=(v:string)=> (Number(v)/100).toFixed(2);
export default async function PricingPage({searchParams}:{searchParams:Promise<{saved?:string;error?:string}>}){
  const session=await fetchPlatformAdminSession();if(!session)redirect('/internal-admin/login');
  if(!['owner','admin'].includes(session.user.role))redirect('/internal-admin');
  const rows=await platformAdminLoad('plan-pricing') as Price[]|undefined,params=await searchParams;
  return <PlatformAdminShell session={session} activePath="/internal-admin/plan-pricing">
    <h1 className="text-2xl font-semibold">套餐定价</h1>
    <p className="text-sm text-slate-600">这里修改所有企业购买时使用的公开套餐价格。发布后立即生效；已有订单、已购权益不追溯改价。年付为月付优惠价 × 8，服务期为 12 个月。单个企业的特批权益仍在“套餐权益”管理。</p>
    {(params.saved||params.error)&&<p role="status" className="rounded-xl border bg-white p-3">{params.error?'发布失败：请核对价格和版本，刷新后重试。':'新价格版本已发布。'}</p>}
    {!rows?<p>价格数据暂不可用。</p>:<><div className="grid gap-4 md:grid-cols-2">{rows.filter(p=>p.status==='active').map(p=><form key={p.plan_version_id} action="/api/platform-admin/plan-pricing" method="post" className="space-y-4 rounded-2xl border bg-white p-5">
      <h2 className="font-semibold">{p.name} · V{p.version}</h2><input type="hidden" name="plan_code" value={p.plan_code}/><input type="hidden" name="expected_version" value={p.version}/>
      <label className="block text-sm">月付原价（元，可留空）<input name="list_price_yuan" type="number" min="0.01" max="999999.99" step="0.01" defaultValue={p.list_price_minor?yuan(p.list_price_minor):''} className="mt-1 block w-full rounded-lg border p-2"/></label>
      <label className="block text-sm">月付优惠价 / 实际售价（元）<input required name="price_yuan" type="number" min="0.01" max="999999.99" step="0.01" defaultValue={yuan(p.price_minor)} className="mt-1 block w-full rounded-lg border p-2"/></label>
      <p className="text-xs text-slate-500">当前年付 ¥{yuan(p.annual_price_minor)}。原价须为真实、有依据的标准价且不低于售价；未填写原价时不展示划线价。</p>
      <label className="block text-sm">发布原因<textarea name="reason" required minLength={10} maxLength={500} className="mt-1 block w-full rounded-lg border p-2"/></label><button className="rounded-lg bg-blue-600 px-4 py-2 text-white">发布新价格版本</button>
    </form>)}</div><section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">价格版本历史</h2><div className="mt-3 space-y-2">{rows.map(p=><p key={p.plan_version_id} className="text-sm">{p.name} · V{p.version} · 月付 ¥{yuan(p.price_minor)} · 年付 ¥{yuan(p.annual_price_minor)} · {p.status==='active'?'当前生效':'历史版本'}</p>)}</div></section></>}
  </PlatformAdminShell>;
}
