import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('self-hosted feature overlay exposes read receipts without enabling them by default',()=>{
 assert.match(read('compose.features.yaml'),/WORKBENCH_READ_ENABLED:.*WORKBENCH_READ_ENABLED:-false/);
 assert.match(read('services/channel-integration/src/conversation-headless-api.ts'),/read_receipts_enabled:process.env.WORKBENCH_READ_ENABLED==='true'/);
 assert.match(read('apps/console/app/workbench/page.tsx'),/read_receipts_enabled===true&&!session.impersonation/);
});
test('both public home languages introduce separately authorized customer insights',()=>{
 for(const p of ['apps/console/app/home/page.tsx','apps/console/app/en/page.tsx'])assert.match(read(p),/<MarketingInsights/);
 const component=read('apps/console/components/marketing-insights.tsx');
 for(const text of ['默认关闭','单独授权','每日 AI 点数预算','人工备注不会被覆盖','不再次调用模型扣点','分类次数占比'])assert.ok(component.includes(text));
});
test('title covers support, insights and business automation without claiming unreleased channels',()=>{
 const home=read('apps/console/app/home/page.tsx');assert.ok(home.includes('答巢 ReplyNest｜AI 客服、客户洞察与业务自动化平台'));
 assert.ok(!home.includes('AI 只建议，不越权'));assert.ok(!read('apps/console/app/en/page.tsx').includes('TikTok customer service'));
});
