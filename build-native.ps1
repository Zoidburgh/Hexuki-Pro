# Build the Hexuki engine to a native Windows exe using the portable MinGW in tools/.
# Self-contained (static-linked, no DLLs), threaded (-pthread). Mirrors the WASM build flags.
# Output: native/hexuki-solve.exe   (gitignored build artifact)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$gpp = Join-Path $root 'tools\mingw64\bin\g++.exe'
if (-not (Test-Path $gpp)) { Write-Error "MinGW not found at $gpp (run the toolchain download/extract first)"; exit 1 }

$engine = Join-Path $root 'c++engine'
$out = Join-Path $root 'native'
New-Item -ItemType Directory -Force $out | Out-Null

Push-Location $engine
$sw = [System.Diagnostics.Stopwatch]::StartNew()
& $gpp -O3 -DNDEBUG -DHEXUKI_THREADS -march=native -std=c++17 -flto -pthread -static -static-libgcc -static-libstdc++ -I include `
    src/core/bitboard.cpp src/core/move.cpp src/core/zobrist.cpp src/ai/minimax.cpp src/native_solve.cpp `
    -o (Join-Path $out 'hexuki-solve.exe')
$code = $LASTEXITCODE
$sw.Stop()
Pop-Location
if ($code -ne 0) { Write-Error "Native build FAILED (exit $code)"; exit 1 }
"Native build OK in $([math]::Round($sw.Elapsed.TotalSeconds,1))s -> native/hexuki-solve.exe"
