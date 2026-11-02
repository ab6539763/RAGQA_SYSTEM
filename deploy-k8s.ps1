$ErrorActionPreference = 'Stop'
$Kubectl = 'C:\Program Files\Docker\Docker\resources\bin\kubectl.exe'
$Docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$Project = Split-Path -Parent $MyInvocation.MyCommand.Path
$Namespace = 'agent-qa'
$Image = 'agent-qa-api:local'
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('agent-qa-k8s-' + [guid]::NewGuid().ToString('N'))
$Forwards = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$ComposeStopped = $false
$MigrationCompleted = $false

function Invoke-Checked([string]$Exe, [string[]]$CliArgs) {
  & $Exe @CliArgs
  if ($LASTEXITCODE -ne 0) { throw "命令失败（$LASTEXITCODE）：$([System.IO.Path]::GetFileName($Exe))" }
}

function Read-ProjectEnv {
  $values = @{}
  $envFile = Join-Path $Project '.env'
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
        $value = $matches[2].Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1, $value.Length - 2) }
        $values[$matches[1]] = $value
      }
    }
  }
  return $values
}

function Start-LoopbackForward([string]$Service, [string]$Mapping) {
  $process = Start-Process -FilePath $Kubectl -ArgumentList @('port-forward', '-n', $Namespace, "svc/$Service", $Mapping, '--address=127.0.0.1') -WindowStyle Hidden -PassThru
  $Forwards.Add($process)
  return $process
}

function Stop-PortForwards {
  foreach ($process in $Forwards) {
    try { if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force } } catch {}
  }
  $Forwards.Clear()
}

