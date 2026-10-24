import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';

export interface OutboundEmail {to:string;subject:string;text:string;html:string}
export interface EncryptedEmail {ciphertext:string;iv:string;tag:string}
export type EmailTransport=(message:OutboundEmail,idempotencyKey:string)=>Promise<void>;
export interface EmailConfiguration {apiKey:string;from:string;publicBaseUrl:string;encryptionKey:Buffer;apiUrl:string}

/** Read and validate secret configuration without ever including secret values in errors/logs. */
export function emailConfiguration(env:NodeJS.ProcessEnv=process.env):EmailConfiguration|null{
 const apiKey=(env.SCOUT_EMAIL_API_KEY||'').trim();
 const from=(env.SCOUT_EMAIL_FROM||'').trim();
 const publicBaseUrl=(env.SCOUT_ACCOUNT_BASE_URL||env.RENDER_EXTERNAL_URL||'').trim().replace(/\/$/,'');
 const encodedKey=(env.SCOUT_EMAIL_ENCRYPTION_KEY||'').trim();
 const apiUrl=(env.SCOUT_EMAIL_API_URL||'https://api.resend.com/emails').trim();
 if(!apiKey||!from||!publicBaseUrl||!encodedKey)return null;
 let encryptionKey:Buffer;
 if(/^[0-9a-fA-F]{64}$/.test(encodedKey))encryptionKey=Buffer.from(encodedKey,'hex');
 else encryptionKey=Buffer.from(encodedKey,'base64');
 if(encryptionKey.length!==32)throw new Error('SCOUT_EMAIL_ENCRYPTION_KEY must encode exactly 32 random bytes (base64 or 64 hex characters).');
 let parsed:URL,provider:URL;
 try{parsed=new URL(publicBaseUrl)}catch{throw new Error('SCOUT_ACCOUNT_BASE_URL must be an absolute HTTPS URL.');}
 if(parsed.username||parsed.password||parsed.search||parsed.hash||(parsed.protocol!=='https:'&&!['localhost','127.0.0.1','::1'].includes(parsed.hostname)))
  throw new Error('SCOUT_ACCOUNT_BASE_URL must use HTTPS outside local development and must not contain credentials or a query.');
 try{provider=new URL(apiUrl)}catch{throw new Error('SCOUT_EMAIL_API_URL must be an absolute HTTPS URL (or a loopback URL for local development).');}
 if(provider.username||provider.password||provider.search||provider.hash||(provider.protocol!=='https:'&&!['localhost','127.0.0.1','::1'].includes(provider.hostname)))
  throw new Error('SCOUT_EMAIL_API_URL must use HTTPS except on loopback, and must not contain credentials or a query.');
 const senderAddress=/^\s*[^<>]*<([^<>]+)>\s*$/.exec(from)?.[1]||from;
 if(/[\r\n]/.test(from)||!/^\S+@\S+$/.test(senderAddress))throw new Error('SCOUT_EMAIL_FROM must be a valid sender address, optionally with a display name.');
 return {apiKey,from,publicBaseUrl,encryptionKey,apiUrl:provider.toString()};
}

export function sealEmail(message:OutboundEmail,key:Buffer):EncryptedEmail{
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(message),'utf8'),cipher.final()]);
 return {ciphertext:ciphertext.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function openEmail(encrypted:EncryptedEmail,key:Buffer):OutboundEmail{
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(encrypted.iv,'base64'));
 decipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));
 const plaintext=Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext,'base64')),decipher.final()]).toString('utf8');
 const parsed=JSON.parse(plaintext);
 if(!parsed||typeof parsed.to!=='string'||typeof parsed.subject!=='string'||typeof parsed.text!=='string'||typeof parsed.html!=='string')
  throw new Error('Encrypted outbound message has an invalid shape.');
 return parsed as OutboundEmail;
}

/** Real Resend HTTP delivery. Tests may inject an isolated transport; production always uses this. */
export function resendTransport(config:EmailConfiguration,fetchImpl:typeof fetch=fetch):EmailTransport{
 return async(message,idempotencyKey)=>{
  const response=await fetchImpl(config.apiUrl,{
   method:'POST',signal:AbortSignal.timeout(15_000),
   headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},
   body:JSON.stringify({from:config.from,to:[message.to],subject:message.subject,text:message.text,html:message.html}),
  });
  if(!response.ok){
   // Never retain or log the provider response body: some providers echo recipient/template data.
   throw Object.assign(new Error('Email provider refused the request.'),{status:response.status});
  }
 };
}

export function invitationEmail(to:string,displayName:string,url:string,expiresAt:number):OutboundEmail{
 const expiry=new Date(expiresAt).toUTCString();
 const safeName=escapeHtml(displayName||'SCOUT organiser');
 return {
  to,subject:'Your SCOUT closed-beta invitation',
  text:`Hello ${displayName||'SCOUT organiser'},\n\nYour SCOUT closed-beta application was approved. Set your password using this single-use link:\n${url}\n\nThe link expires ${expiry}. If you did not request access, you can ignore this message.\n`,
  html:`<p>Hello ${safeName},</p><p>Your SCOUT closed-beta application was approved. Set your password using this single-use link:</p><p><a href="${escapeHtml(url)}">Set your SCOUT password</a></p><p>The link expires ${escapeHtml(expiry)}. If you did not request access, you can ignore this message.</p>`,
 };
}
export function recoveryEmail(to:string,displayName:string,url:string,expiresAt:number):OutboundEmail{
 const expiry=new Date(expiresAt).toUTCString(),safeName=escapeHtml(displayName||'SCOUT organiser');
 return {
  to,subject:'Reset your SCOUT password',
  text:`Hello ${displayName||'SCOUT organiser'},\n\nUse this single-use link to reset your SCOUT password:\n${url}\n\nThe link expires ${expiry}. If you did not request a reset, ignore this message; your password will not change.\n`,
  html:`<p>Hello ${safeName},</p><p>Use this single-use link to reset your SCOUT password:</p><p><a href="${escapeHtml(url)}">Reset your SCOUT password</a></p><p>The link expires ${escapeHtml(expiry)}. If you did not request a reset, ignore this message; your password will not change.</p>`,
 };
}
function escapeHtml(value:string){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))}
