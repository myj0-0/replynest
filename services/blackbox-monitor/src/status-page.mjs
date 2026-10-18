export function statusPage(locale = "zh-CN") {
  const english = locale === "en";
  const copy = english ? {
    lang: "en",
    title: "ReplyNest · Service Status",
    checking: "Checking",
    heading: "Service status",
    loading: "Fetching the latest status from the independent monitoring node in Japan.",
    history: "Availability over the past 90 days",
    historyLoading: "Availability uses sustained incidents confirmed by consecutive external probes. A single network jitter is retained for diagnostics but is not marked as downtime.",
    refresh: "Refreshes every 30 seconds. This page runs independently from the application servers.",
    alternate: "简体中文",
    alternateHref: "/",
    locale: "en-US",
    noData: "No data",
    dayAgo: "90 days ago",
    today: "Today",
  } : {
    lang: "zh-CN",
    title: "答巢 ReplyNest · 服务状态",
    checking: "正在检查",
    heading: "服务状态",
    loading: "正在从日本独立监控节点获取最新状态。",
    history: "过去 90 天可用率",
    historyLoading: "可用率按外部探针连续失败确认的真实中断统计；单次网络抖动仅用于内部诊断，不直接标记为服务中断。",
    refresh: "每 30 秒自动刷新。本页与业务应用位于不同节点。",
    alternate: "English",
    alternateHref: "/en",
    locale: "zh-CN",
    noData: "暂无数据",
    dayAgo: "90 天前",
    today: "今天",
  };

  return `<!doctype html>
<html lang="${copy.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${copy.title}</title>
  <link rel="icon" type="image/png" href="/assets/replynest-mark.png">
  <link rel="apple-touch-icon" href="/assets/replynest-mark.png">
  <link rel="canonical" href="https://status.replynest.cn/${english ? "en" : ""}">
  <link rel="alternate" hreflang="zh-CN" href="https://status.replynest.cn/">
  <link rel="alternate" hreflang="en" href="https://status.replynest.cn/en">
  <style>
    :root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#132238;background:#f5f8fc}
    *{box-sizing:border-box}body{margin:0}.wrap{width:min(920px,calc(100% - 32px));margin:0 auto;padding:48px 0 72px}
    .top{display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{display:inline-block;border-radius:8px}.brand img{display:block;width:220px;height:48px;object-fit:cover;object-position:center 51%}
    .lang{padding:8px 12px;border:1px solid #cbd8e7;border-radius:10px;color:#31506f;background:#fff;text-decoration:none;font-size:13px;font-weight:650}
    .hero{margin-top:48px;padding:30px;border:1px solid #dce5ef;border-radius:22px;background:#fff;box-shadow:0 12px 36px rgba(25,55,90,.06)}
    h1{margin:12px 0 8px;font-size:clamp(26px,5vw,38px)}.summary{color:#607086}.badge{display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border-radius:999px;font-size:13px;font-weight:700}.dot{width:8px;height:8px;border-radius:50%;background:currentColor}
    .operational{color:#087a55;background:#e9f8f2}.degraded{color:#a05a00;background:#fff3d9}.major_outage{color:#b42318;background:#feeceb}
    .history{margin-top:22px;padding:22px;border:1px solid #dce5ef;border-radius:18px;color:#607086;background:#fff}.history-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.history strong{color:#132238}.uptime{font-size:28px;font-weight:750;color:#087a55}.history-note{margin:5px 0 0;font-size:13px;line-height:1.7}
    .strip{display:grid;grid-template-columns:repeat(90,minmax(0,1fr));gap:3px;height:38px;margin-top:18px}.bar{appearance:none;position:relative;display:block;width:100%;height:100%;min-width:0;padding:0;border:0;border-radius:4px;background:transparent;cursor:pointer}
    /* Keep the pointer target stationary; only the non-interactive decoration moves. */
    .bar::before{content:"";position:absolute;inset:0;border-radius:inherit;background:#d9e2ec;pointer-events:none;transition:transform 160ms ease,background-color 160ms ease,box-shadow 160ms ease;transform-origin:center}.bar.ok::before{background:#23a36d}.bar.warn::before{background:#e8a317}.bar.down::before{background:#d9473f}
    .bar:hover::before,.bar:focus-visible::before,.bar[aria-expanded="true"]::before{background:#b6c5d8;transform:translateY(-3px) scaleY(1.08);box-shadow:0 3px 8px rgba(19,34,56,.18)}.bar.ok:hover::before,.bar.ok:focus-visible::before,.bar.ok[aria-expanded="true"]::before{background:#148353}.bar.warn:hover::before,.bar.warn:focus-visible::before,.bar.warn[aria-expanded="true"]::before{background:#c78209}.bar.down:hover::before,.bar.down:focus-visible::before,.bar.down[aria-expanded="true"]::before{background:#b8322b}.bar:focus-visible{outline:2px solid #1687f8;outline-offset:3px}
    .chart-tooltip{position:fixed;z-index:20;width:280px;max-width:calc(100vw - 24px);padding:14px 16px;border:1px solid #dce5ef;border-radius:12px;background:#fff;color:#132238;box-shadow:0 10px 28px rgba(19,34,56,.16);pointer-events:none;font-size:13px;line-height:1.65}.chart-tooltip[hidden]{display:none}.tooltip-title{font-weight:700}.tooltip-date{color:#607086;margin:2px 0 8px}.tooltip-status{display:flex;align-items:center;gap:7px;font-weight:650}.tooltip-status i{width:8px;height:8px;border-radius:50%;background:#d9e2ec}.tooltip-status.ok i{background:#23a36d}.tooltip-status.warn i{background:#e8a317}.tooltip-status.down i{background:#d9473f}.tooltip-metrics{display:flex;flex-wrap:wrap;gap:2px 16px;margin-top:7px;color:#607086}
    @media(prefers-reduced-motion:reduce){.bar::before{transition:none}.bar:hover::before,.bar:focus-visible::before,.bar[aria-expanded="true"]::before{transform:none}}
    .axis,.legend{display:flex;justify-content:space-between;gap:12px;margin-top:7px;color:#7a899d;font-size:11px}.legend{justify-content:flex-end;flex-wrap:wrap}.legend span{display:inline-flex;align-items:center;gap:5px}.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;background:#d9e2ec}.legend .ok i{background:#23a36d}.legend .warn i{background:#e8a317}.legend .down i{background:#d9473f}
    .components-title{margin:30px 2px 10px;font-size:18px;color:#132238}.components{border:1px solid #dce5ef;border-radius:18px;background:#fff;overflow:hidden}.row{padding:18px 20px;border-bottom:1px solid #e7edf4}.row:last-child{border-bottom:0}.row-top{display:flex;align-items:center;justify-content:space-between;gap:16px}.name{font-weight:650}.meta{margin-top:4px;font-size:12px;color:#75849a}.mini-strip{height:20px;margin-top:13px;gap:2px}.foot{margin-top:22px;color:#75849a;font-size:13px;line-height:1.7}
    @media(max-width:620px){.wrap{padding-top:24px}.brand img{width:172px;height:40px}.hero{margin-top:30px;padding:22px}.history-head,.row-top{align-items:flex-start;flex-direction:column}.strip{gap:1px;height:32px}.mini-strip{height:18px}.badge{align-self:flex-start}}
  </style>
</head>
<body>
<main class="wrap">
  <div class="top"><a class="brand" href="https://replynest.cn/" aria-label="ReplyNest home"><img src="/assets/replynest-brand-cn.png" alt="答巢 ReplyNest" width="220" height="48"></a><a class="lang" data-locale="${english ? "zh-CN" : "en"}" href="${copy.alternateHref}">${copy.alternate}</a></div>
  <section class="hero"><span id="overall" class="badge degraded"><i class="dot"></i>${copy.checking}</span><h1>${copy.heading}</h1><p id="summary" class="summary">${copy.loading}</p></section>
  <section class="history"><div class="history-head"><div><strong>${copy.history}</strong><p id="history-note" class="history-note">${copy.historyLoading}</p></div><div id="uptime" class="uptime">--</div></div><div id="overall-chart"></div><div class="legend"><span class="ok"><i></i>${english ? "Operational" : "正常"}</span><span class="warn"><i></i>${english ? "Degraded" : "降级"}</span><span class="down"><i></i>${english ? "Outage" : "故障"}</span><span><i></i>${copy.noData}</span></div></section>
  <h2 class="components-title">${english ? "System components" : "系统组件"}</h2><section id="components" class="components"></section><p class="foot">${copy.refresh}</p>
</main>
<div id="availability-tooltip" class="chart-tooltip" role="tooltip" hidden></div>
<script>
  const english=${english ? "true" : "false"};
  const copy=${JSON.stringify(copy)};
  const labels=english?{operational:'All systems operational',degraded:'Partial service degradation',major_outage:'Major service outage'}:{operational:'全部系统运行正常',degraded:'部分服务性能下降',major_outage:'关键服务不可用'};
  const componentLabels=english?{operational:'Operational',degraded:'Degraded',major_outage:'Unavailable'}:{operational:'运行正常',degraded:'性能下降',major_outage:'不可用'};
  const componentNames=english?{ai_text:'AI text model (5-minute probes)',ai_embedding:'AI embedding model (5-minute probes)',console:'Operations console',gateway:'Messaging and business API',chatwoot:'Agent workspace',wechat_callback:'WeChat Official Account',inbound_queue:'Inbound message queue',payment_projection:'Payments and billing',website:'Public website',tls:'HTTPS certificates and domains'}:{};
  if(english)componentNames.automation='Automation scheduling and database pressure';
  function badge(status,text){const element=document.createElement('span');element.className='badge '+status;element.innerHTML='<i class="dot"></i>';element.append(document.createTextNode(text));return element}
  function rate(value){return value&&value.rate_percent!==null?value.rate_percent.toFixed(3).replace(/\\.0+$/,'')+'%':'--'}
  function pointClass(point){if(!point||point.rate_percent===null)return'';if(point.rate_percent===100)return'ok';if(point.rate_percent>=99)return'warn';return'down'}
  const tooltip=document.getElementById('availability-tooltip');
  let activeBar=null;
  function hideDetail(){if(activeBar){activeBar.setAttribute('aria-expanded','false');activeBar.removeAttribute('aria-describedby')}activeBar=null;tooltip.hidden=true}
  function dayStatus(point){const state=pointClass(point);return english?({ok:'Fully available',warn:'Reduced availability',down:'Availability below 99%'}[state]||copy.noData):({ok:'全天采样正常',warn:'可用率下降',down:'可用率低于 99%'}[state]||copy.noData)}
  function showDetail(bar,point,context){
    hideDetail();activeBar=bar;bar.setAttribute('aria-expanded','true');bar.setAttribute('aria-describedby',tooltip.id);
    const title=document.createElement('div'),date=document.createElement('div'),status=document.createElement('div'),dot=document.createElement('i'),metrics=document.createElement('div');
    title.className='tooltip-title';title.textContent=context;date.className='tooltip-date';date.textContent=point.date+' · UTC';status.className='tooltip-status '+pointClass(point);status.append(dot,document.createTextNode(dayStatus(point)));metrics.className='tooltip-metrics';
    for(const text of [(english?'Availability: ':'可用率：')+(point.rate_percent===null?copy.noData:rate(point)),(english?'Qualified samples: ':'有效采样：')+Number(point.sample_count||0).toLocaleString(copy.locale)]){const item=document.createElement('span');item.textContent=text;metrics.append(item)}
    tooltip.replaceChildren(title,date,status,metrics);tooltip.hidden=false;tooltip.style.left='0px';tooltip.style.top='0px';
    const anchor=bar.getBoundingClientRect(),box=tooltip.getBoundingClientRect(),left=Math.max(12,Math.min(anchor.left+anchor.width/2-box.width/2,window.innerWidth-box.width-12));
    let top=anchor.bottom+12;if(top+box.height>window.innerHeight-12)top=anchor.top-box.height-12;
    tooltip.style.left=left+'px';tooltip.style.top=Math.max(12,Math.min(top,window.innerHeight-box.height-12))+'px';
  }
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hideDetail()});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('.bar'))hideDetail()});
  window.addEventListener('resize',hideDetail);window.addEventListener('scroll',hideDetail,true);
  function renderStrip(points,mini=false,context=english?'Core services overview':'核心服务汇总'){
    const wrap=document.createElement('div'),strip=document.createElement('div');strip.className='strip'+(mini?' mini-strip':'');strip.setAttribute('role','group');strip.setAttribute('aria-label',context+' · '+(english?'Daily availability chart, use arrow keys to choose a day':'每日可用率图表，可用方向键选择日期'));
    for(const [index,point] of (points||[]).entries()){
      const bar=document.createElement('button');bar.type='button';bar.className='bar '+pointClass(point);bar.tabIndex=index===0?0:-1;bar.dataset.date=point.date;bar.setAttribute('aria-expanded','false');
      bar.setAttribute('aria-label',context+' · '+point.date+' UTC · '+dayStatus(point)+' · '+(point.rate_percent===null?copy.noData:rate(point))+' · '+Number(point.sample_count||0)+(english?' qualified samples':' 次有效采样'));
      bar.addEventListener('pointerenter',()=>showDetail(bar,point,context));bar.addEventListener('pointerleave',()=>{if(document.activeElement!==bar)hideDetail()});bar.addEventListener('focus',()=>showDetail(bar,point,context));bar.addEventListener('blur',hideDetail);bar.addEventListener('click',()=>showDetail(bar,point,context));strip.append(bar);
    }
    strip.addEventListener('keydown',event=>{const bars=Array.from(strip.children),index=bars.indexOf(event.target);if(index<0)return;const next=event.key==='ArrowRight'?Math.min(index+1,bars.length-1):event.key==='ArrowLeft'?Math.max(index-1,0):event.key==='Home'?0:event.key==='End'?bars.length-1:null;if(next===null)return;event.preventDefault();for(const bar of bars)bar.tabIndex=-1;bars[next].tabIndex=0;bars[next].focus()});
    wrap.append(strip);if(!mini){const axis=document.createElement('div');axis.className='axis';axis.innerHTML='<span>'+copy.dayAgo+'</span><span>'+copy.today+'</span>';wrap.append(axis)}return wrap
  }
  async function refresh(){try{hideDetail();const response=await fetch('/api/v1/status',{cache:'no-store'});if(!response.ok)throw new Error('status '+response.status);const data=await response.json(),overall=document.getElementById('overall');overall.className='badge '+data.status;overall.replaceChildren(Object.assign(document.createElement('i'),{className:'dot'}),document.createTextNode(labels[data.status]));document.getElementById('summary').textContent=english?(data.status==='operational'?'No issues affecting the service have been detected.':'External monitoring has detected a service issue or degradation.'):(data.status==='operational'?'我们目前未发现影响系统使用的问题。':'外部监控检测到服务异常或降级。');document.getElementById('uptime').textContent=rate(data.availability_90d);const availability=data.availability_90d;document.getElementById('history-note').textContent=copy.historyLoading+(availability&&availability.monitoring_since?(english?' Monitoring began '+availability.monitoring_since+'. Unobserved dates are shown as no data.':' 统计始于 '+availability.monitoring_since+'，此前日期显示为暂无数据。'):'');document.getElementById('overall-chart').replaceChildren(renderStrip(data.availability_daily));const list=document.getElementById('components');list.replaceChildren();for(const item of data.components){const row=document.createElement('div'),top=document.createElement('div'),text=document.createElement('div'),name=document.createElement('div'),meta=document.createElement('div');row.className='row';top.className='row-top';name.className='name';name.textContent=componentNames[item.id]||item.name;meta.className='meta';const checked=new Date(data.checked_at).toLocaleString(copy.locale);meta.textContent=english?'Last checked '+checked+' · '+item.latency_ms+' ms · 90-day '+rate(item.availability_90d):'最近检查 '+checked+' · '+item.latency_ms+' ms · 90天 '+rate(item.availability_90d);text.append(name,meta);top.append(text,badge(item.status,componentLabels[item.status]));row.append(top,renderStrip(item.availability_daily||[],true,name.textContent));list.append(row)}}catch{document.getElementById('summary').textContent=english?'Status data is temporarily unavailable. Please refresh later.':'暂时无法取得状态数据，请稍后刷新。'}}
  refresh();setInterval(refresh,30000);
</script>
</body>
</html>`;
}
