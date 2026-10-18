import {consoleNavItems,consoleNavGroups,consoleNavLabels,isConsoleNavActive} from '../lib/console-nav';
import {canAccessConsolePath} from '../lib/console-access';
import type {ConsoleLocale} from '../lib/console-i18n';

/** Presentation only: gateway authorization remains unchanged. */
export function ConsoleNavigation({activePath,role,impersonating=false,locale,onNavigate,mobile=false}:{activePath:string;role:string;impersonating?:boolean;locale:ConsoleLocale;onNavigate?:()=>void;mobile?:boolean}) {
 return <>{consoleNavGroups.map(group=>{
  const items=consoleNavItems.filter(item=>(group.labels as readonly string[]).includes(item.label)&&canAccessConsolePath(item.href,role,impersonating));
  if(!items.length)return null;
  return <div key={group.id} className="pb-2" role="group" aria-label={locale==='en'?group.en:group.zh}>
   <p className="px-3 pb-1 pt-3 text-[11px] font-semibold tracking-wide text-[var(--ink-500)]">{locale==='en'?group.en:group.zh}</p>
   {items.map(item=>{const Icon=item.icon,active=isConsoleNavActive(item.href,activePath);return <a key={item.label} href={item.href} onClick={onNavigate} aria-current={active?'page':undefined} className={`flex ${mobile?'min-h-11':'min-h-9'} items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${active?'bg-[var(--brand-50)] font-semibold text-[var(--brand-700)]':'text-[var(--ink-700)] hover:bg-slate-50'}`}><span aria-hidden="true" className="grid size-5 shrink-0 place-items-center [transform:translateZ(0)]"><Icon className="size-[18px]" strokeWidth={1.8}/></span><span>{consoleNavLabels[item.label][locale]}</span></a>;})}
  </div>;
 })}</>;
}
