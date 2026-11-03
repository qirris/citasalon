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

Write-Host "`n[1/6] Instalando dependencias..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install ha fallado." }

Write-Host "`n[2/6] Iniciando sesión en Cloudflare (se abrirá el navegador)..." -ForegroundColor Cyan
npx wrangler login
if ($LASTEXITCODE -ne 0) { Fail "No se pudo iniciar sesión en Cloudflare." }

if (-not (Test-Path "schema.sql")) { Fail "Falta schema.sql; no se puede crear la base de datos." }

function ReplaceOnce([string]$text, [string]$pattern, [string]$value, [string]$label) {
  $m = [regex]::Match($text, $pattern)
  if (-not $m.Success) { Fail "No se pudo actualizar '$label' en wrangler.jsonc. Edítalo a mano antes de continuar; no se ha creado ningún recurso." }
  return $text.Substring(0, $m.Index) + $m.Groups[1].Value + $value + $m.Groups[2].Value + $text.Substring($m.Index + $m.Length)
}

Write-Host "`n[3/7] Nombres únicos de esta instalación..." -ForegroundColor Cyan
Write-Host "      Cada peluquería necesita su PROPIO Worker, su D1 y su cola." -ForegroundColor Yellow
Write-Host "      No reutilices los de otra instalación: se mezclarían los mensajes y los datos." -ForegroundColor Yellow

$workerName = (Ask "Nombre del Worker (Enter = citasalon)" $false).Trim()
if (-not $workerName) { $workerName = "citasalon" }
if ($workerName -notmatch '^[a-z0-9][a-z0-9-]{0,62}$') { Fail "Nombre de Worker no válido. Usa solo minúsculas, números y guiones (máx. 63 caracteres)." }

$dbName = (Ask "Nombre de la D1 (Enter = $workerName)" $false).Trim()
if (-not $dbName) { $dbName = $workerName }
if ($dbName -notmatch '^[a-z0-9][a-z0-9-]{0,62}$') { Fail "Nombre de D1 no válido. Usa solo minúsculas, números y guiones (máx. 63 caracteres)." }

$defaultQueue = $workerName + "-inbox"
if ($defaultQueue.Length -gt 63) { $defaultQueue = $workerName.Substring(0, 58) + "-inbox" }
$queueName = (Ask "Nombre de la cola (Enter = $defaultQueue)" $false).Trim()
if (-not $queueName) { $queueName = $defaultQueue }
if ($queueName -notmatch '^[a-z0-9][a-z0-9-]{0,62}$') { Fail "Nombre de cola no válido. Usa solo minúsculas, números y guiones (máx. 63 caracteres)." }

$confirm = (Ask "Escribe SI para crear el Worker '$workerName', la D1 vacía '$dbName' y la cola '$queueName' (cualquier otra respuesta cancela)" $false).Trim().ToUpper()
if ($confirm -ne "SI") { Fail "Instalación cancelada. No se ha creado ni modificado ningún recurso." }

$d1Out = (& npx wrangler d1 create $dbName 2>&1 | Out-String)
Write-Host $d1Out
if ($LASTEXITCODE -ne 0) {
  Fail "No se pudo crear la D1 '$dbName'. Si ya existe en tu cuenta, NO se reutiliza automáticamente: elige otro nombre o bórrala a mano si estás seguro de que está vacía. No se ha desplegado nada."
}
$d1Match = [regex]::Match($d1Out, 'database_id\s*=\s*"([0-9a-fA-F-]{36})"')
if (-not $d1Match.Success) {
  Fail "La D1 se creó pero no se pudo leer su database_id. Cópialo a mano desde el panel de Cloudflare y pégalo en wrangler.jsonc antes de continuar."
}
$d1Id = $d1Match.Groups[1].Value

# Apunta el proyecto al Worker, la D1 y la cola recién creados (nunca a los de otra instalación).
$cfgPath = Join-Path $PSScriptRoot "wrangler.jsonc"
$cfg = [IO.File]::ReadAllText($cfgPath)
$cfg = ReplaceOnce $cfg '(?m)^(\s*"name"\s*:\s*")[^"]*(")' $workerName "name (Worker)"
$cfg = ReplaceOnce $cfg '("database_name"\s*:\s*")[^"]*(")' $dbName "database_name"
$cfg = ReplaceOnce $cfg '("database_id"\s*:\s*")[^"]*(")' $d1Id "database_id"
$cfg = [regex]::Replace($cfg, '("queue"\s*:\s*")[^"]*(")', ('${1}' + $queueName + '${2}'))
if ($cfg -notmatch ('"name"\s*:\s*"' + [regex]::Escape($workerName) + '"') -or
    $cfg -notmatch ('"database_name"\s*:\s*"' + [regex]::Escape($dbName) + '"') -or
    $cfg -notmatch ('"database_id"\s*:\s*"' + [regex]::Escape($d1Id) + '"') -or
    $cfg -notmatch ('"queue"\s*:\s*"' + [regex]::Escape($queueName) + '"')) {
  Fail "wrangler.jsonc no quedó actualizado con los nombres nuevos. Edítalo a mano antes de desplegar."
}
[IO.File]::WriteAllText($cfgPath, $cfg, (New-Object Text.UTF8Encoding($false)))
Write-Host "      wrangler.jsonc apunta ahora al Worker '$workerName', la D1 '$dbName' ($d1Id) y la cola '$queueName'." -ForegroundColor Green

Write-Host "`n[4/7] Aplicando el esquema completo (solo estructura, sin datos de clientes)..." -ForegroundColor Cyan
npx wrangler d1 execute $dbName --remote --file=schema.sql
if ($LASTEXITCODE -ne 0) {
  Fail "El esquema no se pudo aplicar. La D1 '$dbName' está vacía; corrige el error y ejecuta a mano: npx wrangler d1 execute $dbName --remote --file=schema.sql. No se ha desplegado el Worker."
}

Write-Host "`n[5/7] Creando la cola de WhatsApp '$queueName'..." -ForegroundColor Cyan
$qOut = (& npx wrangler queues create $queueName 2>&1 | Out-String)
Write-Host $qOut
if ($LASTEXITCODE -ne 0) {
  $queues = (& npx wrangler queues list 2>&1 | Out-String)
  if ($queues -match [regex]::Escape($queueName)) {
    Write-Host "      La cola '$queueName' ya existía; se reutiliza." -ForegroundColor Yellow
    Write-Host "      Aviso: solo debe usarla esta instalación. No la compartas con otra peluquería." -ForegroundColor Yellow
  } else {
    Fail "No se pudo crear la cola '$queueName' ni confirmar que existe. Créala a mano con: npx wrangler queues create $queueName. No se ha desplegado el Worker."
  }
}

Write-Host "`n[6/7] Publicando el bot y los paneles..." -ForegroundColor Cyan
Write-Host "      (si te pregunta por un subdominio workers.dev, elige uno: será parte de tu dirección web)"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) {
  Fail "La publicación ha fallado. Revisa el error. La D1 y la cola ya están creadas; no vuelvas a ejecutar este script desde cero: despliega a mano con 'npx wrangler deploy' cuando lo corrijas."
}

Write-Host "`n[7/7] Guardando contraseñas y claves (cifradas en Cloudflare, no se escriben en ningún archivo)" -ForegroundColor Cyan
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
