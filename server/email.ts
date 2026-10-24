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
   // The error `name` (e.g. `validation_error`, `missing_api_key`) is a stable, recipient-free enum
   // in the Resend API (`{statusCode, message, name}`), so it is safe to keep for operator guidance.
   let providerCode:string|null=null;
   try{
    const data=JSON.parse(await response.text());
    const name=data&&typeof data==='object'?(data as {name?:unknown}).name:null;
    if(typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,64}$/.test(name))providerCode=name;
   }catch{}
   throw Object.assign(new Error('Email provider refused the request.'),{status:response.status,providerCode});
  }
 };
}

/** Operator-actionable guidance for a failed delivery. Status codes and provider error names carry
 * no recipient or credential data, so this text is safe for logs, the review desk and /healthz. */
export function describeEmailFailure(status:number,providerCode:string|null):string{
 const code=(providerCode||'').toLowerCase();
 if(status===401||code==='missing_api_key'||code==='invalid_api_key')
  return 'The email provider rejected the API key (HTTP 401). Check SCOUT_EMAIL_API_KEY on the account service — recreate it in the Resend dashboard if it was rotated or deleted — then resend the invitation from the review desk.';
 if(status===403||code==='restricted_api_key'||code==='suspended_api_key')
  return 'The email provider refused the send (HTTP 403). The sender domain is usually not verified: verify it at resend.com/domains and send from an address on it. The onboarding@resend.dev test address only delivers to your own Resend account email.';
 if(status===400||status===422||code==='validation_error')
  return 'The email provider refused the message (validation). Usually the SCOUT_EMAIL_FROM sender or domain is not verified in Resend — verify the domain at resend.com/domains and use an address on it — or the recipient address is invalid.';
 if(status===429||code==='rate_limit_exceeded'||code==='rate_limited')
  return 'The email provider rate-limited delivery (HTTP 429). The outbox retries automatically with backoff; no action is needed unless it persists.';
 if(status>=500||status<=0)
  return 'The email provider had a transient problem, or could not be reached. The outbox retries automatically with backoff.';
 return `The email provider rejected the message (HTTP ${status}). Check the provider dashboard logs, fix the configuration, and resend from the review desk — delivery retries automatically.`;
}

/** Shared, image-independent transactional layout. Tables and inline styles work in email clients
 * that strip CSS; the plain-text alternative below carries the same action and security guidance. */
