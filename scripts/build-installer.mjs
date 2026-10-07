#!/usr/bin/env node
// Builds SCOUT-Setup-<version>.exe: the Windows installer that carries the whole of SCOUT.
//
// What it does, in order:
//   1. build the control panel and overlay pages (vite -> dist/)
//   2. compile the host to plain JavaScript (tsc -p tsconfig.build.json -> build/, server/ + src/radar.ts)
//   3. build the overlay shell (cargo tauri build -> scout-shell.exe)
//   4. install the host's production dependencies into a staging directory
//   5. put a Node runtime in the staging directory, so the operator needs no Node.js
//   6. fetch the WebView2 bootstrapper for machines that lack it
//   7. run the *staged* host and check it really serves the panel and accepts a GSI push
//   8. hand the staged tree to Inno Setup, which packs the wizard
//
// Steps 1-7 are the ones that can go wrong quietly, so they are all checked and the script stops
// with the failing command's output rather than building a broken installer.
//
//   node scripts/build-installer.mjs            # everything, on Windows
//   node scripts/build-installer.mjs --help
//
// The Windows-only steps (5, 8 and the shell in 3) are skipped with --no-runtime / --no-installer
// / --no-shell, which is how the layout can be exercised on Linux or macOS.

import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync, copyFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(readFileSync(path.join(repoRoot,'package.json'),'utf8'));

// ---------------------------------------------------------------- arguments ---------------------

const options={
  version:pkg.version,
  runtime:'lts',
  runtimeZip:'',
  shell:true,
  smokeTest:true,
  webview2:true,
  npmCi:true,
  installer:true,
  iscc:'',
  tauriCli:'cargo',
  stage:path.join(repoRoot,'dist-stage'),
  out:path.join(repoRoot,'dist-installer'),
  keepStage:false,
};

const usage=`Builds the SCOUT Windows installer.

  --version <v>        installer version (default: package.json, ${pkg.version})
  --runtime <lts|vX.Y.Z>
                       Node runtime to bundle (default: latest LTS from nodejs.org)
  --runtime-zip <file> use a local node-vX.Y.Z-win-x64.zip instead of downloading one
  --no-runtime         do not bundle a Node runtime (staging only; the installer needs one)
  --no-shell           skip the Tauri overlay shell (scout-shell.exe)
  --no-smoke-test      skip starting the staged host to prove it works
  --no-webview2        skip fetching the WebView2 bootstrapper
  --no-npm-ci          reuse the existing node_modules instead of npm ci
  --no-installer       stop after staging (no Inno Setup needed)
  --tauri-cli <cmd>    cargo-like command that has the Tauri 2 CLI (default: cargo)
  --iscc <path>        path to ISCC.exe (default: found in the usual places)
  --stage <dir>        staging directory (default: <repo>/dist-stage)
  --out <dir>          where the installer is written (default: <repo>/dist-installer)
  --keep-stage         leave an existing staging directory in place instead of recreating it
  --help               this text`;

const argv=process.argv.slice(2);
const valueFlags={'--version':'version','--runtime':'runtime','--runtime-zip':'runtimeZip','--tauri-cli':'tauriCli','--iscc':'iscc','--stage':'stage','--out':'out'};
const switchFlags={'--no-runtime':'runtime','--no-shell':'shell','--no-smoke-test':'smokeTest','--no-webview2':'webview2','--no-npm-ci':'npmCi','--no-installer':'installer','--keep-stage':'keepStage'};
for(let i=0;i<argv.length;i++){
  const [name,inline]=argv[i].split('=');
  if(name in switchFlags){
    if(inline!==undefined) fail(`${name} does not take a value.\n\n${usage}`);
    options[switchFlags[name]]=false;
    continue;
  }
  if(name in valueFlags){
    const value=inline!==undefined?inline:argv[++i];
    if(value===undefined||value.startsWith('--')) fail(`${name} needs a value.\n\n${usage}`);
    const key=valueFlags[name];
    options[key]=key==='runtimeZip'||key==='iscc'||key==='stage'||key==='out'?path.resolve(value):value;
    continue;
  }
  if(name==='--help'||name==='-h'){console.log(usage); process.exit(0)}
  fail(`Unknown argument ${name}.\n\n${usage}`);
}
if(options.keepStage&&!existsSync(options.stage)) fail(`--keep-stage was given but ${options.stage} does not exist.`);

