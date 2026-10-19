import path from 'node:path';
import { existsSync } from 'node:fs';
// Where the read-only half of an installation lives — the built panel in dist/.
//
// In a checkout nothing sets SCOUT_APP_ROOT, so the app root is the working directory and every
// path in the host is exactly what it always was (`npm run dev`, `npm start`, and the tests all
// run from the repository).
//
// The Windows installer splits the two halves, because a program directory under C:\Program Files
// is not writable while config/, public/uploads/ and recordings/ are written constantly:
//
//   program files  {app}\host\...        read-only, holds dist/, server/, node_modules/
//   data directory %APPDATA%\\SCOUT       the working directory the launcher sets: config/,
//                                        public/, recordings/ — everything the host writes
//
// Only dist/ is read from the app root. Every other path stays relative to the working directory,
// so the two halves are the same place in a checkout and a packaged install needs exactly this one
// indirection.
export const APP_ROOT=process.env.SCOUT_APP_ROOT?path.resolve(process.env.SCOUT_APP_ROOT):process.cwd();
export const appPath=(...parts:string[])=>path.join(APP_ROOT,...parts);
// Packaged installs keep operator-editable settings next to the host in %APPDATA%\SCOUT
// (the launchers working directory). Environment variables win when set, but a plain file
// written by the installer lets a closed-beta deployment enforce licensing without a shell
// wrapper. The same files are read by the launcher cmd and the shell's host-starter.
export function readInstalledEnv(name:string):string|undefined{
  if(process.env[name]?.trim()) return process.env[name]!.trim();
  // In a packaged install cwd is the data directory (%APPDATA%\SCOUT) with
  // beta_api_url.txt, require_licence.txt etc. In a checkoutcwd is the repo root,
  // which never contains those files, so this is a no-op.
  const mapping:Record<string,string>={
    SCOUT_BETA_API_URL:'beta_api_url.txt',
    SCOUT_BETA_API_KEY:'beta_api_key.txt',
    SCOUT_REQUIRE_LICENCE:'require_licence.txt',
    SCOUT_PLATFORM_URL:'platform_url.txt',
    SCOUT_PLATFORM_FILE:'platform_file.txt',
  };
  const file=mapping[name];
  if(!file) return undefined;
  try{
    const { readFileSync }=require('node:fs') as typeof import('node:fs');
    const value=readFileSync(file,'utf8').trim();
    return value||undefined;
  }catch{return undefined}
}
// Resolve the built panel directory. In a checkout `dist/` is at the repo root
// (APP_ROOT === cwd). In a packaged install the installer puts the panel at
// `{app}/host/dist` while SCOUT_APP_ROOT is `{app}` (the program-files root
// the shell and launcher both use). The smoke-test staging puts it at
// `stage/host/dist` with SCOUT_APP_ROOT === `stage/host`. Support all three
// so a missing dist/ shows a helpful error instead of a generic 500.
export function resolveDistDir(): string {
  const candidates = [appPath('dist'), appPath('host', 'dist')];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}
