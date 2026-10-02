; SCOUT - Windows installer (Inno Setup 6.3 or newer)
; ---------------------------------------------------------------------------------------------
;  Built by scripts\build-installer.mjs, which stages a self-contained tree and passes:
;    /DAppVersion=<version>  /DVersionWin=<four-part version>  /DStageRoot=<staged tree>  /O<out>
;
;  A wizard that installs the whole of SCOUT - the Node host (with its own bundled runtime, so
;  the operator needs no Node.js), the built control panel and overlay pages, the CS2 Game State
;  Integration config, the overlay shell, and the shortcuts to run them.
;
;  Two directories, on purpose:
;    program files  {app}\...            read-only for the operator: host code, node.exe, panel
;    data directory %APPDATA%\SCOUT      config/, public/uploads/, recordings/ - everything the
;                                        host writes, so updating SCOUT never touches match data
;  The launcher makes the data directory the working directory and points the host at the program
;  files with SCOUT_APP_ROOT (see server/runtime.ts).
;
;  The installer needs no administrator rights for a normal single-operator machine: the host,
;  its config and its shortcuts are all per-user. Only the optional Windows Firewall rule (for a
;  panel, OBS or a GSI source on another machine) asks for approval, and only when that task is
;  left ticked.
; ---------------------------------------------------------------------------------------------

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
; VersionInfoVersion must be a four-part number; the build script passes it, this is the fallback.
#ifndef VersionWin
  #define VersionWin "0.1.0.0"
#endif
#ifndef StageRoot
  #define StageRoot "..\dist-stage"
#endif

#define DataDir "{userappdata}\SCOUT"
#define RuleName "SCOUT host"