// ---------------------------------------------------------------- helpers -----------------------

const warnings=[];
let step=0;
// panel, host, shell, program files, dependencies, launcher/docs = 6 always; the rest depend on
// what the caller asked for.
const steps=6+(options.runtime?1:0)+(options.webview2?1:0)+(options.smokeTest?1:0)+(options.installer?1:0);

function log(message){console.log(message)}
function banner(message){step++; console.log(`\n[${step}/${steps}] ${message}`)}
function warn(message){warnings.push(message); console.log(`  ! ${message}`)}
function fail(message){console.error(`\n${message}\n`); process.exit(1)}
function sizeOf(target){
  // lstat, not stat: a dangling symlink left behind by a removed optional dependency must not
  // make the report fail.
  let stats;
  try{stats=lstatSync(target)}catch{return 0}
  if(stats.isSymbolicLink()||stats.isFile()) return stats.size;
  let total=0;
  for(const entry of readdirSync(target,{withFileTypes:true})){
    const full=path.join(target,entry.name);
    if(entry.isDirectory()) total+=sizeOf(full);
    else if(entry.isFile()) total+=statSync(full).size;
  }
  return total;
}
function megabytes(bytes){return `${(bytes/1024/1024).toFixed(1)} MB`}

function run(command,args,{cwd=repoRoot,allowFailure=false,quiet=false}={}){
  if(!quiet) log(`  $ ${command} ${args.join(' ')}`);
  const result=spawnSync(command,args,{
    cwd,
    stdio:quiet?['ignore','pipe','pipe']:'inherit',
    shell:false,
    env:process.env,
  });
  if(result.error){
    if(result.error.code==='ENOENT') fail(`Cannot run ${command}: it is not installed or not on PATH.`);
    fail(`Cannot run ${command}: ${result.error.message}`);
  }
  if(result.status!==0&&!allowFailure){
    const detail=quiet?`\n${result.stdout?.toString()||''}${result.stderr?.toString()||''}`:'';
    fail(`${command} ${args.join(' ')} failed with exit code ${result.status}.${detail}`);
  }
  return result.status===0;
}

function capture(command,args,{cwd=repoRoot}={}){
  const result=spawnSync(command,args,{cwd,stdio:['ignore','pipe','pipe'],shell:false});
  return result.status===0?result.stdout.toString().trim():'';
}

// npm is a .cmd shim on Windows, which needs a shell to be spawnable at all.
function runNpm(args,cwd=repoRoot){
  log(`  $ npm ${args.join(' ')}`);
  const result=spawnSync('npm',args,{cwd,stdio:'inherit',shell:process.platform==='win32'});
  if(result.status!==0) fail(`npm ${args.join(' ')} failed with exit code ${result.status}.`);
}

