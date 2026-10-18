export type WebhookDeliveryState={status:string;attempt_count:number;next_attempt_at?:string|null;error_code?:string|null};
export function webhookDeliveryLabel(delivery:WebhookDeliveryState,en:boolean){
 if(delivery.status==='pending'){
  if(delivery.error_code==='webhook_in_progress')return en?'Sending / awaiting confirmation':'投递中／待核对';
  return delivery.attempt_count>0?(en?'Waiting for automatic retry':'等待自动重试'):(en?'Queued for delivery':'排队待发送');
 }
 if(delivery.status==='failed'){
  const causes:Record<string,[string,string]>={webhook_provider_19021:['签名或时间戳校验失败','Signature or timestamp rejected'],webhook_provider_19022:['机器人 IP 白名单不符','Bot IP allowlist rejected'],webhook_provider_19024:['机器人关键词不符','Bot keyword rejected']};
  const cause=causes[delivery.error_code??''];
  return (en?'Automatic retries stopped':'已停止自动重试')+(cause?` · ${cause[en?1:0]}`:'');
 }
 const labels:Record<string,[string,string]>={delivered:['接收端已接受','Accepted by receiver'],suppressed:['未发送','Not sent'],dry_run:['仅模拟','Dry run']};
 return labels[delivery.status]?.[en?1:0]??delivery.status;
}
export function notificationActionResult(value:string,en:boolean){
 if(value==='test-queued')return {tone:'info',message:en?'Test queued. Refresh to check delivery; temporary failures retry automatically up to 5 total attempts. Do not send another test while pending.':'测试已排队，请刷新查看投递状态；临时失败自动重试，最多尝试 5 次。待完成期间不要重复发送测试。'};
 if(value==='test-unconfirmed')return {tone:'warning',message:en?'Submission could not be confirmed. Refresh to check the latest test before sending again.':'暂未确认测试是否提交，请先刷新核对最近测试，不要连续重发。'};
 if(value==='test-failed')return {tone:'error',message:en?'Test submission failed. Check the destination and try again after verifying its state.':'测试提交失败，请核对通知目标及状态后重试。'};
 if(value.endsWith('failed')||value==='invalid')return {tone:'error',message:en?'Action failed. Refresh to verify the current state.':'操作未成功，请刷新核对当前状态。'};
 return {tone:'success',message:en?'Notification action completed.':'通知操作已完成。'};
}
