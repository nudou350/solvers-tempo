# Recreates the disposable QA database (solvers_tempo_qa on the solvers-tempo-pg container, port 5546), migrates it with
# apps/server/.env.qa and empties the local QA data folders. NEVER points at 5433/5543/5544 nor at the solvers_tempo or
# solvers_tempo_test databases (the migration uses ONLY apps/server/.env.qa). Stop the QA API first (it keeps connections
# open). The chain (anvil) is not touched: scripts/src/bootstrap.ts recreates chain + database together.
#   powershell -File scripts/qa-reset.ps1
$ErrorActionPreference = "Stop"
$server = Join-Path $PSScriptRoot "..\apps\server"
$envQa = Join-Path $server ".env.qa"
if (-not (Test-Path $envQa)) { throw "apps/server/.env.qa is missing: run 'cd scripts && npx tsx src/bootstrap.ts' first" }
$dbUrl = (Get-Content $envQa | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=', ''
if ($dbUrl -notmatch '@127\.0\.0\.1:5546/solvers_tempo_qa$') { throw ".env.qa DATABASE_URL is not the QA database (127.0.0.1:5546/solvers_tempo_qa)" }
$dbPort = ([uri]($dbUrl -replace '^postgres(ql)?://', 'http://')).Port
if ($dbPort -ne 5546) { throw ".env.qa DATABASE_URL port is $dbPort, not 5546 (the QA container)" }

docker exec solvers-tempo-pg psql -U solvers -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS solvers_tempo_qa WITH (FORCE)"
if ($LASTEXITCODE -ne 0) { throw "drop failed" }
docker exec solvers-tempo-pg psql -U solvers -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE solvers_tempo_qa"
if ($LASTEXITCODE -ne 0) { throw "create failed" }
docker exec solvers-tempo-pg psql -U solvers -d solvers_tempo_qa -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector"
if ($LASTEXITCODE -ne 0) { throw "extension failed" }
# node --env-file never overrides a variable already set in the shell: remove every variable .env.qa defines, the pinned
# ones (database, chain, token, treasury, admin wallets) and every *_PRIVATE_KEY from this process before running node,
# so the migration can only see .env.qa's values. They are restored afterwards (in case the script was dot-sourced).
$fileKeys = Get-Content $envQa | Where-Object { $_ -match '^\s*[A-Z0-9_]+\s*=' } | ForEach-Object { ($_ -split '=', 2)[0].Trim() }
$pinned = "DATABASE_URL", "TEST_DATABASE_URL", "CHAIN_ID", "RPC_URL", "DEPLOYMENTS_FILE", "PAYMENT_TOKEN", "PAYMENT_TOKEN_DECIMALS", "TREASURY_ADDRESS", "ADMIN_WALLETS"
$saved = @{}
foreach ($item in @(Get-ChildItem Env:)) {
  if (($fileKeys -contains $item.Name) -or ($pinned -contains $item.Name) -or ($item.Name -like '*_PRIVATE_KEY')) {
    $saved[$item.Name] = $item.Value
    Remove-Item "Env:$($item.Name)"
  }
}
Push-Location $server
try {
  node --env-file=.env.qa --import tsx src/db/migrate.ts
  if ($LASTEXITCODE -ne 0) { throw "migration failed" }
} finally {
  Pop-Location
  foreach ($k in $saved.Keys) { Set-Item "Env:$k" $saved[$k] }
}
foreach ($d in "submissions", "packages", "deliverables") {
  $p = Join-Path $server ".qa-data\$d"
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
  New-Item -ItemType Directory -Force $p | Out-Null
}
Remove-Item (Join-Path $server ".qa-data\e2e-state.json") -ErrorAction SilentlyContinue
"solvers_tempo_qa recreated and migrated; .qa-data emptied (keys kept). Re-seed (in a shell without DATABASE_URL, CHAIN_ID, RPC_URL or keys set, which would override .env.qa): cd apps/server && node --env-file=.env.qa --import tsx src/cli/publish.ts --no-chain"