function accountEmailHtml({displayName,url,expiry,kind}:{displayName:string;url:string;expiry:string;kind:'invitation'|'recovery'}){
 const invitation=kind==='invitation';
 const name=escapeHtml(displayName||'SCOUT organiser'),link=escapeHtml(url),safeExpiry=escapeHtml(expiry);
 const title=invitation?'Your next great broadcast starts here.':'Let’s get you back in.';
 const preheader=invitation?'You’re approved for the SCOUT closed beta. Set your password to get started.':'A secure link to reset your SCOUT password. This link can only be used once.';
 const button=invitation?'Set your SCOUT password':'Reset your password';
 const guidance=invitation?'If you did not request SCOUT access, you can safely ignore this invitation.':'If you did not request this reset, you can safely ignore this email. Your password will not change.';
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${invitation?'Your SCOUT invitation':'Reset your SCOUT password'}</title></head>
<body style="margin:0;padding:0;background-color:#f3f0f5;font-family:Arial,Helvetica,sans-serif;color:#2b2432;-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;color:#f3f0f5;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f0f5"><tr><td align="center" style="padding:36px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;border-collapse:separate;">
<tr><td bgcolor="#17121e" style="padding:30px 32px;border-radius:12px 12px 0 0;border-bottom:3px solid #dd9acb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-size:30px;font-weight:bold;letter-spacing:-1.6px;color:#f5edf8;">scout<span style="color:#e8a7d4;">.</span></td><td align="right" style="font-size:9px;font-weight:bold;letter-spacing:1.8px;color:#d6b5d0;">${invitation?'CLOSED BETA':'ACCOUNT SECURITY'}</td></tr></table>
<p style="margin:28px 0 10px;font-size:10px;font-weight:bold;letter-spacing:2px;line-height:1.7;color:#e6acd5;">${invitation?'YOUR INVITATION IS HERE':'PASSWORD RECOVERY'}</p>
<h1 style="margin:0;max-width:410px;font-size:32px;line-height:1.2;font-weight:bold;letter-spacing:-.8px;color:#ffffff;">${title}</h1>
<p style="margin:16px 0 2px;font-size:13px;line-height:1.7;color:#c9b9d2;">The tools behind your next CS2 broadcast.</p>
</td></tr>
<tr><td bgcolor="#ffffff" style="padding:32px;border-left:1px solid #e7dfea;border-right:1px solid #e7dfea;">
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#302536;">Hello ${name},</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.8;color:#625569;">${invitation?'Your SCOUT closed-beta application has been approved. We’re glad to have you on board. Set your password to activate your account and take the first step toward your next broadcast.':'We received a request to reset the password for your SCOUT account. Use the secure button below to choose a new password and get back to your workspace.'}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#e5a2cf" style="border:1px solid #cf87b9;border-radius:6px;mso-padding-alt:16px 26px;"><a href="${link}" style="display:inline-block;padding:16px 26px;mso-padding-alt:0;font-size:14px;line-height:1.3;font-weight:bold;text-decoration:none;color:#29162a;border-radius:6px;">${button} &rarr;</a></td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;"><tr><td bgcolor="#f7f3f9" style="padding:18px 20px;border:1px solid #e8dfed;border-left:3px solid #c486b7;border-radius:4px;">
<p style="margin:0 0 6px;font-size:10px;letter-spacing:1px;font-weight:bold;color:#7d4d79;">ONE LINK. ONE USE.</p>
<p style="margin:0;font-size:12px;line-height:1.8;color:#625269;">For your security, this link can only be used once.<br>Expires <strong style="font-weight:bold;color:#3b2b45;">${safeExpiry}</strong>.</p>
</td></tr></table>
${invitation?`<h2 style="margin:28px 0 12px;font-size:14px;color:#35263f;">Your first steps with SCOUT</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="28" valign="top" style="padding:6px 0;font-size:12px;font-weight:bold;color:#9b5e91;">01</td><td style="padding:6px 0;font-size:13px;line-height:1.7;color:#625569;">Set your password and activate your account.</td></tr><tr><td width="28" valign="top" style="padding:6px 0;font-size:12px;font-weight:bold;color:#9b5e91;">02</td><td style="padding:6px 0;font-size:13px;line-height:1.7;color:#625569;">Sign in to download the SCOUT desktop app.</td></tr><tr><td width="28" valign="top" style="padding:6px 0;font-size:12px;font-weight:bold;color:#9b5e91;">03</td><td style="padding:6px 0;font-size:13px;line-height:1.7;color:#625569;">Create your tournament and make it broadcast-ready.</td></tr></table>`:''}
<p style="margin:28px 0 0;padding-top:22px;border-top:1px solid #eee7f1;font-size:11px;line-height:1.8;color:#7e6b88;">Button not working? Copy and paste this link into your browser:</p>
<p style="margin:8px 0 0;font-size:11px;line-height:1.8;word-break:break-all;overflow-wrap:anywhere;"><a href="${link}" style="color:#925484;text-decoration:underline;word-break:break-all;">${link}</a></p>
</td></tr>
<tr><td bgcolor="#faf7fc" style="padding:22px 32px;border:1px solid #e7dfea;border-top:0;border-radius:0 0 12px 12px;"><p style="margin:0;font-size:11px;line-height:1.8;color:#7e6b88;">${guidance} Keep this link private; the SCOUT team will never ask you to share your password.</p></td></tr>
<tr><td align="center" style="padding:24px 20px 0;"><p style="margin:0;font-size:11px;font-weight:bold;letter-spacing:1px;color:#6c5b77;">SCOUT &nbsp; / &nbsp; BUILT FOR BROADCAST</p><p style="margin:8px 0 0;font-size:10px;line-height:1.8;color:#8d7d96;">This is a transactional email about your SCOUT account.</p></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}
export function invitationEmail(to:string,displayName:string,url:string,expiresAt:number):OutboundEmail{
 const expiry=new Date(expiresAt).toUTCString();
 return {
  to,subject:'Your SCOUT closed-beta invitation',
  text:`Hello ${displayName||'SCOUT organiser'},\n\nYour SCOUT closed-beta application was approved. Welcome aboard! Set your password using this single-use link:\n${url}\n\nThe link expires ${expiry}.\n\nYour first steps:\n1. Set your password and activate your account.\n2. Sign in to download the SCOUT desktop app.\n3. Create your tournament and make it broadcast-ready.\n\nIf you did not request access, you can ignore this message. Keep this link private; the SCOUT team will never ask you to share your password.\n\nSCOUT — Built for broadcast\n`,
  html:accountEmailHtml({displayName,url,expiry,kind:'invitation'}),
 };
}
export function recoveryEmail(to:string,displayName:string,url:string,expiresAt:number):OutboundEmail{
 const expiry=new Date(expiresAt).toUTCString();
 return {
  to,subject:'Reset your SCOUT password',
  text:`Hello ${displayName||'SCOUT organiser'},\n\nWe received a request to reset your SCOUT password. Use this single-use link to choose a new password:\n${url}\n\nThe link expires ${expiry}. If you did not request a reset, ignore this message; your password will not change. Keep this link private; the SCOUT team will never ask you to share your password.\n\nSCOUT — Built for broadcast\n`,
  html:accountEmailHtml({displayName,url,expiry,kind:'recovery'}),
 };
}
function escapeHtml(value:string){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))}
