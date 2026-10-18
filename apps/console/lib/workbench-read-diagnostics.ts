// Diagnostic identifiers never confer authority. No content, credentials, tenant
// identity or arbitrary upstream headers are included in diagnostic metadata.
export const readAttemptHeader='x-replynest-read-attempt';
export function safeReadAttempt(value:unknown):string|undefined{
 return typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)?value.toLowerCase():undefined;
}
export function safeReadTiming(value:string|null){
 return (value??'').split(',').flatMap(part=>{
  const m=part.trim().match(/^(session|body|mapping|seat|native|gateway|gateway_roundtrip|console);dur=(\d+(?:\.\d+)?)$/);
  return m&&Number(m[2])<=120000?[`${m[1]};dur=${Math.round(Number(m[2]))}`]:[];
 }).slice(0,8).join(', ');
}
