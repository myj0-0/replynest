import {Bot} from 'lucide-react';
import {CustomerAutomationControl} from './customer-automation-control';
import {automaticChannelNames,automaticModeStatusText,type ConversationAutomationSettings} from '../lib/automatic-reception';

/** Server-rendered read-only status. Failed reads never masquerade as disabled. */
export function WorkbenchAutomationStatus({settings,channel,humanAssigned=false,canManage,en,conversationId,tenantId}:{settings?:ConversationAutomationSettings;channel?:string;humanAssigned?:boolean;canManage:boolean;en:boolean;conversationId?:string;tenantId?:string}){
  const title=!settings?(en?'Reception status unavailable':'接待状态暂不可用'):settings.automatic_sending_enabled
    ?(en?'Automatic reception':'自动接待'):settings.ai_auto_reply_enabled?(en?'Automatic drafts':'自动草稿'):(en?'Agent assisted':'人工辅助');
  const activeHere=settings?.effective_automatic_sending&&automaticChannelNames(settings.automatic_authorized_channels)&&
    settings.automatic_authorized_channels?.includes(channel??'');
  return <section aria-label={en?'AI reception status':'AI 接待状态'} className="rounded-xl border border-blue-100 bg-blue-50 p-4">
    <h2 className="flex items-center gap-2 text-sm font-semibold text-blue-900"><Bot size={17}/>{title}</h2>
    <p className="mt-2 text-xs leading-5 text-blue-800">{settings?automaticModeStatusText(settings,en):
      (en?'Could not verify the current mode. Refresh to check; this does not mean automatic sending is off.':'暂时无法核实当前模式，请刷新查看；这不代表自动发送已关闭。')}</p>
    {settings?.automatic_sending_enabled&&<>
      <p className="mt-2 text-xs leading-5 text-blue-800">{en?'Authorized channels: ':'已授权渠道：'}{automaticChannelNames(settings.automatic_authorized_channels,en)||(en?'None':'尚未授权')}</p>
      {humanAssigned&&<p className="mt-2 text-xs leading-5 text-blue-800">{en?'Assignment does not pause AI reception. Use the customer’s timed pause control when needed.':'分配给人工不影响 AI 接待；需要时可对该客户限时暂停。'}</p>}
      {channel&&<p className="mt-2 text-xs leading-5 text-blue-800">{activeHere?
        (en?'Eligible replies in this channel may be sent automatically. Provider windows and quotas still apply.':'当前会话渠道可自动发送符合条件的答复，仍受渠道回复窗口与额度限制。'):
        (en?'Automatic sending is not active in this conversation’s channel; handle it manually.':'当前会话渠道未生效，请由客服人工处理。')}</p>}
    </>}
    {canManage&&<a href="/settings/communications" className="mt-3 inline-flex text-xs font-semibold text-blue-800 underline">{en?'Manage reception mode':'管理接待模式'}</a>}
    {conversationId&&tenantId&&settings?.automatic_sending_enabled&&<CustomerAutomationControl key={`${tenantId}:${conversationId}`} conversationId={conversationId} tenantId={tenantId} en={en}/>}
  </section>;
}
