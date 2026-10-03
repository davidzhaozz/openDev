<#
.SYNOPSIS
  Create (once) a local development code-signing certificate for OpenDev IDE.

.DESCRIPTION
  Generates a self-signed code-signing certificate, exports it as a .pfx
  outside the repository, and installs it into the current user's Trusted Root
  and Trusted Publishers stores so signatures made with it validate for this
  user. No administrator rights are required: every store touched is
  CurrentUser.

  What this buys, and what it does not:

    * It gives every build a STABLE SIGNER IDENTITY. Without it each
      `npm run dist:win` produces a brand-new unknown binary, so an EDR
      exclusion can only be written against a hash that is stale by the next
      build. With it, the exclusion can name the certificate instead.
    * It does NOT satisfy SmartScreen, which is reputation-based and ignores
      self-signed certificates entirely.
    * It does NOT make SentinelOne (or any managed EDR) trust the app on its
      own. The certificate is the thing IT can write an exclusion against; it
      is not the exclusion.

  To move to a purchased OV/EV certificate later, replace the .pfx and the
  password file in the output directory below. Nothing else changes.

.EXAMPLE
  powershell -NoProfile -File scripts\new-signing-cert.ps1
#>
[CmdletBinding()]
param(
  [string] $Subject = 'CN=OpenDev IDE (Development), O=OpenDev, C=US',
  [int]    $ValidYears = 5,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

$outDir = Join-Path $env:LOCALAPPDATA 'opendev-signing'
$pfxPath = Join-Path $outDir 'opendev-codesign.pfx'
$pwdPath = Join-Path $outDir 'opendev-codesign.pwd'
$cerPath = Join-Path $outDir 'opendev-codesign.cer'

# Deliberately outside the repository: a .pfx holds the private key and must
# never reach git, and keeping it out of the tree means no .gitignore rule has
# to be trusted to keep it there.
if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

if ((Test-Path $pfxPath) -and -not $Force) {
  Write-Host "[cert] already exists: $pfxPath"
  Write-Host "[cert] re-run with -Force to replace it."
  exit 0
}

Write-Host "[cert] generating self-signed code-signing certificate..."
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears($ValidYears)

Write-Host "[cert] thumbprint: $($cert.Thumbprint)"

# A random password, stored beside the .pfx. For a local development key this
# protects the file at rest rather than being a real secret; a purchased
# certificate's password should be supplied the same way but kept somewhere
# you actually control.
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$plainPwd = [Convert]::ToBase64String($bytes)
$securePwd = ConvertTo-SecureString -String $plainPwd -Force -AsPlainText

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePwd | Out-Null
Set-Content -Path $pwdPath -Value $plainPwd -Encoding utf8 -NoNewline
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

Write-Host "[cert] exported: $pfxPath"

# Install the public certificate as a trust anchor for THIS USER only.
# Import-Certificate into Root can raise an interactive confirmation dialog;
# the store API does the same thing without one.
$pub = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cerPath
foreach ($storeName in @('Root', 'TrustedPublisher')) {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
  $store.Open('ReadWrite')
  $existing = $store.Certificates.Find('FindByThumbprint', $cert.Thumbprint, $false)
  if ($existing.Count -eq 0) {
    $store.Add($pub)
    Write-Host "[cert] installed into CurrentUser\$storeName"
  } else {
    Write-Host "[cert] already present in CurrentUser\$storeName"
  }
  $store.Close()
}

Write-Host ''
Write-Host '[cert] done. To build signed:'
Write-Host '    . .\scripts\win-sign-env.ps1'
Write-Host '    npm run dist:win'