try {
  New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $Project '.env'))) { throw '缺少 .env；请先按 README 配置模型密钥和运行密码。' }
  $context = & $Kubectl config current-context 2>$null
  if ($LASTEXITCODE -ne 0 -or $context -ne 'docker-desktop') { throw 'Docker Desktop Kubernetes 尚未启用。请在 Docker Desktop 的 Kubernetes 页面创建集群后重新运行此脚本。' }
  Invoke-Checked $Kubectl @('wait', '--for=condition=Ready', 'node', '--all', '--timeout=120s')

  $envValues = Read-ProjectEnv
  $secretValues = @{
    LLM_API_KEY = if ($envValues.ContainsKey('LLM_API_KEY')) { $envValues.LLM_API_KEY } else { '' }
    POSTGRES_PASSWORD = if ($envValues.ContainsKey('POSTGRES_PASSWORD')) { $envValues.POSTGRES_PASSWORD } else { 'change-this-postgres-password' }
    PGPASSWORD = if ($envValues.ContainsKey('POSTGRES_PASSWORD')) { $envValues.POSTGRES_PASSWORD } else { 'change-this-postgres-password' }
    S3_ACCESS_KEY = if ($envValues.ContainsKey('S3_ACCESS_KEY')) { $envValues.S3_ACCESS_KEY } else { 'agentqa' }
    S3_SECRET_KEY = if ($envValues.ContainsKey('S3_SECRET_KEY')) { $envValues.S3_SECRET_KEY } else { 'change-this-object-storage-password' }
    S3_ADMIN_PASSWORD = if ($envValues.ContainsKey('S3_ADMIN_PASSWORD')) { $envValues.S3_ADMIN_PASSWORD } else { 'change-this-storage-admin-password' }
    GRAFANA_USER = if ($envValues.ContainsKey('GRAFANA_USER')) { $envValues.GRAFANA_USER } else { 'admin' }
    GRAFANA_PASSWORD = if ($envValues.ContainsKey('GRAFANA_PASSWORD')) { $envValues.GRAFANA_PASSWORD } else { 'change-this-grafana-password' }
  }

  Invoke-Checked $Docker @('build', '-t', $Image, '.')
  $archive = Join-Path $TempRoot 'agent-qa-api.tar'
  Invoke-Checked $Docker @('save', '-o', $archive, $Image)
  $nodes = @(& $Docker ps --filter 'label=io.x-k8s.kind.cluster' --format '{{.Names}}')
  if ($LASTEXITCODE -ne 0 -or $nodes.Count -eq 0) { throw '找不到 Docker Desktop Kind 节点容器，无法导入本地应用镜像。' }
  foreach ($node in $nodes) {
    Invoke-Checked $Docker @('cp', $archive, "${node}:/root/agent-qa-api.tar")
    Invoke-Checked $Docker @('exec', $node, 'ctr', '-n', 'k8s.io', 'images', 'import', '/root/agent-qa-api.tar')
    Invoke-Checked $Docker @('exec', $node, 'rm', '-f', '/root/agent-qa-api.tar')
  }

  Invoke-Checked $Kubectl @('apply', '-f', (Join-Path $Project 'k8s/namespace.yaml'))
  $secretArgs = @('create', 'secret', 'generic', 'agent-qa-secrets', '-n', $Namespace)
  foreach ($key in $secretValues.Keys) { $secretArgs += "--from-literal=$key=$($secretValues[$key])" }
  $secretArgs += @('--dry-run=client', '-o', 'yaml')
  $secretYaml = & $Kubectl @secretArgs
  if ($LASTEXITCODE -ne 0) { throw '生成 Kubernetes Secret 失败。' }
  $secretYaml | & $Kubectl apply -f -
  if ($LASTEXITCODE -ne 0) { throw '写入 Kubernetes Secret 失败。' }

  Invoke-Checked $Kubectl @('apply', '-n', $Namespace, '-f', (Join-Path $Project 'k8s/config.yaml'))
  Invoke-Checked $Kubectl @('apply', '-n', $Namespace, '-f', (Join-Path $Project 'k8s/data-services.yaml'))
  foreach ($statefulSet in @('postgres', 'redis', 'seaweedfs', 'qdrant', 'ollama')) {
    Invoke-Checked $Kubectl @('rollout', 'status', "statefulset/$statefulSet", '-n', $Namespace, '--timeout=30m')
  }

  Invoke-Checked $Docker @('compose', 'stop', 'nginx')
  $ComposeStopped = $true
  $queueDrained = $false
  for ($i = 0; $i -lt 60; $i++) {
    $waiting = & $Docker compose exec -T redis redis-cli LLEN bull:agent-qa-chat:wait
    $active = & $Docker compose exec -T redis redis-cli LLEN bull:agent-qa-chat:active
    $delayed = & $Docker compose exec -T redis redis-cli ZCARD bull:agent-qa-chat:delayed
    if ($LASTEXITCODE -ne 0) { throw '无法确认问答队列状态，停止迁移以避免丢失待处理任务。' }
    if ([int]($waiting | Select-Object -Last 1) -eq 0 -and [int]($active | Select-Object -Last 1) -eq 0 -and [int]($delayed | Select-Object -Last 1) -eq 0) { $queueDrained = $true; break }
    Start-Sleep -Seconds 5
  }
  if (-not $queueDrained) { throw '问答队列未在 5 分钟内排空；Docker Compose 已恢复，请稍后重试。' }
  Invoke-Checked $Docker @('compose', 'stop', 'api', 'worker')

  $sourcePostgres = (& $Docker compose ps -q postgres | Select-Object -First 1).Trim()
  if (-not $sourcePostgres) { throw '找不到 Docker Compose PostgreSQL 容器。' }
  $targetSchema = & $Kubectl exec -n $Namespace postgres-0 -c postgres -- psql -U agentqa -d agentqa -Atc "SELECT to_regclass('public.sessions') IS NOT NULL"
  if ($LASTEXITCODE -ne 0) { throw '无法检查 Kubernetes PostgreSQL；停止迁移以保护数据。' }
  if ($targetSchema -match 't') {
    $fingerprintQuery = @'
SELECT 'sessions',md5(coalesce(string_agg(md5(to_jsonb(s)::text),'' ORDER BY id),'')) FROM sessions s
UNION ALL SELECT 'messages',md5(coalesce(string_agg(md5(to_jsonb(m)::text),'' ORDER BY id),'')) FROM messages m
UNION ALL SELECT 'documents',md5(coalesce(string_agg(md5(jsonb_build_object('id',d.id,'title',d.title,'content',d.content,'size',d.size,'object_key',d.object_key,'uploaded_at',d.uploaded_at)::text),'' ORDER BY id),'')) FROM documents d
ORDER BY 1;
'@
    $sourceFingerprint = @(& $Docker exec $sourcePostgres psql -U agentqa -d agentqa -Atc $fingerprintQuery)
    $targetFingerprint = @(& $Kubectl exec -n $Namespace postgres-0 -c postgres -- psql -U agentqa -d agentqa -Atc $fingerprintQuery)
    if ($LASTEXITCODE -ne 0 -or (($sourceFingerprint -join "`n") -cne ($targetFingerprint -join "`n"))) {
      throw 'Kubernetes PostgreSQL already contains different application data; automatic import stopped to avoid overwriting either copy.'
    }
    Write-Host 'Kubernetes PostgreSQL already matches the Compose snapshot; resuming without a duplicate restore.'
  } else {
    Invoke-Checked $Docker @('exec', $sourcePostgres, 'sh', '-ec', 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /tmp/agent-qa-k8s.dump')
    $dumpFile = Join-Path $TempRoot 'agent-qa-k8s.dump'
    Invoke-Checked $Docker @('cp', "${sourcePostgres}:/tmp/agent-qa-k8s.dump", $dumpFile)
    Push-Location $TempRoot
    try { Invoke-Checked $Kubectl @('cp', './agent-qa-k8s.dump', "$Namespace/postgres-0:/tmp/agent-qa-k8s.dump", '-c', 'postgres') } finally { Pop-Location }
    Invoke-Checked $Kubectl @('exec', '-n', $Namespace, 'postgres-0', '-c', 'postgres', '--', 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'agentqa', '-d', 'agentqa', '/tmp/agent-qa-k8s.dump')
    Invoke-Checked $Kubectl @('exec', '-n', $Namespace, 'postgres-0', '-c', 'postgres', '--', 'rm', '-f', '/tmp/agent-qa-k8s.dump')
    Invoke-Checked $Docker @('exec', $sourcePostgres, 'rm', '-f', '/tmp/agent-qa-k8s.dump')
  }
  Invoke-Checked $Kubectl @('exec', '-n', $Namespace, 'postgres-0', '-c', 'postgres', '--', 'psql', '-U', 'agentqa', '-d', 'agentqa', '-v', 'ON_ERROR_STOP=1', '-c', 'DELETE FROM vector_index_state; UPDATE documents SET index_status=''pending'', index_error=NULL;')

  $null = Start-LoopbackForward 'seaweedfs' '18333:8333'
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try { $client = [System.Net.Sockets.TcpClient]::new(); $client.Connect('127.0.0.1', 18333); $client.Dispose(); $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) { throw 'SeaweedFS Kubernetes 端口转发未就绪。' }
  Push-Location $Project
  try { Invoke-Checked 'node' @('scripts/migrate-s3-to-k8s.js') } finally { Pop-Location }
  Stop-PortForwards

  Invoke-Checked $Kubectl @('apply', '-k', (Join-Path $Project 'k8s'))
  foreach ($deployment in @('api', 'worker', 'nginx', 'prometheus', 'grafana')) {
    Invoke-Checked $Kubectl @('rollout', 'status', "deployment/$deployment", '-n', $Namespace, '--timeout=10m')
  }

  Invoke-Checked $Docker @('compose', 'stop')
  $ComposeStopped = $false
  # 入口由 k8s/web-entry.yaml 的 LoadBalancer Service 直接发布到 127.0.0.1，
  # 不再使用 kubectl port-forward（后者会在 Docker Desktop 重启后失效，
  # 且会与 LoadBalancer 抢同一批宿主端口）。
  foreach ($service in @('nginx-web', 'grafana-web', 'prometheus-web')) {
    $exposed = $false
    for ($i = 0; $i -lt 90; $i++) {
      $address = & $Kubectl get svc $service -n $Namespace -o 'jsonpath={.status.loadBalancer.ingress[0].ip}' 2>$null
      if ($LASTEXITCODE -eq 0 -and $address) { $exposed = $true; break }
      Start-Sleep -Seconds 2
    }
    if (-not $exposed) { throw "LoadBalancer Service $service 未在 3 分钟内获得外部地址。" }
  }
  $healthy = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $response = Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:18080/api/health
      if ($response.status -eq 'ok') { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $healthy) { throw 'Kubernetes 应用健康检查失败，已准备回退到 Docker Compose。' }
  $MigrationCompleted = $true
  Write-Host '迁移完成：问答 http://127.0.0.1:18080，Grafana http://127.0.0.1:3001，Prometheus http://127.0.0.1:9090。'
} catch {
  Stop-PortForwards
  if ($ComposeStopped) { & $Docker compose start; $ComposeStopped = $false }
  throw
} finally {
  if (-not $MigrationCompleted) {
    Stop-PortForwards
    if ($ComposeStopped) { & $Docker compose start }
  }
  if (Test-Path -LiteralPath $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force }
}
