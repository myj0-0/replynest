import { createHmac, timingSafeEqual } from 'node:crypto';

/** Dedicated server-to-server bridge signature; unsigned native callbacks are refused. */
export function authenticateChatwootCallback(secret: string | undefined, timestamp: unknown,
  signature: unknown, body: Buffer, now = Date.now()): boolean {
  if (!secret || Buffer.byteLength(secret) < 32 || typeof timestamp !== 'string' ||
      !/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300_000 ||
      typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(timestamp).update('.').update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
}

export function canonicalChatwootCallback(payload: any, accountId: string, conversation: any, messages: any[]) {
  const id = String(payload?.id ?? '');
  const conversationId = String(payload?.conversation?.id ?? '');
  if (!/^[1-9]\d{0,18}$/.test(id) || !/^[1-9]\d{0,18}$/.test(conversationId) ||
      String(payload?.account?.id) !== accountId || String(conversation?.account_id) !== accountId ||
      String(conversation?.id) !== conversationId) throw new Error('chatwoot_callback_boundary');
  const message = messages.find(m => String(m.id) === id);
  if (!message || String(message.conversation_id) !== conversationId ||
      (message.account_id != null && String(message.account_id) !== accountId) ||
      ![1,'outgoing'].includes(message.message_type) || message.private !== false ||
      typeof message.content !== 'string' || !message.content.trim() || message.content.length > 10_000) {
    throw new Error('chatwoot_callback_message_unverified');
  }
  return {...message, event: 'message_created', account: {id: accountId}, conversation};
}
