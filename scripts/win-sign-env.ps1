<#
.SYNOPSIS
  Point electron-builder at the local code-signing certificate. Dot-source it.

.DESCRIPTION
  electron-builder signs the Windows binaries whenever CSC_LINK and
  CSC_KEY_PASSWORD are present in the environment, and scripts/sign-ps1.mjs
  reads the same two variables to sign resources/procmap.ps1. This sets both
  from the certificate written by scripts/new-signing-cert.ps1.

  Must be DOT-SOURCED, so the variables land in the calling shell:

      . .\scripts\win-sign-env.ps1
      npm run dist:win

  Running it normally (.\scripts\win-sign-env.ps1) sets them in a child shell
  that exits immediately, and the build comes out unsigned with no error.

  To build with a purchased certificate instead, set the two variables by hand
  or replace the .pfx/.pwd pair in the directory below.
#>

$signDir = Join-Path $env:LOCALAPPDATA 'opendev-signing'
$pfxPath = Join-Path $signDir 'opendev-codesign.pfx'
$pwdPath = Join-Path $signDir 'opendev-codesign.pwd'

if (-not (Test-Path $pfxPath)) {
  Write-Warning "No signing certificate at $pfxPath."
  Write-Warning "Run: powershell -NoProfile -File scripts\new-signing-cert.ps1"
  return
}

$env:CSC_LINK = $pfxPath
if (Test-Path $pwdPath) {
  $env:CSC_KEY_PASSWORD = (Get-Content $pwdPath -Raw).Trim()
}

Write-Host "[sign] CSC_LINK = $env:CSC_LINK"
Write-Host "[sign] CSC_KEY_PASSWORD is set ($($env:CSC_KEY_PASSWORD.Length) chars)"
