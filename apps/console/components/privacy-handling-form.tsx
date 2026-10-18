"use client";
import {useState} from 'react';
const names:Record<string,string>={identity_verification:'要求身份核验',in_review:'开始处理',fulfilled:'完成',partially_fulfilled:'部分完成',rejected:'未予执行',cancelled:'取消'};
const choices:Record<string,string[]>={submitted:['identity_verification','in_review','cancelled'],identity_verification:['in_review','rejected','cancelled'],in_review:['fulfilled','partially_fulfilled','rejected','cancelled']};
export function PrivacyHandlingForm({id,status}:{id:string;status:string}){
 const allowed=choices[status]??[],[next,setNext]=useState(allowed[0]??'');if(!allowed.length)return null;
 const finish=next==='fulfilled'||next==='partially_fulfilled';
 return <form action={`/api/platform-admin/privacy-requests/${id}/transition`} method="post" className="mt-4 grid gap-4">
  <label className="text-sm">下一步<select name="next_status" value={next} onChange={e=>setNext(e.target.value)} className="mt-1 w-full rounded-xl border p-3">{allowed.map(v=><option key={v} value={v}>{names[v]}</option>)}</select></label>
  <label className="text-sm">{finish?'向申请人说明已办理的具体范围、方式及结果':'核验方式、处理范围或原因'}<textarea name="reason" required minLength={10} maxLength={2000} rows={4} className="mt-1 w-full rounded-xl border p-3" placeholder="至少 10 字；不要填写密码、验证码、证件原件或密钥。终态结果会展示给申请人。"/></label>
  {(next==='in_review'||finish)&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" name="identity_verified" value="confirmed" required className="mt-1"/>已通过既有受控方式核验申请人身份及申请范围，不仅凭填写的邮箱或自述核验。</label>}
  {finish&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" name="manual_completed" value="confirmed" required className="mt-1"/>确认对应查阅/交付/更正/删除/撤权或注销操作已经人工执行并核对；本按钮只登记结果，不执行这些操作。</label>}
  <label className="text-sm">未执行部分或必要保留的范围与原因{next==='partially_fulfilled'?'（必填，至少 10 字）':'（选填）'}<textarea name="legal_hold_reason" required={next==='partially_fulfilled'} minLength={next==='partially_fulfilled'?10:undefined} maxLength={1000} rows={3} className="mt-1 w-full rounded-xl border p-3"/></label>
  <button className="justify-self-start rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white">保存办理状态</button>
 </form>;
}
