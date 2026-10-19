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
