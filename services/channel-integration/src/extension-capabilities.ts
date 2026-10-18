// Public contract, deliberately contains no tenant data or provider credentials.
export const capabilityVersion = '2026-10-09.1';
export const fieldTypes = ['text','textarea','number','date','select','checkbox'] as const;
export const ruleOperators = ['equals','not_equals','gte','gt','lt','lte','contains','starts_with','ends_with'] as const;
export const capabilityCatalog = {
  version: capabilityVersion,
  app_schema_version: 1,
  limits: { fields:12, rules:8, charts:3, chart_groups:30, table_columns:12, select_options:12, page_columns:[1,2], records_per_app:1000 },
  capabilities: [
    {id:'ui.form',label:'单页表单及一/双列布局',status:'available'},
    {id:'ui.table',label:'应用内记录台账及列顺序',status:'available'},
    ...fieldTypes.map(type=>({id:`field.${type}`,label:`${type} 字段`,status:'available'})),
    ...ruleOperators.map(op=>({id:`rule.${op}`,label:`同条记录条件 ${op}`,status:'available'})),
    {id:'event.form_submitted',label:'表单提交触发',status:'available'},
    {id:'record.create',label:'新增本应用记录',status:'available'},
    {id:'record.set_field',label:'设置本次提交记录的字段',status:'available'},
    {id:'workbench.customer_context',label:'授权后手动读取当前客户字段（非生成器自动数据源）',status:'manual_only'},
    {id:'preview.rotation',label:'排班预览 · 授权后可启用定时转派',status:'preview_only'},
    {id:'preview.keyword_routing',label:'关键词分流预览 · 授权后可执行转派（文字匹配）',status:'preview_only'},
    {id:'ai.semantic_routing',label:'AI 语义识别分流规则 · 授权后识别并转派，消耗 AI 点数',status:'manual_only'},
    {id:'automation.plan_management',label:'人工绑定坐席、授权发布只读定时计划（不转派）',status:'manual_only'},
    {id:'automation.execute_plan',label:'管理员单次授权执行分流或轮班计划（需原子快照）',status:'manual_only'},
    {id:'conversation.assign',label:'规则计划真实转派（管理员明确授权）',status:'manual_only'},
    {id:'event.message_received',label:'公开客户消息触发已授权分流规则',status:'manual_only'},
    {id:'schedule.execute',label:'北京时间按周排班／分流定时转派（需持续执行授权）',status:'manual_only'},
    {id:'ai.classify_conversation',label:'授权后手动分类当前会话意图（不自动转派）',status:'manual_only'},
    {id:'ui.chart',label:'本应用版本记录的柱状图与日期折线图（数量/合计/平均）',status:'available'},
    {id:'ui.custom_workbench',label:'受控自定义工作台（布局、主题、业务表单和工具）',status:'available'},
    {id:'knowledge.read',label:'生成时读取管理员选定的企业知识库摘要（逐次授权）',status:'manual_only'},
    {id:'http.request',label:'固定公网 HTTPS 接口动作（限定字段、逐次确认）',status:'manual_only'},
    {id:'message.broadcast',label:'营销群发草稿工作流（专业版独立公众号、发送另审）',status:'manual_only'},
    {id:'payment.refund',label:'退款执行',status:'unavailable'},
    {id:'code.execute',label:'受限 JavaScript 业务计算（仅当前表单，无网络/数据库访问）',status:'available'},
    {id:'sql.execute',label:'任意 SQL 或宿主系统代码执行',status:'unavailable'},
  ],
  boundaries: ['Catalog is a capability inventory, NOT an authorization grant.', 'Manual workbench buttons and external API scopes do not grant generated workflows those capabilities.', 'Preview rules never execute against real conversations.'],
} as const;

export function appCapabilities(definition: {actions?:readonly {kind:string}[];intent?:unknown;workbench?:unknown;automation_preview?:{trigger:string;keywords:string[];semantic?:unknown};code?:unknown;charts?:readonly unknown[];fields:readonly {type:string}[];workflow:{rules:readonly {when:{operator:string}}[]}}) {
  return [...new Set(['ui.form','ui.table',...(definition.actions?.some(a=>a.kind==='http')?['http.request']:[]),...(definition.actions?.some(a=>a.kind==='campaign')?['message.broadcast']:[]),...(definition.automation_preview?.trigger==='message_received'?['event.message_received']:[]),...(definition.intent?['ai.classify_conversation']:[]),...(definition.workbench?['ui.custom_workbench']:[]),...(definition.automation_preview?.trigger==='weekly'?['preview.rotation']:[]),...(definition.automation_preview?.keywords.length?['preview.keyword_routing']:[]),...(definition.automation_preview?.semantic?['ai.semantic_routing']:[]),...(definition.code?['code.execute']:[]),...(definition.charts?.length?['ui.chart']:[]),'event.form_submitted','record.create',...definition.fields.map(f=>`field.${f.type}`),...definition.workflow.rules.flatMap(r=>[`rule.${r.when.operator}`,'record.set_field'])])].sort();
}

export function unsupportedLabels(ids: string[]) {
  return ids.map(id=>capabilityCatalog.capabilities.find(c=>c.id===id)?.label ?? id);
}
