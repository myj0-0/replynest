export type CustomerAutomationControl={operation:'pause'|'resume';minutes:0|10;revision:string};
export function validateCustomerAutomationControl(value:unknown):CustomerAutomationControl|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='minutes,operation,revision'||typeof v.revision!=='string'||!/^\d{1,19}$/.test(v.revision)||BigInt(v.revision)>9223372036854775806n)return null;
 if(v.operation==='pause'&&v.minutes===10||v.operation==='resume'&&v.minutes===0)return v as CustomerAutomationControl;
 return null;
}
