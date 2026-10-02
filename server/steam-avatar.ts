// In-memory cache for Steam avatar URLs fetched by SteamID64.
// Resolves avatars via Steam Web API (if STEAM_API_KEY is configured)
// or via Steam's public miniprofile JSON (no API key needed).

const avatarCache = new Map<string, string>();
const pendingRequests = new Map<string, Promise<string | null>>();
const STEAM64_BASE = 76561197960265728n;

export async function fetchSteamAvatar(steamid64: string): Promise<string | null> {
 if (!steamid64 || !/^7656119\d{10}$/.test(steamid64)) return null;
 if (avatarCache.has(steamid64)) return avatarCache.get(steamid64) || null;
 if (pendingRequests.has(steamid64)) return pendingRequests.get(steamid64)!;

 const promise = (async () => {
  try {
   const apiKey = process.env.STEAM_API_KEY || process.env.STEAM_WEB_API_KEY;
   if (apiKey) {
    const res = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamid64}`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
     const data = await res.json() as any;
     const player = data?.response?.players?.[0];
     const url = player?.avatarfull || player?.avatarmedium || player?.avatar;
     if (url) {
      avatarCache.set(steamid64, url);
      return url;
     }
    }
   }

   // Fallback: public Steam miniprofile JSON (no API key needed)
   const accountId = (BigInt(steamid64) - STEAM64_BASE).toString();
   const res = await fetch(`https://steamcommunity.com/miniprofile/${accountId}/json`, {
    headers: {
     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    signal: AbortSignal.timeout(3000)
   });
   if (res.ok) {
    const data = await res.json() as any;
    const url = data?.avatar_url;
    if (url) {
     avatarCache.set(steamid64, url);
     return url;
    }
   }
  } catch {
   // Offline or network error
  }
  return null;
 })().finally(() => {
  pendingRequests.delete(steamid64);
 });

 pendingRequests.set(steamid64, promise);
 return promise;
}

export function getAllCachedAvatars(): Record<string, string> {
 return Object.fromEntries(avatarCache.entries());
}

export function getCachedAvatar(steamid64?: string): string | undefined {
 if (!steamid64) return undefined;
 return avatarCache.get(steamid64);
}
