import { createHash } from 'node:crypto';
import { fieldTypes, ruleOperators } from './extension-capabilities.js';
import {validateAutomationPreview,type AutomationPreview} from './automation-preview.js';

export class ExtensionError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export type Field = { key: string; label: string; type: 'text'|'textarea'|'number'|'date'|'select'|'checkbox'; required: boolean; options?: string[] };
export type Rule = { name: string; when: { field: string; operator: typeof ruleOperators[number]; value: string|number|boolean }; then: { field: string; value: string|number|boolean } };
export type Chart = { key:string; title:string; type:'bar'|'line'; group_by:string; metric:'count'|'sum'|'average'; value_field?:string };
export type StudioAction={key:string;title:string;kind:'http';fields:string[]}|{key:string;title:string;kind:'campaign';name_field:string;content_field:string;audience_tag_field?:string};
export type ExtensionDefinition = {
  schema_version: 1; name: string; description: string;
  page: { title: string; description: string; columns: 1|2; submit_label: string };
  fields: Field[]; table_columns: string[];
  charts?: Chart[];
  actions?: StudioAction[];
  code?: {language:'javascript';source:string};
  intent?: {labels:string[]};
  automation_preview?: AutomationPreview;
  workbench?: {title:string;theme:'blue'|'emerald'|'violet';density:'comfortable'|'compact';list_width:260|320|380;details_width:280|360|440;tools_position:'before_profile'|'after_profile'};
  workflow: { trigger: 'form.submitted'; rules: Rule[] };
};
export const extensionPermissions = ['extension.records.read', 'extension.records.create', 'extension.records.transform'] as const;
export const exampleDefinition: ExtensionDefinition = {
  schema_version: 1, name: '售后登记', description: '登记内部售后事项，不发送客户消息。',
  page: { title: '售后登记台', description: '提交表单后按规则标记优先级。', columns: 2, submit_label: '登记事项' },
  fields: [
    { key: 'subject', label: '事项', type: 'text', required: true },
    { key: 'amount', label: '金额', type: 'number', required: true },
    { key: 'priority', label: '优先级', type: 'select', required: true, options: ['普通', '优先'] },
  ], table_columns: ['subject', 'amount', 'priority'],
  workflow: { trigger: 'form.submitted', rules: [{ name: '高金额标记优先', when: { field: 'amount', operator: 'gte', value: 500 }, then: { field: 'priority', value: '优先' } }] },
};
function fail(): never { throw new ExtensionError('invalid_definition'); }
export function exactObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !allowed.includes(k))) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail();
  return value.trim();
}
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) fail(); return value; }
function scalar(field: Field, value: unknown): string|number|boolean {
  if (field.type === 'number') { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) fail(); return value; }
  if (field.type === 'checkbox') { if (typeof value !== 'boolean') fail(); return value; }
  const v = text(value, field.type === 'textarea' ? 2000 : 200);
  if (field.type === 'select' && !field.options?.includes(v)) fail();
  if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10) !== v)) fail();
  return v;
}
export function validateDefinition(value: unknown): ExtensionDefinition {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 24000) fail();
  const d = exactObject(value, ['schema_version','name','description','page','fields','table_columns','workflow','charts','code','intent','workbench','automation_preview','actions']);
  let intent:ExtensionDefinition['intent'],workbench:ExtensionDefinition['workbench'];
  if(d.intent!==undefined){const i=exactObject(d.intent,['labels']);const labels=list(i.labels,10).map(v=>text(v,30));if(!labels.length||new Set(labels).size!==labels.length||labels.includes('无法判断'))fail();intent={labels};}
  if(d.workbench!==undefined){const b=exactObject(d.workbench,['title','theme','density','list_width','details_width','tools_position']);if(!['blue','emerald','violet'].includes(String(b.theme))||!['comfortable','compact'].includes(String(b.density))||![260,320,380].includes(b.list_width as number)||![280,360,440].includes(b.details_width as number)||!['before_profile','after_profile'].includes(String(b.tools_position)))fail();workbench={title:text(b.title,60),theme:b.theme as 'blue',density:b.density as 'compact',list_width:b.list_width as 320,details_width:b.details_width as 280,tools_position:b.tools_position as 'before_profile'};}
  let code:ExtensionDefinition['code'];
  if(d.code!==undefined){const c=exactObject(d.code,['language','source']);if(c.language!=='javascript')fail();code={language:'javascript',source:text(c.source,8000)};}
  if (d.schema_version !== 1) fail();
  const p = exactObject(d.page, ['title','description','columns','submit_label']);
  if (![1,2].includes(Number(p.columns)) || typeof p.columns !== 'number') fail();
  const fields = list(d.fields, 12).map(raw => {
    const f = exactObject(raw, ['key','label','type','required','options']);
    if (typeof f.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(f.key) || ['constructor','prototype','__proto__','tenant_id','id'].includes(f.key)) fail();
    if (!fieldTypes.some(type=>type===f.type) || typeof f.required !== 'boolean') fail();
    const field: Field = { key: f.key, label: text(f.label,60), type: f.type as Field['type'], required: f.required };
    if (field.type === 'select') {
      field.options = list(f.options,12).map(v => text(v,60));
      if (!field.options.length || new Set(field.options).size !== field.options.length) fail();
    } else if (f.options !== undefined) fail();
    return field;
  });
  const byKey = new Map(fields.map(f => [f.key, f]));
  if (!fields.length || byKey.size !== fields.length) fail();
  const columns = list(d.table_columns,12).map(v => { if (typeof v !== 'string' || !byKey.has(v)) fail(); return v; });
  if (!columns.length || new Set(columns).size !== columns.length) fail();
  const w = exactObject(d.workflow, ['trigger','rules']);
  if (w.trigger !== 'form.submitted') fail();
  const rules = list(w.rules,8).map(raw => {
    const r = exactObject(raw,['name','when','then']), when = exactObject(r.when,['field','operator','value']), then = exactObject(r.then,['field','value']);
    const source = byKey.get(String(when.field)), target = byKey.get(String(then.field));
    if (!source || !target || !ruleOperators.some(op=>op===when.operator)) fail();
    if (['gte','gt','lt','lte'].includes(String(when.operator)) && source.type !== 'number') fail();
    if (['contains','starts_with','ends_with'].includes(String(when.operator)) && !['text','textarea'].includes(source.type)) fail();
    return { name: text(r.name,80), when: { field: source.key, operator: when.operator as Rule['when']['operator'], value: scalar(source,when.value) }, then: { field: target.key, value: scalar(target,then.value) } };
  });
  const charts = d.charts === undefined ? undefined : list(d.charts,3).map(raw=>{
    const c=exactObject(raw,['key','title','type','group_by','metric','value_field']);
    if(typeof c.key!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(c.key)||['constructor','prototype','__proto__'].includes(c.key))fail();
    if(!['bar','line'].includes(String(c.type))||!['count','sum','average'].includes(String(c.metric)))fail();
    if(typeof c.group_by!=='string')fail();
    const group=byKey.get(c.group_by);
    if(!group||!['text','select','date','checkbox'].includes(group.type)||(c.type==='line'&&group.type!=='date'))fail();
    const chart:Chart={key:c.key,title:text(c.title,80),type:c.type as Chart['type'],group_by:group.key,metric:c.metric as Chart['metric']};
    if(c.metric==='count'){if(c.value_field!==undefined)fail();}
    else {if(typeof c.value_field!=='string'||byKey.get(c.value_field)?.type!=='number')fail();chart.value_field=c.value_field;}
    return chart;
  });
  if(charts&&new Set(charts.map(c=>c.key)).size!==charts.length)fail();
  const actions=d.actions===undefined?undefined:list(d.actions,2).map(raw=>{
   const a=exactObject(raw,['key','title','kind','fields','name_field','content_field','audience_tag_field']);
   if(typeof a.key!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(a.key)||['constructor','prototype','__proto__'].includes(a.key))fail();
   const title=text(a.title,60);
   if(a.kind==='http'){
    if(a.name_field!==undefined||a.content_field!==undefined||a.audience_tag_field!==undefined)fail();
    const keys=list(a.fields,12).map(v=>{if(typeof v!=='string'||!byKey.has(v))fail();return v;});
    if(!keys.length||new Set(keys).size!==keys.length)fail();return {key:a.key,title,kind:'http' as const,fields:keys};
   }
   if(a.kind!=='campaign'||a.fields!==undefined)fail();
   const field=(v:unknown)=>{if(typeof v!=='string'||!['text','textarea','select'].includes(byKey.get(v)?.type??''))fail();return v as string;};
   return {key:a.key,title,kind:'campaign' as const,name_field:field(a.name_field),content_field:field(a.content_field),...(a.audience_tag_field===undefined?{}:{audience_tag_field:field(a.audience_tag_field)})};
  });
  if(actions&&new Set(actions.map(a=>a.key)).size!==actions.length)fail();
  // Preserve old normalized definitions and hashes when charts is omitted.
  return { schema_version: 1, name: text(d.name,60), description: text(d.description,400), page: { title: text(p.title,80), description: text(p.description,400), columns: p.columns as 1|2, submit_label: text(p.submit_label,30) }, fields, table_columns: columns, workflow: { trigger: 'form.submitted', rules }, ...(charts===undefined?{}:{charts}),...(actions===undefined?{}:{actions}),...(code?{code}:{}),...(intent?{intent}:{}),...(workbench?{workbench}:{}),...(d.automation_preview?{automation_preview:validateAutomationPreview(d.automation_preview)}:{}) };
}
export function runExtension(rawDefinition: unknown, rawInput: unknown) {
  const definition = validateDefinition(rawDefinition);
  const input = exactObject(rawInput, definition.fields.map(f=>f.key));
  const data: Record<string,string|number|boolean> = {};
  for (const f of definition.fields) {
    const value = input[f.key];
    if (value === undefined || value === null || value === '') { if(f.required) throw new ExtensionError('required_field_missing'); continue; }
    data[f.key] = scalar(f,value);
  }
  // Conditions use the original validated input, never the output of another rule.
  // A bounded single pass cannot recursively trigger itself.
  const original = { ...data }, trace: { rule: string; matched: boolean; field: string }[] = [];
  for (const r of definition.workflow.rules) {
    const value = original[r.when.field];
    const matched = matchesCondition(value, r.when);
    if (matched) data[r.then.field] = r.then.value;
    trace.push({ rule: r.name, matched, field: r.then.field });
  }
  return { data, trace, external_effects: false as const };
}
function matchesCondition(value: string|number|boolean|undefined, when: Rule['when']): boolean {
  // An omitted optional field is not an inequality match.
  if (value === undefined) return false;
  switch (when.operator) {
    case 'equals': return value === when.value;
    case 'not_equals': return value !== when.value;
    case 'gte': return typeof value === 'number' && typeof when.value === 'number' && value >= when.value;
    case 'gt': return typeof value === 'number' && typeof when.value === 'number' && value > when.value;
    case 'lt': return typeof value === 'number' && typeof when.value === 'number' && value < when.value;
    case 'lte': return typeof value === 'number' && typeof when.value === 'number' && value <= when.value;
    case 'contains': return typeof value === 'string' && typeof when.value === 'string' && value.includes(when.value);
    case 'starts_with': return typeof value === 'string' && typeof when.value === 'string' && value.startsWith(when.value);
    case 'ends_with': return typeof value === 'string' && typeof when.value === 'string' && value.endsWith(when.value);
    default: return false;
  }
}
export function definitionHash(d: ExtensionDefinition) { return createHash('sha256').update(JSON.stringify(validateDefinition(d))).digest('hex'); }
export function canManageExtensions(auth: { auth_kind: string; role: string; impersonation_id?: string|null; session_scope?: string|null }) {
  return auth.auth_kind === 'console_session' && auth.role === 'tenant_admin' && !auth.impersonation_id && auth.session_scope === 'console';
}
