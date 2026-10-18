/** UI country prefix is decorative. Submit the domestic number, not +86. */
export function mainlandRegistrationPhone(value:unknown):string|undefined{
 if(typeof value!=='string')return undefined;
 const phone=value.trim();return /^1[3-9][0-9]{9}$/.test(phone)?phone:undefined;
}
