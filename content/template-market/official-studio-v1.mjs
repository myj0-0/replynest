// Original examples. No real customer data, bindings, credentials or execution grants.
const base=(name,description)=>({schema_version:1,name,description,page:{title:name,description,columns:2,submit_label:'保存登记'},fields:[{key:'subject',label:'事项',type:'text',required:true}],table_columns:['subject'],workflow:{trigger:'form.submitted',rules:[]}});
const forms=base('售后业务表单与统计','演示全部字段类型、数字条件和业务图表；数据只来自本应用提交的记录。');
forms.fields=[{key:'subject',label:'事项',type:'text',required:true},{key:'detail',label:'说明',type:'textarea',required:false},{key:'amount',label:'金额',type:'number',required:true},{key:'date',label:'登记日期',type:'date',required:true},{key:'category',label:'类别',type:'select',required:true,options:['咨询','售后']},{key:'checked',label:'已核对',type:'checkbox',required:false},{key:'priority',label:'标记',type:'text',required:false}];
forms.table_columns=forms.fields.map(f=>f.key);
forms.workflow.rules=[['gte',500],['gt',1000],['lt',10],['lte',0]].map(([operator,value])=>({name:`金额 ${operator} ${value}`,when:{field:'amount',operator,value},then:{field:'priority',value:`命中 ${operator} ${value}`}}));
forms.charts=[{key:'categories',title:'各类事项数',type:'bar',group_by:'category',metric:'count'},{key:'daily',title:'每日金额',type:'line',group_by:'date',metric:'sum',value_field:'amount'},{key:'average',title:'类别平均金额',type:'bar',group_by:'category',metric:'average',value_field:'amount'}];
const strings=base('文本规则实验室','所有规则读取原始输入；后命中的规则可覆盖之前的标记。此例不读取聊天。');
strings.fields.push({key:'flag',label:'匹配结果',type:'text',required:false});strings.table_columns.push('flag');
strings.workflow.rules=[['equals','退款'],['not_equals','咨询'],['contains','退'],['starts_with','申请'],['ends_with','退款']].map(([operator,value])=>({name:`文字 ${operator}`,when:{field:'subject',operator,value},then:{field:'flag',value:`命中 ${operator}`}}));
const code=base('折扣报价计算器','计算示例不是对客价格承诺。脚本仅处理当前表单，发布前需模拟并确认。');
code.fields=[{key:'amount',label:'原金额',type:'number',required:true},{key:'discount',label:'折扣系数（0–1）',type:'number',required:true},{key:'quote',label:'计算报价',type:'number',required:false}];code.table_columns=['amount','discount','quote'];code.code={language:'javascript',source:'if (input.discount < 0 || input.discount > 1 || input.amount < 0) throw new Error("invalid_input"); return {...input, quote: Math.round(input.amount * input.discount * 100) / 100};'};
const desk=base('售后专属工作台与意图助手','发布并添加到工作台后选择此样式。单次授权分类，不自动转派。客户资料需单独选择字段授权，手动填入表单。');
desk.fields.push({key:'customer',label:'客户称呼（手动填入）',type:'text',required:false});desk.table_columns.push('customer');desk.intent={labels:['退款咨询','产品咨询','使用故障','订单查询']};desk.workbench={title:'售后专属工作台',theme:'violet',density:'compact',list_width:260,details_width:360,tools_position:'before_profile'};
const weekly=base('每周轮班与定时执行指南','先在模拟器中验证，再绑定本企业真实坐席；保存、只读计划、单次执行、定时执行分别确认。导入不启用任何任务。');
weekly.automation_preview={schema_version:1,name:'周一三五七 A / 周二四六 B（待绑定授权）',timezone:'Asia/Shanghai',trigger:'weekly',slots:[{weekdays:[1,3,5,7],time:'00:00',assignee_ref:'客服A'},{weekdays:[2,4,6],time:'00:00',assignee_ref:'客服B'}],keywords:[],assignee_ref:'',statuses:['open','pending'],overwrite_assigned:false,max_actions:20};
const keywords=base('关键词分流样本实验','只在手动合成样本中查找关键词，不是 AI 意图判断，也不启用真实消息触发。');
keywords.automation_preview={schema_version:1,name:'退款关键词（仅样本模拟）',timezone:'Asia/Shanghai',trigger:'manual_sample',slots:[],keywords:['退款','退货'],assignee_ref:'客服主管',statuses:['open','pending'],overwrite_assigned:false,max_actions:20};
export const examples=[
 {key:'form-charts',definition:forms,manual_capabilities:[],steps:'导入→模拟：填写事项、金额和日期→发布→提交记录→查看三种图表。'},
 {key:'text-rules',definition:strings,manual_capabilities:[],steps:'导入→输入“申请退款”模拟，观察 contains/starts_with/ends_with 命中。'},
 {key:'code-quote',definition:code,manual_capabilities:[],steps:'导入→金额100、折扣0.8模拟→报价80→确认脚本后发布。'},
 {key:'workbench-intent',definition:desk,manual_capabilities:['workbench.customer_context'],steps:'导入→模拟→发布→添加到工作台→顶部选择样式；右侧工具选择本应用，按需授权客户字段，或逐次确认意图分类。'},
 {key:'weekly',definition:weekly,manual_capabilities:['automation.plan_management','automation.execute_plan','conversation.assign','schedule.execute'],steps:'导入→打开轮班模拟→运行合成样本→保存为持久规则并绑定坐席→核对影响范围后选择只读计划或明确授权定时转派。'},
 {key:'keyword',definition:keywords,manual_capabilities:[],steps:'导入→打开样本模拟→更改样本文字验证命中与不命中；没有真实转派。'},
];
export const pack={id:'replynest-official-studio-v1',source_note:'答巢官方原创 AI 定制工坊示例。版本：official-studio-v1。由独立的答巢官方企业发布，经平台审核。',license_text:'答巢免费使用许可 v1：允许领取企业在自身业务中使用、复制和修改本模板，也可用于该企业的商业客户服务。原版或仅替换名称的副本不得作为独立商品转售；不得冒称原作者或声称答巢认可修改后的业务承诺。来源与许可记录应随导入保留。模板不构成企业已生效政策，具体价格、时效、资格及承诺须由企业核实；本说明不排除依法应承担的责任。'};
export function submissions(){return examples.map(e=>({key:e.key,payload:{title:'答巢官方 · '+e.definition.name,summary:e.steps,category:'general',kind:'studio',price_minor:0,source_note:pack.source_note,license_text:pack.license_text,rights_confirmed:true,content:[{title:e.definition.name,body:JSON.stringify(e.definition)}]}}));}
