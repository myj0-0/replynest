import assert from "node:assert/strict";
import test from "node:test";
import { statusPage } from "./status-page.mjs";
import vm from "node:vm";

test("renders stable Chinese and English status routes", () => {
  const chinese = statusPage("zh-CN");
  const english = statusPage("en");
  assert.match(chinese, /<html lang="zh-CN">/);
  assert.match(chinese, /href="\/en">English/);
  assert.match(english, /<html lang="en">/);
  assert.match(english, /All systems operational/);
  assert.match(english, /href="\/">简体中文/);
  assert.match(english, /hreflang="zh-CN"/);
  assert.match(chinese, /id="overall-chart"/);
  assert.match(chinese, /每日可用率图表/);
  assert.match(english, /System components/);
  assert.match(english, /Unobserved dates are shown as no data/);
});

function harness(locale = 'zh-CN') {
  class Element {
    constructor(tag) { this.tagName=tag;this.children=[];this.attributes={};this.events={};this.style={};this.dataset={};this.hidden=true;this.className='';this.textContent=''; }
    setAttribute(k,v){this.attributes[k]=v} removeAttribute(k){delete this.attributes[k]}
    append(...items){this.children.push(...items)} replaceChildren(...items){this.children=items}
    addEventListener(k,fn){this.events[k]=fn} focus(){document.activeElement=this;this.events.focus?.()}
    getBoundingClientRect(){return this.tagName==='tooltip'?{width:280,height:124}:{left:375,top:700,bottom:732,width:3}}
    get text(){return this.textContent+this.children.map(c=>c.text??c.textContent??'').join(' ')}
  }
  const tip=new Element('tooltip');tip.id='availability-tooltip';
  const document={activeElement:null,events:{},createElement:t=>new Element(t),createTextNode:text=>({text}),getElementById:()=>tip,addEventListener(k,fn){this.events[k]=fn}};
  const context={document,window:{innerWidth:390,innerHeight:844,addEventListener(){}},Intl};
  const script=statusPage(locale).match(/<script>([\s\S]*?)<\/script>/)[1].split('  async function refresh()')[0];
  vm.runInNewContext(script+';this.api={renderStrip,showDetail,hideDetail,pointClass};',context);
  return {...context,tip};
}
test('both languages use the existing brand icon and reduced-motion-safe hover feedback',()=>{
  for(const locale of ['zh-CN','en']){
    const html=statusPage(locale);assert.match(html,/<link rel="icon" type="image\/png" href="\/assets\/replynest-mark.png">/);
    assert.match(html,/\.bar:hover/);assert.match(html,/prefers-reduced-motion:reduce/);
    assert.match(html,/grid-template-columns:repeat\(90,minmax\(0,1fr\)\)/);
  }
});
test('hover animation changes decoration only, never the pointer target geometry',()=>{
  for(const locale of ['zh-CN','en']){
    const html=statusPage(locale),css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
    const rules=Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g));
    const animated=rules.filter(([,selectors,body])=>/transform\s*:/.test(body));
    assert.ok(animated.length>=2,'animated and reduced-motion decoration rules remain');
    for(const [,selectors] of animated){
      assert.ok(selectors.split(',').every(selector=>selector.trim().endsWith('::before')),'no animation may move the button hit area');
    }
    assert.match(css,/\.bar\{[^}]*position:relative/);
    assert.match(css,/\.bar::before\{[^}]*inset:0[^}]*pointer-events:none/);
    assert.match(css,/\.chart-tooltip\{[^}]*pointer-events:none/);
    assert.match(css,/\.bar:hover::before[^}]*translateY\(-3px\) scaleY\(1\.08\)/);
    assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.bar::before\{transition:none\}/);
  }
});
test('details remain open at the hit-area bottom and close only on a real pointer exit',()=>{
  const h=harness(),point={date:'2026-10-08',rate_percent:100,sample_count:840};
  const bar=h.api.renderStrip([point],true,'入站消息队列').children[0].children[0];
  const before=bar.getBoundingClientRect();bar.events.pointerenter();
  assert.deepEqual(bar.getBoundingClientRect(),before);
  assert.equal(h.tip.hidden,false);assert.equal(bar.attributes['aria-expanded'],'true');
  assert.match(h.tip.text,/2026-10-08 · UTC/);assert.match(h.tip.text,/840/);
  bar.events.pointerleave();assert.equal(h.tip.hidden,true);assert.equal(bar.attributes['aria-expanded'],'false');
  bar.focus();bar.events.pointerleave();assert.equal(h.tip.hidden,false,'keyboard focus retains its details');
  bar.events.blur();assert.equal(h.tip.hidden,true);
});
test('daily tooltip shows real UTC date, rate, samples and never treats missing history as normal',()=>{
  const h=harness();const point={date:'2026-10-07',rate_percent:99.5,sample_count:1440};
  const wrap=h.api.renderStrip([point,{date:'2026-08-01',rate_percent:null,sample_count:0}],false,'核心服务汇总');
  const [bar,empty]=wrap.children[0].children;assert.equal(bar.tagName,'button');bar.events.pointerenter();
  assert.equal(h.tip.hidden,false);assert.match(h.tip.text,/2026-10-07 · UTC/);assert.match(h.tip.text,/99.500%/);assert.match(h.tip.text,/1,440/);
  assert.match(h.tip.text,/可用率下降/);assert.equal(bar.attributes['aria-expanded'],'true');
  empty.events.click();assert.match(h.tip.text,/暂无数据/);assert.doesNotMatch(h.tip.text,/全天采样正常/);
  assert.equal(bar.attributes['aria-expanded'],'false');assert.ok(Number.parseFloat(h.tip.style.left)+280<=378);
});
test('keyboard arrows, Home, End and Escape work with one tab stop per chart',()=>{
  const h=harness('en'),points=[0,1,2].map(i=>({date:'2026-10-0'+(i+1),rate_percent:100,sample_count:100}));
  const strip=h.api.renderStrip(points,true,'AI text model').children[0];const bars=strip.children;
  assert.deepEqual(bars.map(b=>b.tabIndex),[0,-1,-1]);
  strip.events.keydown({key:'End',target:bars[0],preventDefault(){}});assert.equal(h.document.activeElement,bars[2]);assert.deepEqual(bars.map(b=>b.tabIndex),[-1,-1,0]);
  strip.events.keydown({key:'ArrowLeft',target:bars[2],preventDefault(){}});assert.equal(h.document.activeElement,bars[1]);
  strip.events.keydown({key:'Home',target:bars[1],preventDefault(){}});assert.equal(h.document.activeElement,bars[0]);
  assert.match(h.tip.text,/AI text model/);assert.match(h.tip.text,/Fully available/);
  h.document.events.keydown({key:'Escape'});assert.equal(h.tip.hidden,true);assert.equal(bars[0].attributes['aria-describedby'],undefined);
});
test('tooltip data is rendered as text, not injected HTML or fabricated incidents',()=>{
  const h=harness();const bar=h.api.renderStrip([{date:'<img onerror=attack()>',rate_percent:98,sample_count:5}],true,'<script>unsafe</script>').children[0].children[0];
  bar.events.click();assert.equal(h.tip.children[0].textContent,'<script>unsafe</script>');assert.equal(h.tip.children[1].textContent,'<img onerror=attack()> · UTC');
  assert.match(h.tip.text,/可用率低于 99%/);assert.ok(h.tip.children.every(n=>n.innerHTML===undefined));
});
