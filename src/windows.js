// Windows-only helpers: keep the PC awake while the app runs, and start with Windows.
import fs from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { homeDir } from './paths.js';
import { httpError } from './util.js';

const isWindows = process.platform === 'win32';

// A hidden PowerShell asks Windows not to sleep for as long as this process lives.
export function keepAwake() {
  if (!isWindows) return;
  const script = `
Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[W.P]::SetThreadExecutionState(0x80000001) | Out-Null
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60 }`;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* not critical */ }
}

const startupFile = () => join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Sheet Metal.vbs');

export function autostartStatus() {
  const supported = isWindows && !!homeDir() && !!process.env.APPDATA;
  return { supported, enabled: supported && fs.existsSync(startupFile()) };
}

// A tiny script in the Startup folder runs the launcher minimized, without opening the browser.
export function setAutostart(on) {
  if (!autostartStatus().supported) throw httpError(409, 'الخاصية دي على ويندوز بس، من البرنامج المتثبت');
  if (!on) {
    fs.rmSync(startupFile(), { force: true });
    return autostartStatus();
  }
  const bat = join(homeDir(), 'Start Sheet Metal.bat').replace(/"/g, '');
  const vbs = `Set sh = CreateObject("WScript.Shell")\r\nsh.Environment("PROCESS")("OPEN") = "0"\r\nsh.Run """${bat}""", 7, False\r\n`;
  fs.writeFileSync(startupFile(), vbs);
  return autostartStatus();
}
