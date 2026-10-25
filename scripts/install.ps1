$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Shun standalone currently supports Windows x64.' }
$base = 'https://github.com/kyleslight/shun/releases/latest/download'
if ($env:SHUN_VERSION) {
  if ($env:SHUN_VERSION -notmatch '^\d+\.\d+\.\d+$') { throw 'SHUN_VERSION must be a release version.' }
  $base = "https://github.com/kyleslight/shun/releases/download/v$env:SHUN_VERSION"
}
$destination = if ($env:SHUN_INSTALL_DIR) { $env:SHUN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'ShunCLI' }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('shun-install-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $asset = 'shun-cli-win32-x64.zip'
  $archive = Join-Path $temporary $asset
  Write-Host 'Downloading Shun…'
  Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $archive
  $checksum = (Invoke-WebRequest -UseBasicParsing "$base/$asset.sha256").Content
  if ($checksum -is [byte[]]) { $checksum = [Text.Encoding]::UTF8.GetString($checksum) }
  if ($checksum -notmatch '^([a-fA-F0-9]{64})\s+shun-cli-win32-x64\.zip\s*$') { throw 'Invalid Shun checksum.' }
  if ((Get-FileHash -Algorithm SHA256 $archive).Hash -ne $Matches[1]) { throw 'Shun download verification failed.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $temporary
  $bundle = Join-Path $temporary 'shun'
  $version = (Get-Content (Join-Path $bundle 'VERSION') -Raw).Trim()
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Shun version.' }
  & (Join-Path $bundle 'runtime/node.exe') (Join-Path $bundle 'app/bin/shun.mjs') --version
  if ($LASTEXITCODE -ne 0) { throw 'The Shun installation check failed.' }
  $versions = Join-Path $destination 'versions'
  $bin = Join-Path $destination 'bin'
  New-Item -ItemType Directory -Force -Path $versions, $bin | Out-Null
  $target = Join-Path $versions $version
  if (!(Test-Path $target)) { Move-Item -LiteralPath $bundle -Destination $target }
  # The launcher points to an immutable version; upgrades never replace a running runtime.
  $launcher = "@echo off`r`ncall `"$target\shun.cmd`" %*`r`n"
  $staged = Join-Path $bin 'shun.cmd.new'
  [IO.File]::WriteAllText($staged, $launcher, [Text.Encoding]::Default)
  Move-Item -Force -LiteralPath $staged -Destination (Join-Path $bin 'shun.cmd')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', (([string]$userPath).TrimEnd(';') + ';' + $bin), 'User') }
  if (($env:Path -split ';') -notcontains $bin) { $env:Path += ';' + $bin }
  Write-Host "Shun $version installed. Run: shun"
} finally { Remove-Item -Recurse -Force -LiteralPath $temporary }
