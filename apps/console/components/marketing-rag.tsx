import { BookOpenCheck,SearchCheck,ShieldCheck } from 'lucide-react';
export function MarketingRag({en=false}:{en?:boolean}){
 const items=en?[
 ['Organize your knowledge','Upload product information, service policies and FAQs to your business knowledge base.'],
 ['Retrieve before answering','RAG retrieves relevant knowledge first, then uses it to help draft an answer, with references for review.'],
 ['Choose your reception mode','Use assisted replies or drafts, or authorize low-risk knowledge answers. Insufficient evidence or high-risk questions go to an agent.'],
 ]:[
 ['把企业知识整理好','上传产品资料、服务政策与常见问题，让分散的业务知识成为客服可以查阅的依据。'],
 ['先检索，再辅助回答','RAG（检索增强生成）先查找相关知识，再辅助生成回复建议，并提供引用依据供客服核对。'],
 ['授权接待，风险转人工','可选择人工辅助、自动草稿或知识库自动接待；达到阈值且低风险的问题按授权回复，资料不足或高风险时转人工。'],
 ];
 return <section id="rag" className="scroll-mt-24 bg-white py-20 lg:py-24"><div className="mx-auto max-w-[1200px] px-5 lg:px-8"><p className="text-sm font-semibold text-blue-700">{en?'Business knowledge · RAG':'企业知识库 · RAG'}</p><h2 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight text-[#071a3d] sm:text-4xl">{en?'Answers grounded in your business knowledge.':'让 AI 的回答，有你的业务知识作为依据。'}</h2><div className="mt-10 grid gap-5 md:grid-cols-3">{items.map(([title,description],i)=>{const Icon=[BookOpenCheck,SearchCheck,ShieldCheck][i];return <article key={title} className="rounded-2xl border border-slate-200 bg-slate-50 p-6"><Icon className="text-blue-600" size={24}/><h3 className="mt-5 font-semibold">{title}</h3><p className="mt-3 text-sm leading-7 text-slate-600">{description}</p></article>;})}</div><p className="mt-6 text-sm leading-7 text-slate-500">{en?'Knowledge and access are scoped to each business. Retrieval helps improve relevance; it does not guarantee that every answer is correct.':'知识按企业隔离并受访问权限控制。检索增强有助于提高回答的相关性，但不保证每条建议都正确，关键结论仍需人工核实。'}</p></div></section>;
}
