export function unitEnvironment(source=process.env){
 const env={};
 for(const key of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LANG','LC_ALL']){
  if(source[key]!==undefined)env[key]=source[key];
 }
 return Object.assign(env,{POSTGRES_HOST:'127.0.0.1',POSTGRES_DATABASE:'synthetic_unit_only',POSTGRES_USERNAME:'synthetic',POSTGRES_PASSWORD:'synthetic-not-a-credential'});
}
