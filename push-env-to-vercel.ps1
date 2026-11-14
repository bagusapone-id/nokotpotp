# push-env-to-vercel.ps1
# Baca .env dan inject semua variabel ke Vercel project
# Jalankan sekali: .\push-env-to-vercel.ps1

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Error ".env file tidak ditemukan!"
    exit 1
}

Write-Host "`n=== Injecting .env ke Vercel ===" -ForegroundColor Cyan

# Parse .env — skip komentar dan baris kosong
$lines = Get-Content $envFile | Where-Object { $_ -match '^\s*[^#\s]' }

foreach ($line in $lines) {
    # Split key=value (value bisa mengandung = )
    $eqIdx = $line.IndexOf('=')
    if ($eqIdx -lt 1) { continue }

    $key   = $line.Substring(0, $eqIdx).Trim()
    $value = $line.Substring($eqIdx + 1).Trim()

    # Hapus surrounding quotes jika ada
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }

    # Skip jika kosong
    if ([string]::IsNullOrWhiteSpace($key)) { continue }

    Write-Host "  Setting $key ..." -NoNewline

    # Pipe value ke vercel env add (semua environments sekaligus)
    $value | npx vercel env add $key production 2>&1 | Out-Null
    $value | npx vercel env add $key preview    2>&1 | Out-Null

    Write-Host " OK" -ForegroundColor Green
}

Write-Host "`n=== Semua env berhasil di-set! ===" -ForegroundColor Green
Write-Host "Sekarang jalankan: npx vercel --prod" -ForegroundColor Yellow
