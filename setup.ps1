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
  Fail "La publicación ha fallado. Si el error habla de la base de datos, revisa 'Base de datos D1' en docs/PUESTA_EN_MARCHA.md (sección 3)."
}

Write-Host "`n[4/4] Guardando contraseñas y claves (cifradas en Cloudflare, no se escriben en ningún archivo)" -ForegroundColor Cyan
Write-Host "      El token de WhatsApp es opcional: si lo dejas vacío, el bot funcionará en modo consola."
$secrets = @{}
$t = Ask "Token de WhatsApp (empieza por EAA...; Enter = modo consola, sin envío real)"
if ($t.Trim()) { $secrets.WHATSAPP_TOKEN = $t.Trim() }

$v = Ask "Token de verificación del webhook (Enter = generar uno aleatorio)" $false
$secrets.VERIFY_TOKEN = if ($v.Trim()) { $v.Trim() } else { NewPassword }

$a = Ask "App secret de Meta (Ajustes de la app > Básico) [Enter = omitir, no recomendado]"
if ($a.Trim()) { $secrets.APP_SECRET = $a.Trim() }

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

if (-not $secrets.ContainsKey("WHATSAPP_TOKEN")) {
  Write-Host "`nSin WHATSAPP_TOKEN: el bot queda en modo consola (no envía mensajes reales)." -ForegroundColor Yellow
}

Write-Host "`nListo. ¿Qué dirección te ha dado Cloudflare? (la que acaba en .workers.dev, salió arriba)" -ForegroundColor Green
$url = (Read-Host "Pégala aquí para que te prepare los enlaces (o Enter para saltar)").Trim().TrimEnd("/")
if ($url) {
  Write-Host "`nPanel de administración:                            $url/admin"
  Write-Host "Panel de recepción:                                 $url/recepcion"
  Write-Host "Cartel con QR para clientes:                        $url/qr"
  if ($secrets.ContainsKey("WHATSAPP_TOKEN")) {
    Write-Host "Webhook para Meta (URL de devolución de llamada):  $url/webhook"
    Write-Host "Token de verificación:                              $($secrets.VERIFY_TOKEN)"
  } else {
    Write-Host "Webhook para Meta:                                  $url/webhook (solo si activas WhatsApp)"
    Write-Host "Token de verificación:                              $($secrets.VERIFY_TOKEN) (solo si activas WhatsApp)"
  }
}
if ($admin.generated -or $staff.generated) {
  Write-Host "`nAPUNTA ESTAS CONTRASEÑAS (no se volverán a mostrar):" -ForegroundColor Yellow
  if ($admin.generated) { Write-Host "  Administración: $($admin.value)" }
  if ($staff.generated) { Write-Host "  Recepción:      $($staff.value)" }
}
Write-Host "`nSiguiente paso: pon esa URL del webhook en Meta (docs/PUESTA_EN_MARCHA.md, sección 6)." -ForegroundColor Green
