; Windows installer: one SheetMetal-Setup.exe that sets up everything.
; Built by .github/workflows/release.yml from build\app (see scripts/package.js):
;   ISCC /DAppVersion=0.1.0 /DBuild=12 installer\sheet-metal.iss
; Installs to C:\SheetMetal with Node and cloudflared bundled, allows the app through
; the firewall, adds shortcuts and start-with-Windows, then opens the app.
; Re-running a newer setup upgrades the code; data\ (database + backups) is never touched,
; not even by uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Build
  #define Build "0"
#endif

[Setup]
AppId={{6F2B8E4A-5C1D-4E7A-9B3F-2D8C1A0E5F47}
AppName=Sheet Metal
AppVersion={#AppVersion}.{#Build}
AppVerName=Sheet Metal {#AppVersion} ({#Build})
AppPublisher=شركة الصفا
DefaultDirName={sd}\SheetMetal
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=SheetMetal-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
UninstallDisplayName=Sheet Metal
UninstallDisplayIcon={app}\node\node.exe
SetupLogging=yes

[Messages]
WelcomeLabel2=هيتثبت برنامج Sheet Metal على الكمبيوتر ده في C:\SheetMetal.%n%nكل حاجة بتتعمل لوحدها: البرنامج، Node، لينك الموبايل، والسماح في الفايروول.%n%nلو البرنامج متثبت قبل كده، بياناتك مش هتتلمس.
FinishedLabel=البرنامج اتثبت. هيفتح في المتصفح، وأول مرة هيطلب منك تعمل حساب الأدمن.

[Tasks]
Name: autostart; Description: "البرنامج يشتغل لوحده لما الكمبيوتر يفتح"
Name: desktopicon; Description: "أيقونة على سطح المكتب"

[Dirs]
; The app writes data\, backups and updates next to itself.
Name: "{app}"; Permissions: users-modify

[InstallDelete]
; Old code goes; the code from this setup runs (current.txt = "."). data\ stays.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\versions"
Type: files; Name: "{app}\current.txt"
Type: files; Name: "{app}\previous.txt"
Type: files; Name: "{app}\update-trial.txt"

[Files]
Source: "..\build\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Sheet Metal"; Filename: "{app}\Start Sheet Metal.bat"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"
Name: "{autodesktop}\Sheet Metal"; Filename: "{app}\Start Sheet Metal.bat"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"; Tasks: desktopicon

[Run]
; Phones on the workshop Wi-Fi reach the app through the firewall.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Sheet Metal"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Sheet Metal"" dir=in action=allow program=""{app}\node\node.exe"" enable=yes profile=any"; Flags: runhidden
Filename: "{app}\Start Sheet Metal.bat"; WorkingDir: "{app}"; Description: "افتح البرنامج دلوقتي"; Flags: postinstall nowait shellexec skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Sheet Metal"""; Flags: runhidden; RunOnceId: "firewall"

[UninstallDelete]
Type: files; Name: "{userstartup}\Sheet Metal.vbs"
Type: filesandordirs; Name: "{app}\versions"
Type: files; Name: "{app}\current.txt"
Type: files; Name: "{app}\previous.txt"
Type: files; Name: "{app}\update-trial.txt"
Type: files; Name: "{app}\cloudflared.exe"

[Code]
// Stop a running copy (its node.exe and cloudflared.exe are locked while they run).
procedure StopApp();
var
  ResultCode: Integer;
  Dir: String;
begin
  Dir := ExpandConstant('{app}');
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM cmd.exe /FI "WINDOWTITLE eq Sheet Metal*"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -Command "Get-Process node,cloudflared -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -like ''' + Dir + '\*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopApp();
  Result := '';
end;

// Same file the app's own "start with Windows" switch writes (src/windows.js).
procedure WriteAutostart();
var
  Vbs: String;
begin
  Vbs := 'Set sh = CreateObject("WScript.Shell")' + #13#10 +
         'sh.Environment("PROCESS")("OPEN") = "0"' + #13#10 +
         'sh.Run """' + ExpandConstant('{app}') + '\Start Sheet Metal.bat""", 7, False' + #13#10;
  SaveStringToFile(ExpandConstant('{userstartup}\Sheet Metal.vbs'), Vbs, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('autostart') then WriteAutostart();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then StopApp();
end;
