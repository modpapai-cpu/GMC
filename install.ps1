Set-ExecutionPolicy Bypass -Scope Process -Force
Clear-Host

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "      GMC Vencord Auto Installer" -ForegroundColor White
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# =========================================================
# GMC WEBSITE / LICENSE API
# Change this URL only if your GMC website domain changes.
# =========================================================
$GmcApiBase = "https://gmc-tau.vercel.app"

# ADMIN CHECK
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if(!$admin){
    Write-Host "Please Run As Administrator" -ForegroundColor Red
    pause
    exit
}

function RefreshPath {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

# =========================
# WINGET CHECK
# =========================
if(Get-Command winget -ErrorAction SilentlyContinue){
    Write-Host "[✓] Winget Installed" -ForegroundColor Green
}else{
    Write-Host "[WARN] Winget Not Found - Skipping Winget..." -ForegroundColor Yellow
}

# =========================
# GIT CHECK
# =========================
if(Get-Command git -ErrorAction SilentlyContinue){
    Write-Host "[✓] Git Installed" -ForegroundColor Green
}else{
    Write-Host "Installing Git..."
    $git="$env:TEMP\git.exe"
    Invoke-WebRequest "https://github.com/git-for-windows/git/releases/download/v2.52.0.windows.1/Git-2.52.0-64-bit.exe" -OutFile $git
    Start-Process $git -ArgumentList "/VERYSILENT" -Wait
    RefreshPath
    if(!(Get-Command git -ErrorAction SilentlyContinue)){
        Write-Host "Git Install Failed!" -ForegroundColor Red
        pause
        exit
    }
}

# =========================
# NODE CHECK
# =========================
if(Get-Command node -ErrorAction SilentlyContinue){
    Write-Host "[✓] Node Installed" -ForegroundColor Green
}else{
    Write-Host "Installing Node LTS..."
    $node="$env:TEMP\node.msi"
    Invoke-WebRequest "https://nodejs.org/dist/v24.12.0/node-v24.12.0-x64.msi" -OutFile $node
    Start-Process msiexec.exe -ArgumentList "/i `"$node`" /qn" -Wait
    RefreshPath
    if(!(Get-Command npm -ErrorAction SilentlyContinue)){
        Write-Host "Node/NPM Install Failed!" -ForegroundColor Red
        pause
        exit
    }
}

# =========================
# PNPM CHECK
# =========================
$needPnpm="9.15.9"
RefreshPath
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
$currentPnpm = if($pnpmCmd){ pnpm --version }else{$null}

if($currentPnpm -eq $needPnpm){
    Write-Host "[✓] PNPM 9.15.9 Installed" -ForegroundColor Green
}else{
    if($currentPnpm){
        Write-Host "Removing PNPM $currentPnpm"
        npm uninstall -g pnpm
    }
    Write-Host "Installing PNPM 9.15.9..."
    npm install -g pnpm@9.15.9
    if($LASTEXITCODE -ne 0){
        Write-Host "PNPM Download Failed!" -ForegroundColor Red
        pause
        exit
    }
    RefreshPath
}

if(!(Get-Command pnpm -ErrorAction SilentlyContinue)){
    Write-Host "PNPM install failed!" -ForegroundColor Red
    pause
    exit
}
Write-Host "[OK] PNPM Ready: $(pnpm --version)" -ForegroundColor Green

# =========================
# VENCORD
# =========================
Set-Location C:\

if(!(Test-Path "C:\Vencord\package.json")){
    Write-Host "Installing Vencord..." -ForegroundColor Cyan
    if(Test-Path "C:\Vencord"){
        Remove-Item "C:\Vencord" -Recurse -Force
    }
    git clone https://github.com/Vendicated/Vencord.git C:\Vencord
    if($LASTEXITCODE -ne 0){
        Write-Host "Vencord Download Failed!" -ForegroundColor Red
        pause
        exit
    }
}

Set-Location C:\Vencord
Write-Host "[✓] Vencord Ready" -ForegroundColor Green

# =========================================================
# REMOVE PREVIOUS GMC PLUGIN SOURCES BEFORE THIS BUILD
# This guarantees ENTER/no-key mode really builds without GMC plugins.
# =========================================================
$pluginDefinitions = @{
    "GMCQUESTCOMPLEATER" = @{ folder="src\plugins\GMCQUESTCOMPLEATER" }
    "FakeDeafen"         = @{ folder="src\userplugins\FakeDeafen" }
    "voiceChatUtilities" = @{ folder="src\userplugins\voiceChatUtilities" }
    "followUser"         = @{ folder="src\userplugins\followUser" }
    "QUEST26"            = @{ folder="src\userplugins\QUEST26" }
    "QuestAutoComplete"  = @{ folder="src\userplugins\QuestAutoComplete" }
}

foreach($item in $pluginDefinitions.GetEnumerator()){
    $folder = Join-Path "C:\Vencord" $item.Value.folder
    if(Test-Path $folder){
        Remove-Item $folder -Recurse -Force
    }
}

# =========================================================
# LICENSE KEY
# ENTER = normal Vencord install without GMC plugins.
# A key is verified server-side before any plugin is downloaded.
# =========================================================
Write-Host ""
Write-Host "------------------------------------------" -ForegroundColor DarkCyan
Write-Host "Plugin License (Optional)" -ForegroundColor Cyan
Write-Host "Press ENTER to install Vencord without GMC plugins." -ForegroundColor Yellow
Write-Host "------------------------------------------" -ForegroundColor DarkCyan
$LicenseKey = Read-Host "Enter License Key"
$LicenseKey = $LicenseKey.Trim()

$PluginManifest = @()

if([string]::IsNullOrWhiteSpace($LicenseKey)){
    Write-Host ""
    Write-Host "[INFO] No license key provided." -ForegroundColor Yellow
    Write-Host "[INFO] GMC plugins will NOT be installed." -ForegroundColor Yellow
}else{
    Write-Host ""
    Write-Host "Checking GMC license..." -ForegroundColor Cyan

    try{
        $verifyUrl = "$GmcApiBase/api/plugin-license/verify?key=$([uri]::EscapeDataString($LicenseKey))"
        $licenseResponse = Invoke-RestMethod -Uri $verifyUrl -Method Get -ErrorAction Stop

        if($licenseResponse.valid -ne $true){
            throw "License is invalid or expired."
        }

        $PluginManifest = @($licenseResponse.plugins)
        if($PluginManifest.Count -lt 1){
            throw "This license has no active plugins assigned."
        }

        Write-Host "[✓] License Valid" -ForegroundColor Green
        if($licenseResponse.expiresAt){
            try{
                $expiry = [datetime]::Parse($licenseResponse.expiresAt).ToString("dd MMM yyyy")
                Write-Host "    Expires: $expiry" -ForegroundColor Gray
            }catch{}
        }else{
            Write-Host "    Validity: Lifetime" -ForegroundColor Gray
        }

        Write-Host ""
        Write-Host "Assigned Plugins:" -ForegroundColor Cyan
        foreach($plugin in $PluginManifest){
            Write-Host "  [✓] $($plugin.name)" -ForegroundColor Green
        }
    }
    catch{
        Write-Host ""
        Write-Host "[ERROR] License verification failed." -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Installation stopped. A valid license is required to install plugins." -ForegroundColor Red
        pause
        exit
    }
}

# =========================================================
# DOWNLOAD ASSIGNED PLUGINS
# =========================================================
function InstallPluginFromLicense($plugin){
    $name = [string]$plugin.name
    $url = [string]$plugin.downloadUrl
    $pathType = [string]$plugin.pathType

    if([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($url)){
        throw "Invalid plugin information received from GMC server."
    }

    $folder = if($pathType -eq "plugin"){
        "src\plugins\$name"
    }else{
        "src\userplugins\$name"
    }
    $target = Join-Path "C:\Vencord" $folder
    $zip = Join-Path $env:TEMP "$name-gmc.zip"
    $tmp = Join-Path $env:TEMP "$name-gmc"

    Write-Host ""
    Write-Host "Downloading $name..." -ForegroundColor Cyan

    $ProgressPreference = 'SilentlyContinue'
    try{
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -ErrorAction Stop
        if(!(Test-Path $zip)){ throw "Plugin ZIP was not downloaded." }

        if(Test-Path $tmp){ Remove-Item $tmp -Recurse -Force }
        Expand-Archive $zip $tmp -Force -ErrorAction Stop

        if(Test-Path $target){ Remove-Item $target -Recurse -Force }
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Copy-Item "$tmp\*" $target -Recurse -Force

        Write-Host "[✓] $name Installed" -ForegroundColor Green
    }
    catch{
        throw "Failed to install $name : $($_.Exception.Message)"
    }
    finally{
        if(Test-Path $zip){ Remove-Item $zip -Force -ErrorAction SilentlyContinue }
        if(Test-Path $tmp){ Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

if($PluginManifest.Count -gt 0){
    foreach($plugin in $PluginManifest){
        try{
            InstallPluginFromLicense $plugin
        }catch{
            Write-Host ""
            Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
            pause
            exit
        }
    }
}else{
    Write-Host ""
    Write-Host "[INFO] Continuing with Vencord only. No GMC plugins will be added." -ForegroundColor Yellow
}

# =========================
# BUILD
# =========================
Write-Host ""
Write-Host "Installing Packages..." -ForegroundColor Cyan
pnpm install --no-frozen-lockfile
if($LASTEXITCODE -ne 0){
    Write-Host "Package Install Failed!" -ForegroundColor Red
    pause
    exit
}

Write-Host ""
Write-Host "Building Vencord..." -ForegroundColor Blue
pnpm build
if($LASTEXITCODE -ne 0){
    Write-Host "Build Failed!" -ForegroundColor Red
    pause
    exit
}

Write-Host "Injecting..." -ForegroundColor Cyan
pnpm inject
if($LASTEXITCODE -ne 0){
    Write-Host "Inject Failed!" -ForegroundColor Red
    pause
    exit
}

Clear-Host
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "      GMC Vencord Auto Installer" -ForegroundColor White
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Clean GMC source folders after successful build
foreach($item in $pluginDefinitions.GetEnumerator()){
    $folder = Join-Path "C:\Vencord" $item.Value.folder
    if(Test-Path $folder){
        Remove-Item $folder -Recurse -Force
    }
}

# =========================
# DISCORD RESTART
# =========================
Write-Host "Restarting Discord..."
$discord="$env:LOCALAPPDATA\Discord\Update.exe"
if(Test-Path $discord){
    taskkill /F /IM Discord.exe 2>$null
    Start-Sleep -Seconds 2
    Start-Process $discord -ArgumentList "--processStart Discord.exe"
}

Write-Host ""
Write-Host "#############################################" -ForegroundColor Green
Write-Host "#                                           #" -ForegroundColor Green
Write-Host "#      GMC INSTALL COMPLETED SUCCESSFULLY   #" -ForegroundColor White -BackgroundColor DarkGreen
Write-Host "#                                           #" -ForegroundColor Green
Write-Host "#############################################" -ForegroundColor Green
Write-Host ""

if($PluginManifest.Count -gt 0){
    Write-Host "License: $LicenseKey" -ForegroundColor Cyan
    Write-Host "Plugins Installed: $($PluginManifest.Count)" -ForegroundColor Green
}else{
    Write-Host "Mode: Vencord Only (No GMC Plugins)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Press Enter To Exit..." -ForegroundColor Red
Read-Host | Out-Null
