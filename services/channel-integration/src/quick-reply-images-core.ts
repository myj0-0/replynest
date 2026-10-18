import {createHash} from 'node:crypto';
export const quickReplyImageEnabled=(env:NodeJS.ProcessEnv=process.env)=>env.QUICK_REPLY_IMAGES_ENABLED==='true';
export const isQuickReplyUuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
export function quickReplyPayload(body:Record<string,unknown>,enabled:boolean){
 if(Object.keys(body).some(k=>!['shortcut','title','content','image_asset_id'].includes(k)))throw Error('快捷回复包含未知字段');
 const image=body.image_asset_id??null;
 if(image!==null&&(!enabled||!isQuickReplyUuid(image)))throw Error('图片快捷回复尚未开放或素材无效');
 if(typeof body.content!=='string')throw Error('回复内容格式不正确');
 const content=body.content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim();
 if(content.length>4000||!content&&!image)throw Error('请填写文字或选择一张图片');
 return {content,image_asset_id:image};
}
export function quickReplyTransferId(tenant:string,conversation:string,key:string,asset:string,version:string){
 const hex=createHash('sha256').update(JSON.stringify(['quick-image-v1',tenant,conversation,key,asset,version])).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