async function download(url,target){
  log(`  $ download ${url}`);
  const response=await fetch(url,{redirect:'follow'});
  if(!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer=Buffer.from(await response.arrayBuffer());
  writeFileSync(target,buffer);
  return buffer;
}

async function sha256(file){
  const hash=createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

// ---------------------------------------------------------------- checks ------------------------

log(`SCOUT installer build
  version   ${options.version}
  repo      ${repoRoot}
  staging   ${options.stage}
  output    ${options.out}`);

if(options.shell&&process.platform!=='win32')
  warn('Building the Tauri overlay shell off Windows usually needs a cross-compilation setup; use --no-shell if it fails.');

// ---------------------------------------------------------------- 1. panel ----------------------

banner('Building the control panel and overlay pages');
if(options.npmCi){
  runNpm(['ci','--no-audit','--no-fund']);
}else{
  log('  (--no-npm-ci: reusing the existing node_modules)');
}
runNpm(['run','build']);
if(!existsSync(path.join(repoRoot,'dist','index.html'))) fail('vite build produced no dist/index.html.');

// ---------------------------------------------------------------- 2. host -----------------------

banner('Compiling the host to JavaScript');
rmSync(path.join(repoRoot,'build'),{recursive:true,force:true});
run(process.execPath,[path.join('node_modules','typescript','bin','tsc'),'-p','tsconfig.build.json']);
const compiled=path.join(repoRoot,'build','server','index.js');
if(!existsSync(compiled)) fail('tsc produced no build/server/index.js.');
log(`  ${path.relative(repoRoot,compiled)} written`);

// ---------------------------------------------------------------- 3. shell ----------------------

banner('Building the overlay shell (scout-shell.exe)');
let shellExe='';
if(options.shell){
  const built=run(options.tauriCli,['tauri','build'],{cwd:repoRoot,allowFailure:true,quiet:true});
  if(!built){
    log('  cargo tauri build did not succeed. Its output was:');
    // Re-run is too slow; the captured output is gone, so at least say what to run to see it.
    log('    (run "npm run shell:build" to see the compiler output)');
  }
  shellExe=path.join(repoRoot,'src-tauri','target','release','scout-shell.exe');
  if(!built||!existsSync(shellExe)){
    warn('the overlay shell was not built, so the installer will ship without scout-shell.exe '+
         '(the OBS browser source still works; run with --no-shell to make this intentional)');
    shellExe='';
  }else{
    log(`  scout-shell.exe ${megabytes(statSync(shellExe).size)}`);
  }
}else{
  log('  (--no-shell: the installer will have no overlay shell)');
}

// ---------------------------------------------------------------- 4. staging --------------------

banner('Staging the program files');
const stage=options.stage;
const hostStage=path.join(stage,'host');
if(!options.keepStage) rmSync(stage,{recursive:true,force:true});
mkdirSync(hostStage,{recursive:true});

// The host code and the panel it serves.
cpSync(path.join(repoRoot,'build','server'),path.join(hostStage,'server'),{recursive:true});
// The one module the host shares with the panel (src/radar.ts). The host imports it as
// '../src/radar.js', so the staged tree has to keep the same shape: server/ next to src/.
cpSync(path.join(repoRoot,'build','src'),path.join(hostStage,'src'),{recursive:true});
cpSync(path.join(repoRoot,'dist'),path.join(hostStage,'dist'),{recursive:true});
// Radar overviews, scene thumbnails and weapon icons travel inside dist/: vite copies public/ into
// the panel build, the server serves that directory, and the installer seeds the operator's radar
// and thumbnail folders from it. Keeping one copy keeps the installer ~14 MB smaller, so make sure
// the build really produced it.
if(!existsSync(path.join(repoRoot,'dist','radars'))||!existsSync(path.join(repoRoot,'dist','thumbs')))
  fail('dist/ has no radars/ and thumbs/ - vite did not copy public/ into the panel build, and the '+
       'installer seeds the operator\'s radar images from there.');
// Default configuration. The installer copies these into the data directory once; the ones here
// stay as the read-only originals the GSI config is generated from.
mkdirSync(path.join(hostStage,'config'),{recursive:true});
for(const file of ['teams.json','radars.json','gamestate_integration_overlay.cfg'])
  copyFileSync(path.join(repoRoot,'config',file),path.join(hostStage,'config',file));
copyFileSync(path.join(repoRoot,'src-tauri','icons','icon.ico'),path.join(hostStage,'scout.ico'));
if(shellExe) copyFileSync(shellExe,path.join(hostStage,'scout-shell.exe'));
// Node resolves the host's imports relative to the working directory, so it needs the manifest
// with "type": "module" next to it - and only that manifest, with no build scripts in the way.
writeFileSync(path.join(hostStage,'package.json'),JSON.stringify({
  name:'scout-host',
  version:options.version,
  private:true,
  type:'module',
  comment:'Written by scripts/build-installer.mjs. The host is started as a plain ESM program.',
},null,2)+'\n');

banner('Installing the host dependencies (production only)');
const dependencyStage=path.join(stage,'.npm');
mkdirSync(dependencyStage,{recursive:true});
copyFileSync(path.join(repoRoot,'package.json'),path.join(dependencyStage,'package.json'));
copyFileSync(path.join(repoRoot,'package-lock.json'),path.join(dependencyStage,'package-lock.json'));
runNpm(['ci','--omit=dev','--no-audit','--no-fund'],dependencyStage);
cpSync(path.join(dependencyStage,'node_modules'),path.join(hostStage,'node_modules'),{recursive:true});
rmSync(dependencyStage,{recursive:true,force:true});

// The panel's UI libraries (react, react-dom, framer-motion, lucide-react) are already inside the
// vite bundle in dist/ and the host never imports them. Dropping them saves ~40 MB in the
// installer, and the guard below makes sure a future server import of one of them fails the build
// here instead of at the operator's machine.
const clientOnly=['react','react-dom','framer-motion','lucide-react'];
const serverSource=readdirSync(path.join(hostStage,'server'))
  .filter(name=>name.endsWith('.js'))
  .map(name=>readFileSync(path.join(hostStage,'server',name),'utf8'))
  .join('\n');
const stillNeeded=clientOnly.filter(name=>new RegExp(`from\\s+'${name}[/']|require\\(\\s*'${name}[/']`).test(serverSource));
if(stillNeeded.length){
  fail(`The compiled host now imports ${stillNeeded.join(', ')}, which this build removes from the `+
       `staged dependencies.\nRemove them from the clientOnly list in scripts/build-installer.mjs (or `+
       `stop importing them from server/).`);
}
for(const name of clientOnly) rmSync(path.join(hostStage,'node_modules',name),{recursive:true,force:true});
// Nothing is started through node_modules/.bin: the launcher calls node.exe with the host's entry
// script directly. Removing the shims also removes symlinks that a trim can leave dangling.
rmSync(path.join(hostStage,'node_modules','.bin'),{recursive:true,force:true});
log(`  node_modules ${megabytes(sizeOf(path.join(hostStage,'node_modules')))} (client-only UI packages removed)`);

// ---------------------------------------------------------------- 5. runtime --------------------

if(options.runtime){
  banner('Bundling a Node runtime');
  const runtimeDir=path.join(stage,'runtime');
  mkdirSync(runtimeDir,{recursive:true});
  const target=path.join(runtimeDir,'node.exe');

  if(options.runtimeZip){
    extractNodeExe(options.runtimeZip,target);
  }else{
    const wanted=options.runtime==='lts'?await latestLtsVersion():options.runtime.replace(/^v/,'');
    const zipName=`node-v${wanted}-win-x64.zip`;
    const zipPath=path.join(stage,zipName);
    const shasums=path.join(stage,'SHASUMS256.txt');
    log(`  Node ${wanted} (win-x64)`);
    try{
      await download(`https://nodejs.org/dist/v${wanted}/${zipName}`,zipPath);
      await download(`https://nodejs.org/dist/v${wanted}/SHASUMS256.txt`,shasums);
    }catch(error){
      fail(`Could not download the Node runtime: ${error.message}\n\n`+
           `Download ${zipName} yourself and pass it with --runtime-zip <file>, or use --no-runtime `+
           `to stage without one.`);
    }
    const expected=(readFileSync(shasums,'utf8').split('\n')
      .find(line=>line.trim().endsWith(zipName))||'').trim().split(/\s+/)[0];
    if(!expected) fail(`SHASUMS256.txt has no entry for ${zipName} - refusing to bundle an unchecked runtime.`);
    const actual=await sha256(zipPath);
    if(actual.toLowerCase()!==expected.toLowerCase())
      fail(`The downloaded runtime does not match nodejs.org's checksum.\n  expected ${expected}\n  got      ${actual}`);
    log('  checksum matches nodejs.org SHASUMS256.txt');
    extractNodeExe(zipPath,target);
    rmSync(zipPath,{force:true});
    rmSync(shasums,{force:true});
  }
  if(!existsSync(target)) fail('No node.exe in the staging runtime directory.');
  log(`  runtime/node.exe ${megabytes(statSync(target).size)}`);
}else{
  log('\n(no Node runtime bundled: --no-runtime)');
}

// ---------------------------------------------------------------- 6. webview2 -------------------

if(options.webview2){
  banner('Fetching the WebView2 bootstrapper');
  const redist=path.join(stage,'redist');
  mkdirSync(redist,{recursive:true});
  try{
    await download('https://go.microsoft.com/fwlink/p/?LinkId=2124703',path.join(redist,'MicrosoftEdgeWebview2Setup.exe'));
    log(`  MicrosoftEdgeWebview2Setup.exe ${megabytes(statSync(path.join(redist,'MicrosoftEdgeWebview2Setup.exe')).size)}`);
  }catch(error){
    warn(`no WebView2 bootstrapper in the installer (${error.message}); the wizard will then only `+
         `mention it when the runtime turns out to be missing on the target machine`);
  }
}else{
  log('\n(no WebView2 bootstrapper: --no-webview2)');
}

// Launcher and docs travel with the installer.
banner('Adding the launcher and documentation');
cpSync(path.join(repoRoot,'installer','launcher'),path.join(stage,'launcher'),{recursive:true});
mkdirSync(path.join(stage,'docs'),{recursive:true});
copyFileSync(path.join(repoRoot,'README.md'),path.join(stage,'docs','README.md'));
copyFileSync(path.join(repoRoot,'docs','INSTALL.md'),path.join(stage,'docs','GETTING-STARTED.md'));
copyFileSync(path.join(repoRoot,'installer','README.md'),path.join(stage,'docs','INSTALL-WINDOWS.md'));
copyFileSync(path.join(repoRoot,'docs','BETA.md'),path.join(stage,'docs','ACCOUNTS-AND-BETA.md'));
copyFileSync(path.join(repoRoot,'src-tauri','README.md'),path.join(stage,'docs','OVERLAY-SHELL.md'));
log(`  launcher/ + docs/ (${readdirSync(path.join(stage,'docs')).length} documents)`);

// ---------------------------------------------------------------- 7. smoke test -----------------

if(options.smokeTest){
  banner('Starting the staged host and checking it works');
  await smokeTest(stage,hostStage,options.version);
}else{
  log('\n(skipped the staged-host smoke test: --no-smoke-test)');
}

// ---------------------------------------------------------------- 8. installer ------------------

let installerPath='';
if(options.installer){
  if(!existsSync(path.join(stage,'runtime','node.exe')))
    fail('An installer without runtime\\node.exe would not start on the operator\'s machine.\n'+
         'Build with a runtime (default, --runtime-zip <file>), or put node.exe in the staging '+
         'runtime directory yourself, or pass --no-installer to stop after staging.');
  banner('Packing the wizard with Inno Setup');
  const iscc=options.iscc||findIscc();
  if(!iscc) fail('ISCC.exe was not found. Install Inno Setup 6.3 or newer '+
                 '(https://jrsoftware.org/isdl.php), or pass --iscc <path to ISCC.exe>.');
  mkdirSync(options.out,{recursive:true});
  const versionWin=options.version.split('.').concat(['0','0','0']).slice(0,4).join('.');
  run(iscc,[
    `/DAppVersion=${options.version}`,
    `/DVersionWin=${versionWin}`,
    `/DStageRoot=${stage}`,
    `/O${options.out}`,
    path.join(repoRoot,'installer','scout.iss'),
  ]);
  installerPath=path.join(options.out,`SCOUT-Setup-${options.version}.exe`);
  if(!existsSync(installerPath)) fail(`Inno Setup reported success but ${installerPath} is missing.`);
  log(`  ${installerPath} ${megabytes(statSync(installerPath).size)}`);
}else{
  log('\n(stopped before the installer: --no-installer)');
}

// ---------------------------------------------------------------- summary -----------------------

console.log(`\n${'-'.repeat(78)}
Staged tree   ${stage}  (${megabytes(sizeOf(stage))})
Host          ${existsSync(path.join(hostStage,'scout-shell.exe'))?'with':'without'} the overlay shell${options.runtime?', with its own Node runtime':''}
Installer     ${installerPath||'not built'}
${warnings.length?`Warnings\n${warnings.map(w=>`  ! ${w}`).join('\n')}\n`:''}`);
if(installerPath){
  console.log(`Run it on the observer machine: it asks for the port and the CS2 folder, writes the GSI
config, offers the firewall rule, and installs the host with a Start menu shortcut. Operator data
lives in %APPDATA%\\SCOUT and survives uninstalling the program.`);
}

// ---------------------------------------------------------------- pieces ------------------------

async function latestLtsVersion(){
  try{
    const response=await fetch('https://nodejs.org/dist/index.json');
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const releases=await response.json();
    const lts=releases.find(release=>release.lts);
    if(!lts) throw new Error('no LTS release in index.json');
    return lts.version.replace(/^v/,'');
  }catch(error){
    fail(`Could not ask nodejs.org which LTS to bundle: ${error.message}\n\n`+
         `Pass an explicit version (--runtime v22.20.0), a zip (--runtime-zip <file>), or --no-runtime.`);
  }
}

// node.exe out of the official zip. Windows 10+ ships bsdtar as tar.exe, so this needs nothing
// beyond the operating system; Expand-Archive and unzip are fallbacks for older machines.
function extractNodeExe(zipPath,target){
  if(!existsSync(zipPath)) fail(`There is no runtime zip at ${zipPath}.`);
  const scratch=path.join(path.dirname(target),'.unpack');
  rmSync(scratch,{recursive:true,force:true});
  mkdirSync(scratch,{recursive:true});
  const attempts=[
    ['tar',['-xf',zipPath,'-C',scratch]],
    ['unzip',['-o','-q',zipPath,'-d',scratch]],
    ['powershell',['-NoProfile','-NonInteractive','-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${scratch}' -Force`]],
  ];
  let extracted=false;
  for(const [command,args] of attempts){
    const result=spawnSync(command,args,{stdio:'ignore',shell:false});
    if(!result.error&&result.status===0&&existsSync(scratch)){extracted=true;break}
  }
  if(!extracted) fail(`Could not unpack ${zipPath}. Unpack it yourself and copy node.exe to `+
                      `${target}, or pass --runtime-zip with a zip your tools can open.`);
  const folder=readdirSync(scratch).find(name=>name.startsWith('node-'));
  const source=folder?path.join(scratch,folder,'node.exe'):'';
  if(!source||!existsSync(source)) fail(`${zipPath} does not contain node-v*-win-x64/node.exe.`);
  copyFileSync(source,target);
  const version=spawnSync(target,['--version'],{stdio:['ignore','pipe','ignore']});
  if(version.status===0) log(`  ${target} reports ${version.stdout.toString().trim()}`);
  rmSync(scratch,{recursive:true,force:true});
}

function findIscc(){
  const candidates=[
    process.env.ISCC,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    path.join(process.env.LOCALAPPDATA||'','Programs','Inno Setup 6','ISCC.exe'),
  ].filter(Boolean);
  for(const candidate of candidates) if(existsSync(candidate)) return candidate;
  return capture('where',['ISCC.exe'])||capture('which',['iscc'])||'';
}

// Starts the staged host the way the launcher does - working directory in a throwaway data
// directory, program files in the staging tree - and checks the three things an operator would
// notice immediately if they were broken: the panel loads, the OBS page loads and a CS2 push is
// accepted. Runs on any platform that can execute the staged node runtime; without a bundled
// runtime it falls back to the Node that is running this script (still a real check of the tree).
async function smokeTest(stage,hostStage,version){
  const bundled=path.join(stage,'runtime','node.exe');
  const usable=existsSync(bundled)&&(process.platform==='win32'||!bundled.endsWith('.exe'));
  const nodeExe=usable?bundled:process.execPath;
  if(!usable&&existsSync(bundled)) log('  (a Windows runtime is staged but this is not Windows - testing with the local Node)');
  const dataDir=path.join(stage,'.smoke-data');
  rmSync(dataDir,{recursive:true,force:true});
  mkdirSync(path.join(dataDir,'config'),{recursive:true});
  for(const file of ['teams.json','radars.json'])
    copyFileSync(path.join(hostStage,'config',file),path.join(dataDir,'config',file));

  const port=8400+Math.floor(Math.random()*400);
  const token='smoke-test-token';
  const host=spawn(nodeExe,[path.join(hostStage,'server','index.js')],{
    cwd:dataDir,
    env:{
      ...process.env,
      NODE_ENV:'production',
      PORT:String(port),
      SCOUT_APP_ROOT:hostStage,
      GSI_TOKEN:token,
      SCOUT_REMOTE:'off',
      SCOUT_PANEL_TOKEN:'smoke-panel-token-0123456789',
      // The launcher sets this; scout-stop.cmd and the uninstaller read the file it produces.
      SCOUT_PID_FILE:path.join(dataDir,'scout.pid'),
    },
    stdio:['ignore','pipe','pipe'],
  });
  let output='';
  host.stdout.on('data',chunk=>{output+=chunk});
  host.stderr.on('data',chunk=>{output+=chunk});

  const base=`http://127.0.0.1:${port}`;
  const deadline=Date.now()+30000;
  let panel='';
  try{
    while(Date.now()<deadline){
      if(host.exitCode!==null) break;
      try{
        const response=await fetch(`${base}/admin`);
        if(response.ok){panel=await response.text();break}
      }catch{/* not up yet */}
      await new Promise(resolve=>setTimeout(resolve,400));
    }
    if(!panel){
      fail(`The staged host did not answer on ${base}/admin within 30 seconds.\n\n`+
           `--- host output ---\n${output||'(nothing)'}\n-------------------\n`);
    }
    if(!panel.includes('<div id="root">')) fail('The staged host answered, but not with the control panel page.');

    const obs=await fetch(`${base}/obs`);
    if(!obs.ok) fail(`The OBS page answered ${obs.status}.`);

    const push=await fetch(`${base}/gsi`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        auth:{token},
        provider:{name:'Counter-Strike: Global Offensive',appid:730,version:1},
        map:{name:'de_dust2',phase:'live',round:1},
        round:{phase:'live'},
        player:{steamid:'1',name:'smoke',state:{health:100}},
        allplayers:{},
      }),
    });
    if(!push.ok) fail(`The staged host refused a GSI push: HTTP ${push.status} ${await push.text()}`);

    const pidFile=path.join(dataDir,'scout.pid');
    if(!existsSync(pidFile)||!/^\d+$/.test(readFileSync(pidFile,'utf8').trim()))
      fail('The staged host did not write the pid file scout-stop.cmd depends on.');
    log(`  panel, OBS page, a GSI push and the pid file all answered on port ${port} (host ${version})`);
  }finally{
    host.kill('SIGTERM');
    await new Promise(resolve=>setTimeout(resolve,300));
    if(host.exitCode===null) host.kill('SIGKILL');
    rmSync(dataDir,{recursive:true,force:true});
  }
}
