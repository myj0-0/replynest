import {pool} from './database.js';
import {recordProviderPaymentEvent} from './payment-order.js';
import type {AlipayVerifiedPayment} from './alipay-provider.js';
import {randomUUID} from 'node:crypto';
export async function recordAlipaySettlement(payment:AlipayVerifiedPayment) {
  const found=await pool.query(`SELECT tenant_id,payment_order_id FROM payment_orders WHERE provider='alipay' AND order_number=$1`,[payment.orderNumber]);
  if(found.rows.length!==1)throw new Error('alipay_order_unknown');
  const order=found.rows[0];
  await recordProviderPaymentEvent(order.tenant_id,order.payment_order_id,'alipay',{provider_event_id:payment.eventId,event_type:'payment_succeeded',amount_minor:payment.amountMinor,currency:'CNY',occurred_at:payment.paidAt,provider_order_id:payment.tradeNumber},{actor_id:'alipay-notify',request_id:randomUUID()});
}
