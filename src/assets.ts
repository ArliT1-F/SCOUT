// Every stored asset path is same-origin: uploads/ and radars/ both live under the host root, so a
// leading slash keeps previews and outputs working regardless of which route renders them (/admin,
// /obs, /game). Absolute URLs and data: URLs pass through untouched.
export const assetUrl=(path?:string)=>!path?'':/^(https?:\/\/|\/|data:)/.test(path)?path:'/'+path;
