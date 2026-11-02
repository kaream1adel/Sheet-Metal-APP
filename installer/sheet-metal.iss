; Windows installer: one SheetMetal-Setup.exe that sets up everything.
; Built by .github/workflows/release.yml from build\app (see scripts/package.js):
;   ISCC /DAppVersion=0.1.0 /DBuild=12 installer\sheet-metal.iss
; Installs to the folder the user picks (C:\SheetMetal by default) with Node and cloudflared
; bundled, allows the app through the firewall, adds shortcuts and start-with-Windows, then
; opens the app. Re-running a newer setup upgrades the code in the same folder without
; asking again; data\ (database + backups) is never touched, not even by uninstall.
;
; Safety when the folder already exists:
; - Only a folder that is empty or holds a previous install is accepted (checked on the folder
;   page AND again before installing, because an upgrade skips the folder page).
; - Setup only adds/replaces the code it ships (src, public, node_modules, node, the launcher...).
;   It never deletes or overwrites data\ (database, backups), versions\, current.txt,
;   previous.txt or update-trial.txt: those belong to the update button and its rollback.
; - It writes setup-build.txt (its build). When current.txt points at an older versions\<build>,
;   the launcher runs this newer code instead, and the app then points current.txt at it
;   (src/update.js adoptInstalledCode), keeping the replaced version for «رجوع للنسخة السابقة».

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
; First install: the user picks the folder. Upgrade: the folder chosen the first time is reused.
DisableDirPage=auto
UsePreviousAppDir=yes
DirExistsWarning=no
AppendDefaultDirName=no
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
WelcomeLabel2=هيتثبت برنامج Sheet Metal على الكمبيوتر ده. في الخطوة الجاية تقدر تختار الفولدر.%n%nكل حاجة بتتعمل لوحدها: البرنامج، Node، لينك الموبايل، والسماح في الفايروول.%n%nلو البرنامج متثبت قبل كده، هيتحدث في نفس الفولدر وبياناتك مش هتتلمس.
SelectDirLabel3=البرنامج وبياناته (قاعدة البيانات والنسخ الاحتياطية) هيتحطوا في الفولدر ده. اختار مكان على الكمبيوتر نفسه، واسم الفولدر بالإنجليزي.
SelectDirBrowseLabel=دوس "التالي" عشان تكمل، أو "Browse" عشان تختار فولدر تاني.
FinishedLabel=البرنامج اتثبت. هيفتح في المتصفح، وأول مرة هيطلب منك تعمل حساب الأدمن.

[Tasks]
Name: autostart; Description: "البرنامج يشتغل لوحده لما الكمبيوتر يفتح"
Name: desktopicon; Description: "أيقونة على سطح المكتب"

[Dirs]
; The app writes data\, backups and updates next to itself.
Name: "{app}"; Permissions: users-modify

[InstallDelete]
; Only the old copy of the code this setup ships goes (so no stale file survives). The folder
; was checked to be a previous install (or empty) before this runs. data\, versions\,
; current.txt, previous.txt and update-trial.txt are never listed here.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\node_modules"

[Files]
; Excludes: belt and braces, the package never carries data or the update pointers.
Source: "..\build\app\*"; DestDir: "{app}"; Excludes: "\data,\versions,\current.txt,\previous.txt,\update-trial.txt,*.sqlite,*.sqlite-wal,*.sqlite-shm"; Flags: ignoreversion recursesubdirs createallsubdirs

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
Type: files; Name: "{app}\setup-build.txt"

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

// A folder that already holds this app (any version, the old app included).
function IsPreviousInstall(Dir: String): Boolean;
begin
  Dir := RemoveBackslashUnlessRoot(Dir);
  Result := FileExists(Dir + '\Start Sheet Metal.bat') or FileExists(Dir + '\current.txt')
    or FileExists(Dir + '\data\safa.sqlite') or FileExists(Dir + '\data\sheet-metal.sqlite');
end;

// A folder that does not exist yet, or exists with nothing in it.
function IsEmptyDir(Dir: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := True;
  Dir := RemoveBackslashUnlessRoot(Dir);
  if not DirExists(Dir) then Exit;
  if FindFirst(AddBackslash(Dir) + '*', FindRec) then begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then begin
          Result := False;
          Break;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

// Setup replaces src, public and node_modules in the folder: never in someone else's folder.
function FolderProblem(Dir: String): String;
begin
  Result := '';
  if IsEmptyDir(Dir) or IsPreviousInstall(Dir) then Exit;
  Result := 'الفولدر ده فيه ملفات تانية ومش فيه نسخة قديمة من البرنامج:' + #13#10 + Dir + #13#10#13#10 +
    'اختار فولدر فاضي أو فولدر جديد (مثلاً C:\SheetMetal)، أو الفولدر اللي البرنامج متثبت فيه.';
end;

// The launcher is a .bat file: Windows cmd can misread non-English characters in its own
// path, and the app must not live on a network drive (the database needs a local disk).
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Dir: String;
  Problem: String;
  I: Integer;
begin
  Result := True;
  if CurPageID <> wpSelectDir then Exit;
  Dir := WizardDirValue();
  Problem := FolderProblem(Dir);
  if Problem <> '' then begin
    MsgBox(Problem, mbError, MB_OK);
    Result := False;
    Exit;
  end;
  for I := 1 to Length(Dir) do
    if Ord(Dir[I]) > 126 then begin
      MsgBox('اسم الفولدر لازم يكون بحروف إنجليزية بس (مثلاً C:\SheetMetal).', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  if Copy(Dir, 1, 2) = '\\' then begin
    MsgBox('اختار فولدر على الكمبيوتر نفسه، مش على الشبكة.', mbError, MB_OK);
    Result := False;
  end;
end;

// Runs on every install, including an upgrade that skipped the folder page.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := FolderProblem(ExpandConstant('{app}'));
  if Result <> '' then Exit;
  StopApp();
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
  if CurStep <> ssPostInstall then Exit;
  // Which build this setup put next to the launcher (see the header).
  SaveStringToFile(ExpandConstant('{app}\setup-build.txt'), '{#Build}', False);
  if WizardIsTaskSelected('autostart') then WriteAutostart();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then StopApp();
end;
