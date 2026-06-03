# Rebuild the C++ engine to a Node-capable WASM module for benchmarking.
# Same optimization flags as the production web build (build_wasm.bat) MINUS
# --closure 1 (needs Java; only minifies JS glue, not the .wasm) PLUS node env.
# Output: bench/engine/hexuki.{js,wasm}
$ErrorActionPreference = 'Stop'
$env:EMSDK_QUIET = 1
& 'C:\Users\Zoidburgh\Desktop\emsdk\emsdk-main\emsdk_env.ps1' | Out-Null

$root   = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $root 'c++engine'
$out    = Join-Path $PSScriptRoot 'engine'
New-Item -ItemType Directory -Force $out | Out-Null

Set-Location $engine
$sw = [System.Diagnostics.Stopwatch]::StartNew()
emcc -O3 -std=c++17 -I include `
  src/core/bitboard.cpp src/core/move.cpp src/core/zobrist.cpp `
  src/ai/mcts.cpp src/ai/mcts_node.cpp src/ai/minimax.cpp src/wasm_interface.cpp `
  -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s MODULARIZE=1 -sEXPORT_NAME=HexukiWasm `
  -s "ENVIRONMENT=web,node" -s ASSERTIONS=0 -s DISABLE_EXCEPTION_CATCHING=1 -s NO_FILESYSTEM=1 `
  -flto -lembind -o (Join-Path $out 'hexuki.js')
$sw.Stop()
if ($LASTEXITCODE -ne 0) { Write-Error "Build FAILED (exit $LASTEXITCODE)"; exit 1 }
"Build OK in $([math]::Round($sw.Elapsed.TotalSeconds,1))s -> bench/engine/hexuki.{js,wasm}"
