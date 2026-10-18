import type { Metadata } from "next";
import { LegalDocument, LegalSection } from "../../../components/legal-document";

export const metadata:Metadata={title:"答巢隐私政策｜ReplyNest",description:"了解答巢如何处理账号、客服会话、知识库及服务安全信息。",alternates:{canonical:"https://replynest.cn/legal/privacy",languages:{"zh-CN":"https://replynest.cn/legal/privacy",en:"https://replynest.cn/en/legal/privacy"}},robots:{index:true,follow:true}};

export default function PrivacyPage(){return <LegalDocument title="答巢隐私政策" version="2026-09-13-zh" alternateHref="/en/legal/privacy">
  <LegalSection title="一、运营主体与联系方式"><p>答巢 ReplyNest 服务由<strong>您的服务运营主体</strong>运营（以下简称“我们”）。注册地址：请填写您的服务运营地址。个人信息保护、账号注销、投诉与咨询邮箱：<a href="mailto:support@fs.replynest.cn" className="text-[var(--brand-700)]">support@fs.replynest.cn</a>。</p></LegalSection>
  <LegalSection title="二、适用范围与处理角色"><p>本政策适用于答巢官网、运营控制台及相关客服 SaaS 服务。对于企业管理员、成员和访客的账号与服务安全信息，我们依法决定处理目的和方式。企业使用答巢处理其客户会话、联系人和业务资料时，企业通常决定业务目的与规则，我们依照企业的合法指示提供受托技术处理；企业仍应向其客户履行必要告知并取得适用的处理依据。</p></LegalSection>
  <LegalSection title="三、我们处理的信息"><p>（1）账号与企业信息：企业名称、姓名或成员称呼、工作邮箱、中国大陆手机号、密码安全散列、验证状态、成员角色和工作区关系。</p><p>（2）渠道与业务内容：企业主动接入的公众号或社交账号标识、客户资料、会话与附件、评论、知识库文件、临时规则、订单查询字段，以及 AI 建议和人工反馈。具体范围取决于企业启用的功能。</p><p>（3）安全与运行信息：登录与操作时间、请求标识、设备和浏览器类型、网络地址及风险指纹、验证码结果、审计日志、错误和性能信息。密码、验证码及恢复令牌仅以必要的安全形式处理。</p><p>（4）交易与通知信息：套餐、订单、发票所需资料、不可变账务记录，以及企业配置的短信、邮件、浏览器推送和 Webhook 投递状态。</p></LegalSection>
  <LegalSection title="四、处理目的与依据"><p>我们在订立或履行服务合同所必需、履行法定义务、保障网络与账号安全、取得有效同意或法律允许的其他基础上，为创建账号、核验联系方式、提供渠道接入和客服协作、生成有依据的 AI 建议、执行权限与账务、发送必要服务通知、预防欺诈滥用、排障和审计而处理信息。</p><p>手机号和邮箱不会因完成注册验证而自动用于营销。营销消息、非必要个性化或其他需要同意的处理将另行说明，并提供拒绝或撤回方式。</p></LegalSection>
  <LegalSection title="五、AI 辅助处理"><p>企业启用 AI 功能后，答巢可将当前问题、企业知识、有效政策和必要的会话上下文提交给该企业配置或平台提供的模型适配器，用于生成建议、摘要或分类结果。默认由授权人员决定是否采用和发送；历史聊天只能作为表达参考，不会自动成为企业规则。我们会记录必要的模型、引用、规则版本和人工反馈，以便复核与改进。</p></LegalSection>
  <LegalSection title="六、委托处理、共享与公开"><p>为实现短信、邮件、云基础设施、支付、监控、验证码或 AI 能力，我们可能委托经过评估的服务商在约定目的和必要范围内处理信息，并通过合同、访问控制和最小权限约束其活动。除依法履行义务、取得适用授权、完成企业明确启用的功能或组织变更承接外，我们不会向无关第三方提供个人信息，也不会公开披露个人信息。</p><p>正式开放前，我们将根据实际上线的供应商和功能补充便于查阅的受托处理清单；未启用的能力不会仅因出现在清单中而自动获得数据。</p></LegalSection>
  <LegalSection title="七、Cookie 与本地存储"><p>我们使用必要的 Cookie 或同类技术维持登录会话、保存安全状态、完成验证码和防止跨站请求。非必要分析或营销技术如需启用，将另行提供选择。浏览器拒绝必要 Cookie 可能导致登录或安全功能无法工作。</p></LegalSection>
  <LegalSection title="八、保存期限"><p>我们按照实现各项处理目的所必要的最短期间保存信息，并结合账号存续、企业配置、争议处理、安全审计、备份轮换及法定义务确定期限。目的完成且无其他合法依据后，我们将删除或匿名化；备份中的删除会按安全轮换周期完成。</p></LegalSection>
  <LegalSection title="九、安全与事件响应"><p>我们采用传输加密、访问控制、凭据隔离、Tenant 数据隔离、日志脱敏、备份保护和重要操作审计等措施。互联网服务无法承诺绝对安全；发生或可能发生泄露、篡改或丢失时，我们将依法采取补救、评估风险并履行适用的通知义务。</p></LegalSection>
  <LegalSection title="十、您的权利与账号注销"><p>您可以依法请求查阅、复制、更正、补充或删除个人信息，撤回基于同意的处理、限制或拒绝特定处理，解释处理规则，或申请注销账号。请使用注册邮箱发送请求至上述联系邮箱；为保护账号，我们可能核验身份和企业授权。对于租户客户会话中的个人信息，我们会协助相应企业处理权利请求。</p></LegalSection>
  <LegalSection title="十一、未成年人"><p>本服务面向企业和获得企业授权的工作人员，不以未满十四周岁的未成年人为目标用户。企业不得在没有合法依据和适当保护措施的情况下通过答巢处理未成年人个人信息。</p></LegalSection>
  <LegalSection title="十二、政策更新"><p>本政策将持续以便于查阅和保存的方式提供。处理目的、方式或信息种类发生重大变化时，我们会以显著方式告知，并在法律要求时重新取得同意。旧版本接受记录不会被覆盖为对新版本的同意。</p></LegalSection>
</LegalDocument>}
