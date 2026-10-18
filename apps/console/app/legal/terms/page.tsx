import type { Metadata } from "next";
import { LegalDocument, LegalSection } from "../../../components/legal-document";

export const metadata:Metadata={title:"答巢服务协议｜ReplyNest",description:"答巢多渠道智能客服 SaaS 的账号、服务、AI、计费与责任规则。",alternates:{canonical:"https://replynest.cn/legal/terms",languages:{"zh-CN":"https://replynest.cn/legal/terms",en:"https://replynest.cn/en/legal/terms"}},robots:{index:true,follow:true}};

export default function TermsPage(){return <LegalDocument title="答巢服务协议" version="2026-09-13-zh" alternateHref="/en/legal/terms">
  <LegalSection title="一、缔约主体与协议范围"><p>本协议由使用答巢 ReplyNest 服务的企业或组织（“您”或“企业”）与<strong>您的服务运营主体</strong>订立。注册地址：请填写您的服务运营地址；联系邮箱：<a href="mailto:support@fs.replynest.cn" className="text-[var(--brand-700)]">support@fs.replynest.cn</a>。本协议适用于官网、运营控制台、多渠道客服及相关技术服务。</p></LegalSection>
  <LegalSection title="二、签约资格与企业授权"><p>注册人应具有完全民事行为能力并获得企业充分授权，有权代表企业接受本协议。您应提供真实、准确、完整且持续有效的企业和联系信息；授权或信息发生变化时应及时更新。我们可以在合理必要范围内要求补充企业资质或授权证明。</p></LegalSection>
  <LegalSection title="三、账号与成员管理"><p>账号仅限授权成员使用。企业管理员负责成员邀请、角色和工作区权限，应妥善保管密码、验证码、恢复码及第三方连接凭据，并及时移除离职或无需访问的成员。发现异常使用或凭据泄露时，应立即联系我们并采取重置等措施。</p></LegalSection>
  <LegalSection title="四、服务内容与第三方渠道"><p>答巢提供渠道接入、会话协作、客户资料、知识库、临时规则、AI 推荐、通知、运营与账务能力。实际功能、额度和支持范围以有效套餐权益快照、订单和控制台展示为准。微信、抖音、TikTok、支付、短信等第三方服务受其规则、审核、接口能力和可用性约束；我们不代表第三方作出授权或持续可用承诺。</p></LegalSection>
  <LegalSection title="五、AI 辅助边界"><p>AI 输出仅供授权人员参考，可能不完整、不准确或不适用于个案。除非企业另行开启并满足经校准阈值、允许意图、双重依据、熔断和审计门禁，系统不会自动向客户发送 AI 回复。企业应对最终发送文本、业务承诺和操作结果负责。RAG 提供依据，Policy Engine 判断规则是否适用，历史聊天不能自动成为企业规则。</p></LegalSection>
  <LegalSection title="六、企业数据与合规责任"><p>您保留对合法上传内容的相关权利，并授权我们仅在提供、维护和保护服务所必需范围内处理。您应确保数据来源、渠道授权、客户告知、营销触达和回复内容合法合规，不得上传无权处理的信息，不得发送垃圾消息、侵害他人权益、绕过平台限制、批量注册套取权益或从事违法活动。</p></LegalSection>
  <LegalSection title="七、套餐、订单与付款"><p>试用、赠送、邀请奖励、付费套餐及其座席、渠道、AI 和知识库额度，以活动规则、订单和不可变 Ledger 记录为准。正式价格、税费、付款周期、退款和发票规则将在购买前清晰展示。未经您单独、明确确认，我们不会开启自动续费；如以后提供自动续费，将在扣款前按适用规则提醒并提供便捷取消入口。</p></LegalSection>
  <LegalSection title="八、服务变更、暂停与终止"><p>为修复安全问题、遵守法律或第三方平台要求、处理严重滥用或欠费，我们可以在必要范围内限制相关能力，并保留审计记录；非紧急情形会尽合理努力提前通知。您可按控制台流程停止使用、导出可导出数据或申请注销。终止后我们将依隐私政策和法定义务处理留存与删除。</p></LegalSection>
  <LegalSection title="九、知识产权与反馈"><p>答巢软件、界面、商标、文档和通用模型编排能力的权利归我们或相应权利人所有。本协议不转让这些权利。您可以向我们提供建议；除非另有书面约定，我们可以无偿使用不包含您的保密信息和个人信息的产品反馈。</p></LegalSection>
  <LegalSection title="十、保密与安全"><p>双方应对在合作中获知的对方非公开商业、技术和客户信息采取合理保护措施，仅为履行本协议使用，法律要求披露的除外。我们会采取与风险相称的安全措施，但任何互联网服务均无法保证绝对无中断或无风险。</p></LegalSection>
  <LegalSection title="十一、可用性与责任"><p>测试和受控试用阶段不提供未书面约定的服务等级承诺。发生故障时双方应采取合理措施减少损失。任何免责、责任限制或赔偿约定均仅在适用法律允许范围内生效，不排除因故意或重大过失、侵害人身权益或法律规定不得限制的责任。正式商用责任上限如需设置，将在生效协议中以显著方式提示并结合已付服务费合理确定。</p></LegalSection>
  <LegalSection title="十二、协议变更与通知"><p>正式协议和重大变更会以便于查阅、保存的方式公示，并通过控制台、邮件或其他合理方式提示。对您有重大利害关系的条款将作显著提示并在需要时说明；我们不会仅以预先勾选代替有效确认。联系邮箱或控制台消息可作为日常服务通知渠道。</p></LegalSection>
  <LegalSection title="十三、法律适用与争议解决"><p>本协议适用中华人民共和国法律。争议应先友好协商；协商不成的，任何一方可依法向有管辖权的人民法院提起诉讼。法律对消费者、格式条款或管辖另有强制规定的，从其规定。</p></LegalSection>
  <LegalSection title="十四、版本与生效"><p>本模板自页面标注日期发布。企业通过注册、购买或其他明确方式确认接受时，本协议按照届时展示并由企业确认的版本对双方生效；我们保存企业接受的具体版本、时间和必要证据。未开放的自助注册入口不因此自动开放。</p></LegalSection>
</LegalDocument>}
