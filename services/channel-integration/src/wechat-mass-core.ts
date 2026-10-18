export function massTextPayload(openIds:string[],content:string,clientId:string) {
  const recipients=[...new Set(openIds)];
  if(recipients.length<2||recipients.length>10000||recipients.some(id=>!/^[A-Za-z0-9_-]{1,128}$/.test(id)))throw new Error('invalid_mass_recipients');
  if(!content.trim()||content.length>1000||Buffer.byteLength(content,'utf8')>4000)throw new Error('invalid_mass_content');
  if(!/^[a-f0-9]{32}$/.test(clientId))throw new Error('invalid_mass_client_id');
  return {touser:recipients,msgtype:'text',text:{content},clientmsgid:clientId};
}
export function massStatus(body:Record<string,unknown>,expectedId:string):'sending'|'succeeded'|'failed'|'deleted' {
  if(String(body.msg_id)!==expectedId)throw new Error('mass_receipt_mismatch');
  switch(body.msg_status){case 'SENDING':return 'sending';case 'SEND_SUCCESS':return 'succeeded';case 'SEND_FAIL':return 'failed';case 'DELETE':return 'deleted';default:throw new Error('unknown_mass_status');}
}
