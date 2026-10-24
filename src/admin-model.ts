import type {AccountView,InvitationDeliveryView} from '../server/beta';

export function matchesSearch(query:string,...values:(string|null|undefined)[]){
 const terms=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
 const text=values.filter(Boolean).join(' ').toLowerCase();
 return terms.every(term=>text.includes(term));
}
export function invitationState(app:Pick<AccountView,'status'>,invite?:InvitationDeliveryView,now=Date.now()){
 if(app.status!=='approved')return app.status==='pending'?'Awaiting review':'Not invited';
 if(invite?.activated)return 'Activated';
 if(invite?.status==='pending')return invite.errorCode?'Retry queued':'Email queued';
 if(invite?.expiresAt&&invite.expiresAt<=now)return 'Expired';
 return invite?.status==='sent'?'Invitation sent':'Not activated';
}
/** Quote every CSV cell and neutralize spreadsheet formulas in user-supplied data. */
export function csvDocument(headers:string[],rows:unknown[][]){
 const cell=(value:unknown)=>{
  let text=String(value??'');
  if(/^[\s\u0000-\u001f]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
 };
 return '\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
}
export function downloadCsv(name:string,headers:string[],rows:unknown[][]){
 const url=URL.createObjectURL(new Blob([csvDocument(headers,rows)],{type:'text/csv;charset=utf-8'}));
 const link=document.createElement('a');link.href=url;link.download=`scout-${name}-${new Date().toISOString().slice(0,10)}.csv`;
 document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
