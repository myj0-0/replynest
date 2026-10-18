import {copyFileSync,mkdirSync,existsSync,readFileSync} from 'node:fs';
const output=new URL('../static/img/',import.meta.url);mkdirSync(output,{recursive:true});
for(const name of ['replynest-brand-cn.png','replynest-mark.png']){
 const source=new URL('../../console/public/'+name,import.meta.url),target=new URL(name,output);
 if(existsSync(source))copyFileSync(source,target);
 // The isolated Docker build has already copied these assets into /site.
 if(!existsSync(target)||!readFileSync(target).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('brand_png_missing_or_invalid: '+name);
}
