# Publica el bot y los paneles en Cloudflare.
# Lo más fácil: doble clic en instalar.bat. O desde esta carpeta:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

function Fail($msg) { Write-Host "`n$msg" -ForegroundColor Red; exit 1 }
function Ask($label, [bool]$secret = $true) {
  if (-not $secret) { return (Read-Host $label) }
  $s = Read-Host $label -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function NewPassword {
  $chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  $b = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return (-join ($b | ForEach-Object { $chars[$_ % $chars.Length] }))
}
# Devuelve @{ value = ...; generated = $true/$false }
function AskPassword($label) {
  while ($true) {
    $p = Ask "$label (mínimo 10 caracteres, o Enter para generar una automática)"
    if (-not $p) { return @{ value = (NewPassword); generated = $true } }
    if ($p.Length -ge 10) { return @{ value = $p; generated = $false } }
    Write-Host "  Demasiado corta. Prueba otra vez." -ForegroundColor Yellow
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Falta Node.js. Instálalo con:  winget install OpenJS.NodeJS.LTS`nDespués cierra esta ventana, abre otra de PowerShell y vuelve a ejecutar el script."
}

Write-Host "`n[1/4] Instalando dependencias..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install ha fallado." }

Write-Host "`n[2/4] Iniciando sesión en Cloudflare (se abrirá el navegador)..." -ForegroundColor Cyan
npx wrangler login
if ($LASTEXITCODE -ne 0) { Fail "No se pudo iniciar sesión en Cloudflare." }

Write-Host "`n[3/4] Publicando el bot y los paneles..." -ForegroundColor Cyan
Write-Host "      (si te pregunta por un subdominio workers.dev, elige uno: será parte de tu dirección web)"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) {
  Fail "La publicación ha fallado. Si el error habla de la base de datos, mira 'Si usas otra cuenta de Cloudflare' en el README."
}

Write-Host "`n[4/4] Guardando contraseñas y claves (cifradas en Cloudflare, no se escriben en ningún archivo)" -ForegroundColor Cyan
Write-Host "      Pega el token de WhatsApp cuando te lo pida (no se verá en pantalla)."
$secrets = @{}
$t = Ask "Token de WhatsApp (empieza por EAA...)"
if (-not $t) { Fail "El token de WhatsApp es obligatorio." }
$secrets.WHATSAPP_TOKEN = $t.Trim()

$v = Ask "Token de verificación del webhook [Enter = <VERIFY_TOKEN_DE_PRUEBA>]" $false
$secrets.VERIFY_TOKEN = if ($v) { $v.Trim() } else { "<VERIFY_TOKEN_DE_PRUEBA>" }

$a = Ask "App secret de Meta (Ajustes de la app > Básico) [Enter = omitir, no recomendado]"
if ($a) { $secrets.APP_SECRET = $a.Trim() }

$admin = AskPassword "Contraseña del panel de ADMINISTRACIÓN"
$staff = AskPassword "Contraseña del panel de RECEPCIÓN"
while ($staff.value -eq $admin.value) { $staff = @{ value = (NewPassword); generated = $true } }
$secrets.ADMIN_PASSWORD = $admin.value
$secrets.STAFF_PASSWORD = $staff.value

$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secrets.SESSION_SECRET = [Convert]::ToBase64String($bytes)

$tmp = Join-Path $env:TEMP ("secretos-" + [guid]::NewGuid().ToString("N") + ".json")
try {
  [IO.File]::WriteAllText($tmp, ($secrets | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  npx wrangler secret bulk $tmp
  if ($LASTEXITCODE -ne 0) { Fail "No se pudieron guardar las claves." }
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
}

Write-Host "`nListo. ¿Qué dirección te ha dado Cloudflare? (la que acaba en .workers.dev, salió arriba)" -ForegroundColor Green
$url = (Read-Host "Pégala aquí para que te prepare los enlaces (o Enter para saltar)").Trim().TrimEnd("/")
if ($url) {
  Write-Host "`nWebhook para Meta (URL de devolución de llamada):  $url/webhook"
  Write-Host "Token de verificación:                              $($secrets.VERIFY_TOKEN)"
  Write-Host "Panel de administración:                            $url/admin"
  Write-Host "Panel de recepción:                                 $url/recepcion"
  Write-Host "Cartel con QR para clientes:                        $url/qr"
}
if ($admin.generated -or $staff.generated) {
  Write-Host "`nAPUNTA ESTAS CONTRASEÑAS (no se volverán a mostrar):" -ForegroundColor Yellow
  if ($admin.generated) { Write-Host "  Administración: $($admin.value)" }
  if ($staff.generated) { Write-Host "  Recepción:      $($staff.value)" }
}
Write-Host "`nSiguiente paso: pon esa URL del webhook en Meta (README, sección 3)." -ForegroundColor Green