[Setup]
AppId={{6C1B9A44-2E7D-4F58-9A31-5D0C7E8B4A62}
AppName=SCOUT
AppVersion={#AppVersion}
AppVerName=SCOUT {#AppVersion}
AppPublisher=SCOUT
AppComments=Counter-Strike 2 broadcast overlay: host, control panel and overlay shell
DefaultDirName={autopf}\SCOUT
DefaultGroupName=SCOUT
DisableProgramGroupPage=no
AllowNoIcons=yes
; Per-user by default: no UAC prompt, and the data directory always belongs to the operator who
; is logged on. "Install for all users" stays available from the dialog for shared machines.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
OutputDir=Output
OutputBaseFilename=SCOUT-Setup-{#AppVersion}
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\host\scout.ico
UninstallDisplayName=SCOUT {#AppVersion}
VersionInfoVersion={#VersionWin}
VersionInfoCompany=SCOUT
VersionInfoDescription=SCOUT setup
ShowLanguageDialog=no
DisableWelcomePage=no
DisableReadyPage=no
; The host is a console program serving HTTP; nothing here should ever need a reboot.
RestartIfNeededByRun=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut for the SCOUT host"; GroupDescription: "Shortcuts:"; Flags: checkedonce
Name: "gsiintegration"; Description: "Install the CS2 Game State Integration config into the detected Counter-Strike 2 folder (lets CS2 feed the overlay - no memory reading, no injection)"; GroupDescription: "Counter-Strike 2:"; Flags: checkedonce
Name: "panelaccess"; Description: "Allow the control panel, OBS and a GSI source on another machine (adds a Windows Firewall rule; Windows asks for approval once)"; GroupDescription: "Network:"; Flags: checkedonce
Name: "webview2"; Description: "Install the Microsoft WebView2 runtime if it is missing (the overlay shell needs it)"; GroupDescription: "Overlay shell:"; Check: IsWebView2Missing; Flags: checkedonce

[Files]
; ---- program files (read-only for the operator) ---------------------------------------------
Source: "{#StageRoot}\host\*"; DestDir: "{app}\host"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageRoot}\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "{#StageRoot}\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "{#StageRoot}\redist\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

; ---- data directory (seeded once, never overwritten, never removed by an uninstall) ---------
Source: "{#StageRoot}\launcher\scout-host.cmd"; DestDir: "{#DataDir}"; Flags: ignoreversion
Source: "{#StageRoot}\launcher\scout-stop.cmd"; DestDir: "{#DataDir}"; Flags: ignoreversion
Source: "{#StageRoot}\launcher\OPERATOR-NOTES.txt"; DestDir: "{#DataDir}"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#StageRoot}\host\config\teams.json"; DestDir: "{#DataDir}\config"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#StageRoot}\host\config\radars.json"; DestDir: "{#DataDir}\config"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#StageRoot}\host\config\gamestate_integration_overlay.cfg"; DestDir: "{#DataDir}\config"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#StageRoot}\host\dist\radars\*"; DestDir: "{#DataDir}\public\radars"; Flags: onlyifdoesntexist uninsneveruninstall recursesubdirs
Source: "{#StageRoot}\host\dist\thumbs\*"; DestDir: "{#DataDir}\public\thumbs"; Flags: onlyifdoesntexist uninsneveruninstall recursesubdirs

[Dirs]
; Everything the host writes. uninsneveruninstall: operator data outlives the program. No
; Permissions are set: a per-user install already owns its own data directory, and an all-users
; install can be given ACLs by the administrator who runs it if the machine is shared.
Name: "{#DataDir}"; Flags: uninsneveruninstall
Name: "{#DataDir}\config"; Flags: uninsneveruninstall
Name: "{#DataDir}\recordings"; Flags: uninsneveruninstall
Name: "{#DataDir}\public\radars"; Flags: uninsneveruninstall
Name: "{#DataDir}\public\thumbs"; Flags: uninsneveruninstall
Name: "{#DataDir}\public\uploads\logos"; Flags: uninsneveruninstall
Name: "{#DataDir}\public\uploads\maps"; Flags: uninsneveruninstall
Name: "{#DataDir}\public\uploads\players"; Flags: uninsneveruninstall
Name: "{#DataDir}\public\uploads\radars"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\SCOUT host"; Filename: "{#DataDir}\scout-host.cmd"; IconFilename: "{app}\host\scout.ico"; Comment: "Start the SCOUT host (control panel, OBS pages, CS2 feed)"
Name: "{group}\SCOUT control panel"; Filename: "http://127.0.0.1:{code:GetPort}/admin"; IconFilename: "{app}\host\scout.ico"; Comment: "Open the control panel in your browser"
Name: "{group}\SCOUT overlay shell"; Filename: "{app}\host\scout-shell.exe"; Parameters: "--url http://127.0.0.1:{code:GetPort}/game"; Comment: "Transparent click-through overlay over CS2 (F8 toggles, Ctrl+Shift+F8 quits)"
Name: "{group}\Stop the SCOUT host"; Filename: "{#DataDir}\scout-stop.cmd"; IconFilename: "{app}\host\scout.ico"; Comment: "Stop a host that is still running"
Name: "{group}\{cm:UninstallProgram,SCOUT}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\SCOUT host"; Filename: "{#DataDir}\scout-host.cmd"; IconFilename: "{app}\host\scout.ico"; Tasks: desktopicon

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing the Microsoft WebView2 runtime..."; Flags: waituntilterminated skipifdoesntexist; Check: NeedsWebView2 and IsTaskSelected('webview2')
Filename: "{#DataDir}\scout-host.cmd"; Description: "Start the SCOUT host now"; Flags: postinstall nowait skipifsilent
Filename: "http://127.0.0.1:{code:GetPort}/admin"; Description: "Open the SCOUT control panel"; Flags: postinstall shellexec nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\host"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\docs"
Type: dirifempty; Name: "{app}"

[Code]
const
  TokenAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  Cs2CfgSuffix = '\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg';
  Cs2LegacyCfgSuffix = '\steamapps\common\Counter-Strike Global Offensive\csgo\cfg';
  CfgFileName = '\gamestate_integration_overlay.cfg';

var
  SettingsPage: TInputQueryWizardPage;
  Cs2Page: TInputDirWizardPage;
  Port, GsiToken, PanelToken: String;
  RemoteAccess: Boolean;

{ ------------------------------------------------------------------ small helpers ------------- }

function DataDir: String;
begin
  Result := ExpandConstant('{#DataDir}');
end;

function GenerateToken(const Len: Integer): String;
var
  I: Integer;
begin
  Result := '';
  for I := 1 to Len do
    Result := Result + TokenAlphabet[Random(Length(TokenAlphabet)) + 1];
end;

function IsDigits(const S: String): Boolean;
var
  I: Integer;
begin
  Result := S <> '';
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then
    begin
      Result := False;
      Exit;
    end;
end;

{ Writes a value file the launcher reads. SaveStringsToFile writes ANSI bytes with CRLF line
  endings and no byte order mark, which is exactly what both cmd.exe and Valve's KeyValues
  parser (the GSI .cfg) want - a UTF-8 BOM would make CS2 ignore the file. }
procedure WriteValueFile(const FileName, Value: String);
var
  Lines: TArrayOfString;
begin
  SetArrayLength(Lines, 1);
  Lines[0] := Value;
  if not SaveStringsToFile(FileName, Lines, False) then
    Log('Could not write ' + FileName);
end;

function ReadValueFile(const FileName: String): String;
var
  Lines: TArrayOfString;
begin
  Result := '';
  if LoadStringsFromFile(FileName, Lines) and (GetArrayLength(Lines) > 0) then
    Result := Trim(Lines[0]);
end;

{ ------------------------------------------------------------------ CS2 detection -------------- }

function LooksLikeWindowsPath(const S: String): Boolean;
begin
  Result := (Length(S) > 2) and (Pos(':\', S) > 0);
end;

{ One line of steamapps\libraryfolders.vdf. Newer Steam writes
      "path"      "D:\\SteamLibrary"
  while the old format was a numbered key. Both are handled; anything that is not a path is ignored. }
function LibraryPathFromVdfLine(const Line: String): String;
var
  Rest: String;
begin
  Result := '';
  if Pos('"path"', Line) = 0 then
    Exit;
  Rest := Line;
  StringChangeEx(Rest, '"path"', '', True);
  Rest := Trim(Rest);
  if (Length(Rest) >= 2) and (Rest[1] = '"') and (Rest[Length(Rest)] = '"') then
    Rest := Copy(Rest, 2, Length(Rest) - 2);
  StringChangeEx(Rest, '\\', '\', True);
  Rest := Trim(Rest);
  if LooksLikeWindowsPath(Rest) then
    Result := Rest;
end;

procedure AddLibrary(var Libraries: TArrayOfString; const Path: String);
var
  I, Count: Integer;
begin
  if (Path = '') or not LooksLikeWindowsPath(Path) then
    Exit;
  Count := GetArrayLength(Libraries);
  for I := 0 to Count - 1 do
    if CompareText(Libraries[I], Path) = 0 then
      Exit;
  SetArrayLength(Libraries, Count + 1);
  Libraries[Count] := Path;
end;

{ Every Steam library folder, from the registry plus steamapps\libraryfolders.vdf. }
function CollectSteamLibraries: TArrayOfString;
var
  SteamPath, VdfFile: String;
  Lines: TArrayOfString;
  I: Integer;
  Libraries: TArrayOfString;
begin
  SetArrayLength(Libraries, 0);

  SteamPath := '';
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Software\Valve\Steam', 'SteamPath', SteamPath) then
    RegQueryStringValue(HKEY_LOCAL_MACHINE, 'SOFTWARE\WOW6432Node\Valve\Steam', 'InstallPath', SteamPath);
  if SteamPath = '' then
    RegQueryStringValue(HKEY_LOCAL_MACHINE, 'SOFTWARE\Valve\Steam', 'InstallPath', SteamPath);
  AddLibrary(Libraries, SteamPath);

  if SteamPath <> '' then
  begin
    VdfFile := SteamPath + '\steamapps\libraryfolders.vdf';
    if LoadStringsFromFile(VdfFile, Lines) then
      for I := 0 to GetArrayLength(Lines) - 1 do
        AddLibrary(Libraries, LibraryPathFromVdfLine(Lines[I]));
  end;

  Result := Libraries;
end;

{ The CS2 GSI config folder, or '' when it cannot be found. }
function DetectedCs2CfgDir: String;
var
  Libraries: TArrayOfString;
  I: Integer;
  Candidate: String;
begin
  Result := '';
  Libraries := CollectSteamLibraries;
  for I := 0 to GetArrayLength(Libraries) - 1 do
  begin
    Candidate := Libraries[I] + Cs2CfgSuffix;
    if DirExists(Candidate) then
    begin
      Result := Candidate;
      Exit;
    end;
    Candidate := Libraries[I] + Cs2LegacyCfgSuffix;
    if DirExists(Candidate) then
    begin
      Result := Candidate;
      Exit;
    end;
  end;
end;

function CfgDirWritable(const Dir: String): Boolean;
var
  Probe: String;
  Nothing: TArrayOfString;
begin
  Result := False;
  if not DirExists(Dir) then
    Exit;
  Probe := Dir + '\scout-write-test.tmp';
  SetArrayLength(Nothing, 0);
  if SaveStringsToFile(Probe, Nothing, False) then
  begin
    DeleteFile(Probe);
    Result := True;
  end;
end;

{ ------------------------------------------------------------------ WebView2 ------------------- }

function IsWebView2Missing: Boolean;
var
  Version: String;
begin
  Version := '';
  RegQueryStringValue(HKEY_LOCAL_MACHINE, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  if Version = '' then
    RegQueryStringValue(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  if Version = '' then
    RegQueryStringValue(HKEY_CURRENT_USER, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  Result := (Version = '') or (Version = '0.0.0.0');
end;

function NeedsWebView2: Boolean;
begin
  Result := IsWebView2Missing;
end;

{ ------------------------------------------------------------------ port check ----------------- }

{ Best effort, only ever used to warn: something else already listening on the chosen port would
  make the host fail to start with "EADDRINUSE". }
function PortLooksBusy(const PortNumber: String): Boolean;
var
  TmpFile, Line: String;
  Lines: TArrayOfString;
  ResultCode, I: Integer;
begin
  Result := False;
  TmpFile := ExpandConstant('{tmp}\scout-netstat.txt');
  if not Exec(ExpandConstant('{cmd}'), '/c netstat -ano > "' + TmpFile + '"', '',
              SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Exit;
  if not LoadStringsFromFile(TmpFile, Lines) then
    Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Lines[I];
    if (Pos(':' + PortNumber + ' ', Line) > 0) and (Pos('LISTENING', Line) > 0) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

{ ------------------------------------------------------------------ firewall ------------------- }

function FirewallRuleParams(const Add: Boolean): String;
begin
  if Add then
    Result := 'advfirewall firewall add rule name="{#RuleName}" dir=in action=allow' +
              ' program="' + ExpandConstant('{app}\runtime\node.exe') + '"' +
              ' protocol=TCP localport=' + Port + ' profile=any enable=yes'
  else
    Result := 'advfirewall firewall delete rule name="{#RuleName}"';
end;

procedure RunElevated(const FileName, Params: String);
var
  ResultCode: Integer;
begin
  if IsAdmin then
  begin
    if Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      Log('ran ' + FileName + ' (exit ' + IntToStr(ResultCode) + ')')
    else
      Log('could not run ' + FileName);
  end
  else
  begin
    { Not elevated: ask for approval for this one command only. Declining is not fatal - the
      notes in the data directory carry the manual command. }
    if not ShellExec('runas', FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      Log('elevation for ' + FileName + ' was refused')
    else
      Log('ran elevated ' + FileName + ' (exit ' + IntToStr(ResultCode) + ')');
  end;
end;

procedure ApplyFirewallRule;
var
  Netsh: String;
begin
  Netsh := ExpandConstant('{sys}\netsh.exe');
  RunElevated(Netsh, FirewallRuleParams(False));  { replace an older rule rather than add a second }
  RunElevated(Netsh, FirewallRuleParams(True));
end;

{ Is a rule of ours there? Asked before the uninstaller bothers anyone with an approval prompt. }
function FirewallRuleExists: Boolean;
var
  TmpFile: String;
  Lines: TArrayOfString;
  ResultCode, I: Integer;
begin
  Result := False;
  TmpFile := ExpandConstant('{tmp}\scout-firewall.txt');
  if not Exec(ExpandConstant('{cmd}'),
              '/c netsh advfirewall firewall show rule name="{#RuleName}" > "' + TmpFile + '"',
              '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Exit;
  if not LoadStringsFromFile(TmpFile, Lines) then
    Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
    if Pos('{#RuleName}', Lines[I]) > 0 then
    begin
      Result := True;
      Exit;
    end;
end;

procedure RemoveFirewallRuleIfPresent;
begin
  if FirewallRuleExists then
    RunElevated(ExpandConstant('{sys}\netsh.exe'), FirewallRuleParams(False));
end;

{ ------------------------------------------------------------------ running host --------------- }

function PidFile: String;
begin
  Result := DataDir + '\scout.pid';
end;

{ Stops a host started by scout-host.cmd. The pid file alone is not trusted: a recycled pid must
  not get a process killed, so the image name is checked first. }
procedure StopRunningHost;
var
  Pid, TmpFile: String;
  Lines: TArrayOfString;
  ResultCode: Integer;
  I: Integer;
  IsNode: Boolean;
begin
  Pid := ReadValueFile(PidFile);
  if not IsDigits(Pid) then
    Exit;
  TmpFile := ExpandConstant('{tmp}\scout-tasklist.txt');
  Exec(ExpandConstant('{cmd}'), '/c tasklist /FI "PID eq ' + Pid + '" /NH /FO CSV > "' + TmpFile + '"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  IsNode := False;
  if LoadStringsFromFile(TmpFile, Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      if Pos('"node.exe"', Lines[I]) > 0 then
        IsNode := True;
  if not IsNode then
    Exit;
  Log('stopping the running SCOUT host (pid ' + Pid + ')');
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/PID ' + Pid + ' /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  DeleteFile(PidFile);
end;

{ ------------------------------------------------------------------ GSI config ----------------- }

function WriteGsiConfig(const CfgDir: String): Boolean;
var
  Template, Target: String;
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := False;
  Template := ExpandConstant('{app}\host\config\gamestate_integration_overlay.cfg');
  if not LoadStringsFromFile(Template, Lines) then
  begin
    Log('GSI template missing: ' + Template);
    Exit;
  end;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    StringChangeEx(Lines[I], 'http://127.0.0.1:8080/gsi', 'http://127.0.0.1:' + Port + '/gsi', True);
    StringChangeEx(Lines[I], 'CHANGE_ME', GsiToken, True);
  end;
  Target := CfgDir + CfgFileName;
  Result := SaveStringsToFile(Target, Lines, False);
  if Result then
    Log('CS2 GSI config written to ' + Target)
  else
    Log('could not write ' + Target);
end;

{ ------------------------------------------------------------------ wizard --------------------- }

procedure InitializeWizard;
var
  Detected, DefaultGuess: String;
begin
  Randomize;
  Port := '8080';
  GsiToken := GenerateToken(32);
  PanelToken := GenerateToken(40);
  RemoteAccess := True;

  SettingsPage := CreateInputQueryPage(wpSelectTasks,
    'Host settings',
    'Where should the SCOUT host listen, and with which tokens?',
    'The host serves the control panel, the OBS pages and the CS2 feed on this port. Leave the ' +
    'tokens as they are unless you already have a token in your CS2 config, then click Next.');
  SettingsPage.Add('Port:', False);
  SettingsPage.Add('CS2 Game State Integration token:', False);
  SettingsPage.Add('Panel token (used when the panel is opened from another machine):', False);
  SettingsPage.Values[0] := Port;
  SettingsPage.Values[1] := GsiToken;
  SettingsPage.Values[2] := PanelToken;

  Detected := DetectedCs2CfgDir;
  { A guess for a CS2 installation that the registry did not reveal: Steam's own default folder. }
  DefaultGuess := ExpandConstant('{pf32}\Steam') + Cs2CfgSuffix;
  if not DirExists(ExpandConstant('{pf32}\Steam')) then
    DefaultGuess := ExpandConstant('{pf}\Steam') + Cs2CfgSuffix;
  Cs2Page := CreateInputDirPage(SettingsPage.ID,
    'Counter-Strike 2',
    'In which folder is the CS2 Game State Integration config installed?',
    'This is CS2''s cfg folder, not the folder CS2 itself is installed in. Steam: right-click ' +
    'Counter-Strike 2, Manage, Browse local files, then open game\csgo\cfg. The file written here ' +
    'only tells CS2 to push game state to this machine - SCOUT never touches the game process.',
    False, '');
  Cs2Page.Add('CS2 cfg folder:');
  if Detected <> '' then
    Cs2Page.Values[0] := Detected
  else
    Cs2Page.Values[0] := DefaultGuess;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = Cs2Page.ID then
    Result := not IsTaskSelected('gsiintegration');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Value: String;
begin
  Result := True;
  if CurPageID = SettingsPage.ID then
  begin
    Value := Trim(SettingsPage.Values[0]);
    if (not IsDigits(Value)) or (StrToIntDef(Value, 0) < 1) or (StrToIntDef(Value, 0) > 65535) then
    begin
      MsgBox('Enter a port between 1 and 65535. 8080 is the usual choice.', mbError, MB_OK);
      Result := False;
      Exit;
    end;

    { A short or empty token is replaced instead of refused: the wizard decides what is used and
      the value is right there in the field. }
    if Length(Trim(SettingsPage.Values[1])) < 8 then
    begin
      SettingsPage.Values[1] := GenerateToken(32);
      MsgBox('The GSI token was empty or very short, so a new one was generated: ' +
             SettingsPage.Values[1] + #13#10#13#10 +
             'Both CS2 and the host use this value. It is written to gsi_token.txt in the data ' +
             'directory; if you change it later, change it in the CS2 cfg file too.',
             mbInformation, MB_OK);
    end;
    if Length(Trim(SettingsPage.Values[2])) < 8 then
      SettingsPage.Values[2] := GenerateToken(40);

    Port := Trim(SettingsPage.Values[0]);
    GsiToken := Trim(SettingsPage.Values[1]);
    PanelToken := Trim(SettingsPage.Values[2]);
    RemoteAccess := IsTaskSelected('panelaccess');

    if PortLooksBusy(Port) then
    begin
      if MsgBox('Something on this machine is already listening on port ' + Port + '.' + #13#10#13#10 +
                'If that is not SCOUT itself, the host will not start until the port is free. ' +
                'Continue anyway?', mbConfirmation, MB_YESNO) = IDNO then
      begin
        Result := False;
        Exit;
      end;
    end;
  end;

  if CurPageID = Cs2Page.ID then
  begin
    if not IsTaskSelected('gsiintegration') then
      Exit;
    Value := Trim(Cs2Page.Values[0]);
    if not DirExists(Value) then
    begin
      if MsgBox('The folder' + #13#10#13#10 + Value + #13#10#13#10 +
                'does not exist. Install the GSI config somewhere else, or continue and copy ' +
                'config\gamestate_integration_overlay.cfg from the data directory into CS2''s ' +
                'cfg folder yourself later.',
                mbConfirmation, MB_YESNO) = IDNO then
      begin
        Result := False;
        Exit;
      end;
    end
    else if not CfgDirWritable(Value) then
    begin
      MsgBox('Windows would not let this installer write into' + #13#10#13#10 + Value + #13#10#13#10 +
             'Close the installer, right-click it and choose "Run as administrator" to install ' +
             'the CS2 config, or continue and copy the file there yourself. Everything else ' +
             'installs normally without administrator rights.',
             mbInformation, MB_OK);
    end;
  end;
end;

{ Runs before any file is copied: an upgrade must not fail because the old host is still running. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  StopRunningHost;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Root, CfgDir: String;
begin
  if CurStep <> ssPostInstall then
    Exit;

  Root := DataDir;
  ForceDirectories(Root);
  ForceDirectories(Root + '\config');
  ForceDirectories(Root + '\recordings');
  ForceDirectories(Root + '\public\radars');
  ForceDirectories(Root + '\public\thumbs');
  ForceDirectories(Root + '\public\uploads\logos');
  ForceDirectories(Root + '\public\uploads\maps');
  ForceDirectories(Root + '\public\uploads\players');
  ForceDirectories(Root + '\public\uploads\radars');

  { What the launcher and the host read on every start. }
  WriteValueFile(Root + '\app-root.txt', ExpandConstant('{app}'));
  WriteValueFile(Root + '\port.txt', Port);
  WriteValueFile(Root + '\gsi_token.txt', GsiToken);
  if RemoteAccess then
  begin
    WriteValueFile(Root + '\panel_token.txt', PanelToken);
    WriteValueFile(Root + '\remote.txt', 'on');
  end
  else
  begin
    DeleteFile(Root + '\panel_token.txt');
    WriteValueFile(Root + '\remote.txt', 'off');
  end;

  if IsTaskSelected('gsiintegration') then
  begin
    CfgDir := Trim(Cs2Page.Values[0]);
    if DirExists(CfgDir) then
    begin
      if not WriteGsiConfig(CfgDir) then
        MsgBox('The CS2 Game State Integration config could not be written to' + #13#10#13#10 +
               CfgDir + #13#10#13#10 +
               'Copy config\gamestate_integration_overlay.cfg from' + #13#10 +
               Root + '\config' + #13#10 +
               'into CS2''s cfg folder yourself, or run this installer as administrator. ' +
               'Everything else is installed.',
               mbInformation, MB_OK);
    end
    else
      MsgBox('The CS2 cfg folder was not found, so the Game State Integration config was not ' +
             'installed.' + #13#10#13#10 +
             'Copy config\gamestate_integration_overlay.cfg from' + #13#10 + Root + '\config' +
             #13#10 + 'into CS2''s game\csgo\cfg folder (the panel''s Setup guide tab says the ' +
             'same).', mbInformation, MB_OK);
  end;

  if IsTaskSelected('panelaccess') then
    ApplyFirewallRule;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataRoot: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    StopRunningHost;
    RemoveFirewallRuleIfPresent;
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    { Operator data - config, uploads, recordings - is never removed silently. The guard makes
      sure only a directory that really is SCOUT's data directory can be deleted. }
    DataRoot := DataDir;
    if (not UninstallSilent) and FileExists(DataRoot + '\app-root.txt') then
    begin
      if MsgBox('Also delete your SCOUT data?' + #13#10#13#10 +
                'This removes the configuration, uploaded logos, portraits and radar images, and ' +
                'any GSI recordings in' + #13#10#13#10 + DataRoot + #13#10#13#10 +
                'Choose No to keep them for a later install.',
                mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(DataRoot, True, True, True);
        Log('data directory removed: ' + DataRoot);
      end
      else
        Log('data directory kept: ' + DataRoot);
    end;
  end;
end;

function GetPort(Param: String): String;
begin
  if Port = '' then
    Port := '8080';
  Result := Port;
end;
