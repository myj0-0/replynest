export type AdminListQuery={q?:string;page?:string;status?:string;saved?:string;error?:string};
export type AdminListResult<T>={items:T[];page:number;has_more:boolean};
export function adminListQuery(query:AdminListQuery){
 const q=typeof query.q==='string'?query.q:'',status=typeof query.status==='string'?query.status:'open';
 const number=Number(query.page),page=Number.isInteger(number)&&number>0&&number<=10000?number:1;
 return {q,status,page,params:new URLSearchParams({q,status,page:String(page)}).toString()};
}
