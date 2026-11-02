# 寻知 · Agent 智能问答 —— 开发 / 测试 / 调试 / 部署手册

> 适用代码：`agent-qa-studio` v1.0.0（本仓库当前状态）
> 目标平台：Windows 11 + Docker Desktop（WSL2 后端）
> 编写基线：2026-11-01，全部命令与结论均在本机实测验证

---

## 目录

1. [系统概览](#1-系统概览)
2. [代码结构](#2-代码结构)
3. [配置参考](#3-配置参考)
4. [本地开发](#4-本地开发)
5. [测试](#5-测试)
6. [调试](#6-调试)
7. [部署](#7-部署)
8. [运维](#8-运维)
9. [故障案例库](#9-故障案例库)
10. [安全清单](#10-安全清单)
11. [附录](#11-附录)

---

## 1. 系统概览

### 1.1 它是什么

一个中文 RAG 问答系统：支持 SSE 流式回答、知识库检索与来源引用、联网搜索、图片多模态输入、文档上传与向量索引。生产形态为**无状态 API + 独立 Worker + 四个共享后端**。

### 1.2 架构与请求链路

```
┌────────────┐   SSE /api/chat    ┌──────────┐
│  浏览器     │ ─────────────────► │  Nginx   │
│ public/*   │                    └────┬─────┘
└────────────┘                         │ 反向代理
                                       ▼
                              ┌─────────────────┐
                              │  API (server.js)│  ×2 副本，无状态
                              └───┬────────┬────┘
                   入队 chat job  │        │ 回传事件 (Redis Pub/Sub)
                                  ▼        │
                        ┌──────────────┐   │
                        │ Redis/BullMQ │◄──┘
                        └──────┬───────┘
                               │ 消费
                               ▼
                        ┌──────────────┐
                        │ Worker       │
                        │ (worker.js)  │
                        └──┬────┬───┬──┘
                           │    │   │
              ┌────────────┘    │   └──────────────┐
              ▼                 ▼                  ▼
      ┌──────────────┐  ┌──────────────┐  ┌────────────────┐
      │ Qdrant 向量   │  │ Ollama       │  │ DeepSeek API   │
      │ (检索)        │  │ (embedding)  │  │ (生成/联网搜索) │
      └──────────────┘  └──────────────┘  └────────────────┘

      PostgreSQL：会话 / 消息 / 文档 / 向量索引状态
      SeaweedFS(S3)：上传的文档与图片对象
```

**一次问答的完整时序**

1. 浏览器 `POST /api/chat`，API 校验参数 → 写入用户消息 → 建 BullMQ 任务 → 立即切到 SSE。
2. API 订阅 `agent-qa:chat:<jobId>` 频道，每 15s 发一次心跳注释帧。
3. Worker 取出任务：读附件 → `retrieve()` 检索 → （可选）联网搜索 → 申请全局模型并发槽位 → 调 DeepSeek 流式生成。
4. 每个 delta 通过 Redis Pub/Sub 发回 API，API 原样转发给浏览器。
5. 结束时 Worker 落库助手消息，发 `done` 事件；API 收到后关闭 SSE。

### 1.3 组件职责

| 组件 | 职责 | 缺席后果 |
|---|---|---|
| `server.js` | HTTP API、SSE、上传、限流、Prometheus 指标、静态页 | 全站不可用 |
| `worker.js` | 问答生成、模型并发槽、文档解析与向量索引 | 提问永久排队、文档永远 pending |
| PostgreSQL | 会话、消息、文档、`vector_index_state`、迁移记录 | **进程无法启动**（启动即建表） |
| Redis | BullMQ 队列、SSE 事件、限流计数、模型并发槽 | **进程无法启动**（启动即 ping） |
| Qdrant | 向量检索 | 检索退化关键词匹配；`/api/health` 503 |
| Ollama | 生成 embedding（768 维） | 同上 |
| SeaweedFS | 保存上传对象 | 上传/附件失败，纯问答不受影响 |
| DeepSeek | 生成回答、联网搜索 | 降级为 demo 模式或报错 |
| Nginx | 统一入口、SSE 不缓冲 | 无外部入口 |
| Prometheus / Grafana | 指标采集与看板 | 仅失去可观测性 |

### 1.4 版本矩阵（本机实测）

| 组件 | 镜像 / 版本 |
|---|---|
| 应用运行时 | `node:22-alpine`（容器）；宿主机 nvm `v20.10.0`、`v21.1.0` |
| PostgreSQL | `postgres:17-alpine` |
| Redis | `redis:7.4-alpine` |
| SeaweedFS | `ghcr.io/chrislusf/seaweedfs:4.46` |
| Qdrant | `qdrant/qdrant:v1.15.4` |
| Ollama | `ollama/ollama:latest`，模型 `nomic-embed-text:latest`（274MB，768 维） |
| Nginx | `nginx:1.27-alpine` |
| Prometheus | `prom/prometheus:v3.5.0` |
| Grafana | `grafana/grafana:12.1.1` |
| Docker Engine | 29.9.2 |
| Kubernetes | v1.36.1（Docker Desktop 内置 kind 集群，`docker-desktop` context） |

> ⚠️ **历史遗留**：`data/qdrant/` 下有一份 Windows 原生 Qdrant **1.19.0** 的存储数据（`qdrant.exe` + `storage/`），是早期直接跑在宿主机上的实验残留，与当前容器的 1.15.4 无关。**不要**把它挂进容器，跨大版本存储格式不兼容。

---

## 2. 代码结构

### 2.1 目录

```
agent_70/
├── server.js                 HTTP API / SSE / 静态资源
├── worker.js                 BullMQ 消费者
├── package.json              4 个直接依赖
├── Dockerfile                node:22-alpine，非 root 运行
├── docker-compose.yml        12 个服务的本地编排
├── deploy-k8s.ps1            Compose → K8s 迁移脚本
├── src/
│   ├── env.js                极简 .env 加载器
│   ├── db.js                 PostgreSQL 访问与建表
│   ├── queue.js              Redis / BullMQ / 并发槽
│   ├── storage.js            S3 对象存储
│   ├── agent.js              Agent 编排：检索 → 组装 prompt → 流式生成
│   ├── legacy-migration.js   旧 JSON 数据 → PG/S3 幂等迁移
│   ├── providers/openai-compatible.js   Chat Completions 适配
│   └── tools/
│       ├── knowledge.js      内置文档、检索、中文分词、切块
│       ├── vector-store.js   Qdrant 读写 + Ollama embedding
│       └── web-search.js     DeepSeek 联网搜索
├── public/                   前端（index.html / app.js / styles.css）
├── deploy/                   Nginx、Prometheus、Grafana 配置
├── k8s/                      K8s 清单（kustomize）
├── scripts/migrate-s3-to-k8s.js   迁移期对象搬运
└── data/                     旧 JSON 数据 + 原生 Qdrant 残留
```

### 2.2 模块职责

| 文件 | 要点 |
|---|---|
| `src/env.js` | 只读当前目录 `.env`；**已存在的环境变量优先**，不会被文件覆盖 |
| `src/db.js` | 连接池 + 建表；`initDb()` 在启动窗口内重试（见 3.2） |
| `src/queue.js` | 两条队列、SSE 频道、令牌桶式模型并发槽（Lua 脚本，租约 120s 心跳续约） |
| `src/storage.js` | S3 客户端，自动建桶；路径风格寻址 |
| `src/agent.js` | `streamAnswer()` 生成器：`status` → `delta` → `meta` 三类事件 |
| `src/tools/knowledge.js` | 4 篇内置文档；无向量时的中文 bigram 关键词兜底；切块 1000 字、重叠 120 |
| `src/tools/vector-store.js` | 确定性 point ID（重放安全）；集合不存在时按探测向量维度自动创建 |

### 2.3 数据模型

```sql
sessions(id PK, title, created_at, updated_at)
messages(id BIGSERIAL PK, session_id FK→sessions ON DELETE CASCADE,
         role CHECK('user','assistant'), content,
         attachments jsonb, sources jsonb, web_search bool, mode, created_at)
documents(id PK, title, content, size, object_key,
          index_status, index_error, uploaded_at)
vector_index_state(source_id PK, model_key, indexed_at)   -- 防止重复索引
app_migrations(name PK, applied_at)                       -- 迁移幂等标记
```

**索引状态机**：`pending → indexing → indexed`，失败置 `failed` 并写 `index_error`。
只有 `indexed` 的文档参与检索。

### 2.4 队列与键名

| 名称 | 用途 | 重试 |
|---|---|---|
| `agent-qa-chat` | 问答任务 | 2 次，指数退避 1.5s |
| `agent-qa-documents` | 文档索引 / 内置文档 | 3 次，指数退避 3s |

| Redis 键 | 用途 |
|---|---|
| `agent-qa:chat:<jobId>` | SSE 事件频道（Pub/Sub） |
| `agent-qa:model-slots` | 全局模型并发槽（ZSET，带租约） |
| `agent-qa:rate:<ip>` | 每分钟限流计数（TTL 60s） |
| `agent-qa:model-requests` / `-provider-errors` | 模型调用计数（供 `/metrics`） |

---

## 3. 配置参考

### 3.1 环境变量全表

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `LLM_MODEL` | `deepseek-flash` | 模型 ID |
| `LLM_API_KEY` | 空 | **为空则进入 demo 模式**；联网搜索也依赖它 |
| `EMBEDDING_PROVIDER` | — | `ollama` 或 `openai-compatible` |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | ollama 模式必填 |
| `EMBEDDING_MODEL` | `nomic-embed-text:latest` | 决定向量维度（768） |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` | — | openai-compatible 模式必填 |
| `QDRANT_URL` | — | 未设置则**完全关闭向量检索** |
| `QDRANT_COLLECTION` | `agent_qa_knowledge` | 集合名 |
| `QDRANT_API_KEY` | — | 云端 Qdrant 才需要 |
| `DATABASE_URL` | — | 优先级高于 PGHOST 系列 |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | `127.0.0.1` / `5432` / `agentqa` / `agentqa` / `agentqa` | 单机默认值 |
| `PG_POOL_MAX` | `20` | 每进程连接池上限 |
| `DB_STARTUP_TIMEOUT_MS` | `60000` | **启动期建表重试窗口** |
| `DB_STARTUP_RETRY_MS` | `2000` | 启动期重试间隔 |
| `REDIS_URL` | — | 优先级高于 REDIS_HOST 系列 |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `127.0.0.1` / `6379` / — | |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` | S3 兼容端点 |
| `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `agent-qa-uploads` / `us-east-1` / `agentqa` / `agentqa-local-secret` | |
| `PORT` | `3000` | API 监听端口 |
| `MODEL_CONCURRENCY` | `8` | 全局模型并发槽 |
| `CHAT_WORKER_CONCURRENCY` | `16` | 问答任务消费并发 |
| `DOCUMENT_WORKER_CONCURRENCY` | `2` | 文档索引并发 |
| `CHAT_RATE_LIMIT_PER_MINUTE` | `30` | 单 IP 每分钟问答数 |
| `MAX_CHAT_QUEUE` | `1000` | 等待队列上限，超出返回 503 |
| `RETRIEVAL_FAIL` | — | 设为 `1` 强制检索失败（**测试专用**） |
| `LEGACY_DATA_DIR` | `data` | 旧 JSON 目录 |

### 3.2 三套部署的配置来源

| 方式 | 配置来源 | 说明 |
|---|---|---|
| 裸 Node | 项目根 `.env` | 需手工把各 URL 指向 localhost |
| Docker Compose | `.env` → `docker-compose.yml` 的 `environment` | 服务名即主机名（`postgres`、`redis`、…） |
| Kubernetes | `k8s/config.yaml`（ConfigMap）+ `agent-qa-secrets`（Secret） | **改 `.env` 不会自动生效**，需重跑 `deploy-k8s.ps1` |

### 3.3 密钥管理

- `.env` 已被 `.gitignore` 忽略；`.env.example` 保留占位符。
- K8s 侧的 Secret 由 `deploy-k8s.ps1` 从 `.env` 生成，键名固定：
  `LLM_API_KEY`、`POSTGRES_PASSWORD`、`PGPASSWORD`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_ADMIN_PASSWORD`、`GRAFANA_USER`、`GRAFANA_PASSWORD`。
- 修改密钥后必须重建 Secret 并滚动重启：`kubectl rollout restart deployment/api deployment/worker -n agent-qa`。

---

## 4. 本地开发

### 4.1 前置

- Node ≥ 18（推荐 20+）、Docker Desktop。
- 依赖仅 4 个：`pg`、`ioredis`、`bullmq`、`@aws-sdk/client-s3`。

```powershell
npm ci --no-audit --no-fund
```

### 4.2 三种启动方式

**A. 裸 Node（最快迭代，需自备 PG/Redis/Qdrant/Ollama）**

```powershell
npm start          # API
npm run worker     # Worker（另开一个终端）
npm run dev        # 带 --watch 热重载
npm run migrate    # 仅建表，验证数据库连通性
```

`.env` 需指向 localhost：

```ini
DATABASE_URL=postgres://agentqa:agentqa@127.0.0.1:5432/agentqa
REDIS_URL=redis://127.0.0.1:6379
QDRANT_URL=http://127.0.0.1:6333
OLLAMA_BASE_URL=http://127.0.0.1:11434
S3_ENDPOINT=http://127.0.0.1:9000
```

**B. Docker Compose（最接近生产）**

```powershell
Copy-Item .env.example .env   # 仅首次
docker compose up --build -d
docker compose ps
docker compose logs -f api worker
```

**C. Kubernetes** —— 见 [7.2](#72-kubernetes-部署)。

### 4.3 开发模式降级

不想起全套依赖时，有两条降级路径：

| 关闭项 | 效果 |
|---|---|
| 不设 `LLM_API_KEY` | demo 模式：直接回显检索到的知识片段，不调用模型 |
| 不设 `QDRANT_URL` | 退化为中文 bigram 关键词匹配（`knowledge.js`） |

但 **PostgreSQL 和 Redis 无法降级** —— 缺少任一，进程启动即失败。

---

## 5. 测试

### 5.1 冒烟清单（发布前逐项勾）

| # | 检查 | 期望 |
|---|---|---|
| 1 | `GET /api/health` | 200，四项 `ok` |
| 2 | 新建会话并提问 | SSE 逐字返回，结束带 `sources` |
| 3 | 刷新页面重进会话 | 历史消息与来源完整还原 |
| 4 | 上传 `.md` 文档 | 202，随后 `index_status` 变 `indexed` |
| 5 | 针对新文档提问 | 引用到该文档 |
| 6 | 开启联网搜索提问 | 返回 `kind: "web"` 来源 |
| 7 | 上传图片提问 | 模型描述图片内容 |
| 8 | 删除文档 | 列表消失，且不再被引用 |
| 9 | 连续快速提问超过限流 | 返回 429 |
| 10 | `GET /metrics` | 指标可读，计数随请求增长 |

### 5.2 接口测试

```powershell
$base = 'http://127.0.0.1:18080'

# 健康检查
Invoke-RestMethod "$base/api/health"

# 新建会话
$s = Invoke-RestMethod "$base/api/sessions" -Method Post
$sid = $s.session.id

# 流式提问（观察 SSE 原始帧）
$body = @{ sessionId = $sid; question = '什么是 RAG？' } | ConvertTo-Json
curl.exe -N -X POST "$base/api/chat" -H 'Content-Type: application/json' -d $body

# 上传文档（x-file-name 必须带扩展名）
curl.exe -X POST "$base/api/documents" --data-binary "@.\README.md" `
  -H 'x-file-name: notes.md' -H 'Content-Type: text/markdown'
```

**接口一览**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 依赖健康检查，任一不健康返回 503 |
| GET | `/metrics` | Prometheus 文本格式 |
| GET/POST | `/api/sessions` | 列表 / 新建 |
| GET/DELETE | `/api/sessions/:id` | 详情（含消息）/ 删除 |
| GET/POST | `/api/documents` | 列表 / 上传（`x-file-name` 头） |
| DELETE | `/api/documents/:id` | 删除文档并清向量 |
| POST | `/api/chat` | SSE 问答 |

**入参约束**

| 约束 | 值 | 违反时 |
|---|---|---|
| 问题长度 | ≤ 2000 字 | 400 |
| 请求体 | ≤ 12 MB | 413 |
| 附件数量 | ≤ 5 个 | 400 |
| 附件合计 | ≤ 8 MB | 400 |
| 单个附件 | ≤ 5 MB（前端拦截） | 前端报错 |
| 附件类型 | PNG/JPEG/WEBP/GIF、TXT、MD | 400 |
| 文档内容 | ≤ 1 MB，仅 `.txt`/`.md` | 400 |

### 5.3 降级路径测试

```powershell
# 强制检索失败，验证错误处理
$env:RETRIEVAL_FAIL = '1'   # 仅对当前进程生效
npm start
```

| 场景 | 构造方式 | 期望 |
|---|---|---|
| demo 模式 | 清空 `LLM_API_KEY` | 回答带 "本地演示模式" 提示 |
| 关键词兜底 | 注释 `QDRANT_URL` | 仍能检索到内置文档 |
| 模型故障 | 填错 Key | SSE 收到 `error` 事件，消息不落库 |
| 队列打满 | 调低 `MAX_CHAT_QUEUE` 并并发压测 | 503 "队列已满" |
| 附件超限 | 传 6 个附件 | 400 |

### 5.4 容量与压力

并发模型看两个数：

- `MODEL_CONCURRENCY`（默认 8）：**全局**同时占用模型的请求数，超出的排队。
- `CHAT_WORKER_CONCURRENCY`（默认 16）：Worker 并发消费任务数。

压测前先确认 DeepSeek 账号的并发/速率额度。观察入口：

```powershell
Invoke-RestMethod 'http://127.0.0.1:18080/metrics' |
  Select-String 'agentqa_(chat_jobs|model_slots|model_provider_errors)'
```

---

## 6. 调试

### 6.1 可观测入口

| 入口 | 用途 |
|---|---|
| `docker compose logs -f api worker` / `kubectl logs -f deploy/api -n agent-qa` | 应用日志 |
| `/metrics` | 请求数、P50/P95、错误、队列长度、并发槽、ollama 模型显存 |
| Grafana `http://127.0.0.1:3001` | 预置看板 `agent-qa-overview` |
| Prometheus `http://127.0.0.1:9090` | 原始查询 |
| Qdrant Dashboard `http://127.0.0.1:6333/dashboard` | 集合与向量（**默认不暴露**，需临时 `kubectl port-forward -n agent-qa qdrant-0 6333:6333`） |

### 6.2 分诊决策树

```
打不开页面
├─ 18080 不通 → Docker Desktop 是否在跑？(docker desktop status)
│   └─ 在跑 → kubectl get pods -n agent-qa
│       ├─ Pod 未就绪 → 看 events / logs
│       └─ Pod 就绪 → 检查 nginx-web Service 是否拿到 EXTERNAL-IP
└─ 页面能开但提问无响应
    ├─ /api/health 是否 503 → 按 checks 里标 down 的项排查
    ├─ 是否卡在 "排队中" → Worker 是否存活？模型槽是否被占满？
    └─ 是否 429/503 → 限流或队列上限
```

### 6.3 组件单独验证

| 组件 | 命令 |
|---|---|
| PostgreSQL | `kubectl exec -n agent-qa postgres-0 -- pg_isready -U agentqa -d agentqa` |
| Redis | `kubectl exec -n agent-qa redis-0 -- redis-cli ping` |
| Qdrant | `kubectl exec -n agent-qa deploy/nginx -- wget -qO- http://qdrant:6333/readyz` → `all shards are ready` |
| Ollama | `kubectl exec -n agent-qa ollama-0 -c ollama -- ollama list` |
| Qdrant 集合 | `kubectl exec -n agent-qa deploy/nginx -- wget -qO- http://qdrant:6333/collections` |

> Qdrant 与 Ollama 的镜像里**没有 `wget`**，所以 HTTP 探测借 nginx Pod 发起；`ollama-0` 因有 init 容器，需用 `-c ollama` 指定容器，否则会多一行 `Defaulted container` 提示。
| 队列积压 | `kubectl exec -n agent-qa redis-0 -- redis-cli LLEN bull:agent-qa-chat:wait` |
| 端到端（绕过宿主入口） | `kubectl exec -n agent-qa deploy/nginx -- wget -qO- http://127.0.0.1/api/health` |

### 6.4 常见症状对照

| 症状 | 最可能原因 | 处置 |
|---|---|---|
| `Connection terminated due to connection timeout` | 数据库晚就绪 | 已由 `initDb` 重试覆盖；仍失败则查 PG |
| 回答永远 `stage: queued` | Worker 未运行 / 槽位耗尽 | 查 worker Pod 与 `agent-qa:model-slots` |
| 文档一直 `pending` | 文档队列无人消费 | 查 `agent-qa-documents` 队列长度 |
| 文档 `failed` | embedding 或 Qdrant 异常 | 看 `index_error` 字段与 worker 日志 |
| 回答无引用 | 检索未命中 / 索引未完成 | 查 `vector_index_state` 与 `index_status` |
| 联网搜索报错 | 未配 Key 或额度不足 | 检查 `LLM_API_KEY` |
| `/api/health` 503 且 `ollama: down` | embedding 服务异常 | **会连带 nginx 未就绪**，见 8.1 |

---

## 7. 部署

### 7.1 Docker Compose 部署

```powershell
docker compose up --build -d
docker compose ps            # 12 个服务
docker compose down          # 停止，保留数据卷
docker compose down -v       # ⚠️ 连数据一起删
```

服务与端口（仅回环可访问）：

| 服务 | 宿主端口 |
|---|---|
| nginx → Web | `127.0.0.1:18080` |
| Grafana | `127.0.0.1:3001` |
| Prometheus | `127.0.0.1:9090` |
| SeaweedFS S3 / master | `127.0.0.1:8333` / `9333` |
| Qdrant | `127.0.0.1:6333` |
| Ollama | `127.0.0.1:11434` |

### 7.2 Kubernetes 部署

前提：Docker Desktop 的 Kubernetes 已启用，`kubectl` context 为 `docker-desktop`。

```powershell
./deploy-k8s.ps1
```

脚本做的事（**按序**）：

1. 校验 `.env` 存在、context 正确、节点 Ready。
2. `docker build` → `docker save` → `docker cp` → 节点内 `ctr images import`（`imagePullPolicy: Never`，镜像必须先从宿主导入）。
3. 建 namespace、由 `.env` 生成 Secret、apply ConfigMap 与数据服务 StatefulSet，逐个等待 rollout。
4. 停 Compose 前端 → 排空问答队列（最多 5 分钟）→ 停 api/worker。
5. 迁移 PostgreSQL：目标已有数据时用指纹比对，不一致就中止；否则 `pg_dump`/`pg_restore`。
6. 清空 `vector_index_state` 并重置文档为 `pending`（让新 Qdrant 重新建索引）。
7. 临时转发 SeaweedFS `18333`，跑 `scripts/migrate-s3-to-k8s.js` 搬对象。
8. `kubectl apply -k k8s` → 等待 5 个 Deployment 就绪。
9. `docker compose stop`（保留卷作回退副本）。
10. 等待 LoadBalancer 拿到地址 → 健康检查通过 → 完成。

失败时自动 `docker compose start` 回退。

### 7.3 入口暴露（重要）

**实测结论**：Docker Desktop 的 Kubernetes 是本机 kind 集群，节点容器只映射了 `6443`，**NodePort 不会暴露到宿主**。可用方式是 LoadBalancer —— `kind-cloud-provider` 会为**每个 LoadBalancer Service 发布一个宿主端口**，且**双端口的 Service 只会发布其中一个**。

因此 [k8s/web-entry.yaml](k8s/web-entry.yaml) 为三个入口各定义了一个独立的 LB Service：

| Service | 宿主 | 集群内 |
|---|---|---|
| `nginx-web` | `127.0.0.1:18080` | nginx:80 |
| `grafana-web` | `127.0.0.1:3001` | grafana:3000 |
| `prometheus-web` | `127.0.0.1:9090` | prometheus:9090 |

集群内的 `nginx` Service 保持 ClusterIP，Prometheus 抓取 `nginx:80` 的路径不受影响。

> 早期方案用的是 `kubectl port-forward`，**不要退回**：它是临时进程，Docker Desktop 一重启就失效，而且会和 LB 抢同一批宿主端口。

### 7.4 手动重建镜像并上线（改代码后必做）

```powershell
$img = 'agent-qa-api:local'
docker build -t $img .
docker save -o "$env:TEMP\agent-qa-api.tar" $img
docker cp "$env:TEMP\agent-qa-api.tar" desktop-control-plane:/root/agent-qa-api.tar
docker exec desktop-control-plane ctr -n k8s.io images import /root/agent-qa-api.tar
docker exec desktop-control-plane rm -f /root/agent-qa-api.tar
kubectl rollout restart deployment/api deployment/worker -n agent-qa
kubectl rollout status deployment/api -n agent-qa --timeout=180s
```

> Compose 方式则简单：`docker compose up --build -d`。

### 7.5 升级与回滚

| 场景 | 操作 |
|---|---|
| 仅改应用代码 | 7.4 的流程 |
| 改 K8s 清单 | `kubectl apply -k k8s` |
| 回滚到 Compose | `docker compose start`（卷与数据仍在） |
| 回滚应用镜像 | `kubectl rollout undo deployment/api -n agent-qa` |

---

## 8. 运维

### 8.1 健康检查语义（**关键设计约束**）

`/api/health` 把 **postgres、redis、qdrant、ollama(当 provider=ollama)** 四项一起判定，任一不健康即 503。

而 K8s 里 api 的 readinessProbe 用的正是这个端点，nginx 的 readiness 又依赖 api 的健康。于是形成一条**强耦合链**：

```
ollama 不可用 → api NotReady → nginx NotReady → 全站不可用
```

即使只是 embedding 挂了（纯问答本可继续），也会造成整站不可用。**这是当前设计的最大可用性风险**，建议后续把 health 拆分：

- `/api/health/live`（进程存活，不含依赖）给 liveness / readiness 用
- `/api/health/ready`（依赖检查）仅给人工与监控用

### 8.2 指标

| 指标 | 含义 |
|---|---|
| `agentqa_http_requests_total` / `_errors_total` | 请求量与错误 |
| `agentqa_http_request_duration_ms_bucket` | 延迟直方图（100/300/1000/3000/10000ms） |
| `agentqa_chat_jobs{state=...}` | 问答队列各状态数量 |
| `agentqa_document_jobs{state=...}` | 文档队列各状态数量 |
| `agentqa_model_slots_active` | 当前占用模型槽数 |
| `agentqa_model_requests_total` / `_provider_errors_total` | 模型调用与错误 |
| `agentqa_ollama_up` / `..._model_size_vram_bytes` | 本地模型资源 |

### 8.3 备份与恢复

| 数据 | 存放位置 | 备份方式 |
|---|---|---|
| 会话/消息/文档 | PG PVC `data-postgres-0` | `kubectl exec postgres-0 -- pg_dump -Fc -U agentqa agentqa > backup.dump` |
| 向量 | Qdrant PVC `data-qdrant-0` | 可从 PG 重建（重置 `vector_index_state` 后重启 worker） |
| 对象文件 | SeaweedFS PVC `data-seaweedfs-0` | 随卷备份 |
| 队列 | Redis PVC `data-redis-0` | 一般无需备份（可重放） |

> 向量库**可以随时重建**：`UPDATE documents SET index_status='pending'; DELETE FROM vector_index_state;` 然后重启 worker。

### 8.4 扩缩容

| 目标 | 手段 |
|---|---|
| 提高 API 吞吐 | `kubectl scale deploy/api --replicas=N`（API 无状态，可水平扩） |
| 提高模型并发 | 调大 `MODEL_CONCURRENCY`（受模型服务额度限制） |
| 提高任务消费 | 调大 `CHAT_WORKER_CONCURRENCY` 或加 worker 副本 |
| 加快文档索引 | 调大 `DOCUMENT_WORKER_CONCURRENCY` |

扩容时同步核算 `PG_POOL_MAX × 进程数` 是否超过 PostgreSQL `max_connections`。

### 8.5 开机自启

Docker Desktop 默认 `AutoStart: false`，重启后整套集群不会自动恢复。

已配置：`%APPDATA%\Docker\settings-store.json` 的 `"AutoStart": true`，配合注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Docker Desktop`。

- 该设置**按用户生效**，其他 Windows 账号需单独开启。
- 修改方式：先 `docker desktop stop`，改文件，再启动（运行中的实例退出时会覆盖该文件）。

---

## 9. 故障案例库

以下均为本机真实发生并已解决的问题，保留原始症状便于日后比对。

### 9.1 所有命令以 `0xC0000142` 退出

**症状**：任何 PowerShell 命令无输出，退出码 `3221225794`。

**定位**：换新会话同样崩溃、重启 DSH 宿主依旧崩溃 → 不是资源耗尽、不是会话状态。在本机放宽沙箱后同一命令立刻正常 → **DSH 的 Windows 沙箱在派生进程时导致 DLL 初始化失败**。

**处置**：对需要执行命令的调用使用 `danger-full-access`，或在 DSH 设置中关闭 Windows 沙箱。

> 附带教训：沙箱模式下**目录枚举会把"无权限"静默返回成"无文件"**，据此得出的"某某软件没装"结论可能是假阴性。凡结论为"不存在"的，应在放宽后复验。

### 9.2 整套服务凭空消失

**症状**：`/api/health` 不可达，`kubectl` 报 `127.0.0.1:11967` 连接被拒。

**原因**：Docker Desktop 未运行（`AutoStart: false`），引擎停止后容器与集群全部停止；`docker_data.vhdx` 数据仍在。

**处置**：启动 Docker Desktop，等待 `kubectl get nodes` 成功（约 1–2 分钟），Pod 会自动恢复。

### 9.3 每次冷启动都 CrashLoop

**症状**：api/worker 反复重启，日志：

```
Error: Connection terminated due to connection timeout
    at async file:///app/src/db.js:24:5
```

**原因**：整机重启后 PostgreSQL 需要重做 WAL 恢复（`database system was not properly shut down; automatic recovery in progress`），就绪时间晚于应用；`initDb()` 只有 5 秒连接超时且失败即退出。

**处置**：`src/db.js` 的 `initDb` 改为在 `DB_STARTUP_TIMEOUT_MS`（默认 60s）窗口内按 `DB_STARTUP_RETRY_MS`（默认 2s）重试。

**验证**：冷启动后 api 的 `restartCount` 稳定在 1（仅 Docker 停机导致的一次），不再累加。

### 9.4 重启后 18080 打不开

**症状**：Docker Desktop 重启后浏览器连不上，但 Pod 全部健康。

**原因**：早期入口依赖 `kubectl port-forward`，它是临时进程，随宿主重启消失。

**处置**：改用 LoadBalancer Service（见 7.3），已彻底移除 port-forward 依赖。

### 9.5 `ollama-0` 卡在 `Unknown` / init 容器 `BackOff`

**症状**：`ollama-0` 长期 `0/1 Unknown`，init 容器 `pull-embedding-model` 反复重启。

**原因**：init 容器需先自行 `ollama serve` 再 `pull` 274MB 模型，网络慢时会长时间重试。

**处置**：耐心等待（模型只拉一次，落在 PVC），或先 `docker pull`/预置模型。拉取成功日志尾部会出现 `success`。

### 9.6 非正常关机后的 PostgreSQL

**症状**：PG 日志出现 `database system was interrupted` + `redo starts`。

**说明**：这是**正常的崩溃恢复**，不是故障。等待日志出现 `database system is ready to accept connections` 即可，无需干预。

---

## 10. 安全清单

| 项 | 现状 | 建议 |
|---|---|---|
| 鉴权 | **无**（无用户体系） | 只能绑定回环；对外必须加反向代理与认证 |
| `.env` 密钥 | 明文存储 | 已 gitignore；建议改用 Secret 管理器并定期轮换 |
| 默认口令 | Compose 中 `change-this-*` 占位 | 首次部署必须全部替换 |
| TLS | 应用不终止 TLS | 由宿主机反代终结 HTTPS |
| 端口暴露 | 全部 `127.0.0.1` | 切勿直接暴露到公网 |
| 限流 | 单 IP 每分钟 30 次，基于 `X-Real-IP` | 由反代覆盖该头，否则可伪造 |
| 上传校验 | 类型白名单、大小限制、文件名净化 | 已覆盖 |
| 提示注入 | 检索内容已标注"不可信数据" | 已缓解 |

---

## 11. 附录

### 11.1 命令速查

```powershell
# —— 环境 ——
docker desktop start | stop | status
kubectl get nodes

# —— 状态 ——
kubectl get pods -n agent-qa
kubectl get svc -n agent-qa
kubectl get pvc -n agent-qa
docker compose ps
docker compose ls -a

# —— 日志 ——
kubectl logs -f deploy/api -n agent-qa --tail=100
kubectl logs -f deploy/worker -n agent-qa --tail=100
kubectl logs -n agent-qa ollama-0 -c pull-embedding-model

# —— 排障 ——
kubectl describe pod -n agent-qa <pod> | Select-String 'Events:' -Context 0,15
kubectl exec -n agent-qa postgres-0 -- pg_isready -U agentqa -d agentqa
kubectl exec -n agent-qa redis-0 -- redis-cli ping
kubectl exec -n agent-qa deploy/nginx -- wget -qO- http://127.0.0.1/api/health

# —— 部署 ——
kubectl apply -k k8s
kubectl rollout restart deployment/api deployment/worker -n agent-qa
kubectl rollout status deployment/api -n agent-qa --timeout=180s
kubectl rollout undo deployment/api -n agent-qa

# —— 数据 ——
kubectl exec -n agent-qa postgres-0 -- psql -U agentqa -d agentqa -c "SELECT id,title,index_status FROM documents"
```

### 11.2 端口速查

| 端口 | 服务 |
|---|---|
| 18080 | Web（LB → nginx） |
| 3001 | Grafana（LB） |
| 9090 | Prometheus（LB） |
| 3000 | API（集群内） |
| 5432 | PostgreSQL |
| 6379 | Redis |
| 6333 / 6334 | Qdrant HTTP / gRPC |
| 11434 | Ollama |
| 8333 / 8888 / 9333 | SeaweedFS S3 / filer / master |

### 11.3 当前部署基线（2026-11-01 实测）

| 项 | 值 |
|---|---|
| 部署形态 | Kubernetes（`agent-qa` namespace），Compose 为停止状态的回退副本 |
| Pod | 11 个，全部 `1/1 Running` |
| 会话 / 文档 | 3 条 / 24 份（全部 indexed） |
| 入口 | `http://127.0.0.1:18080`、`:3001`、`:9090` 均 200 |
| 健康检查 | postgres / redis / qdrant / ollama 全 `ok` |
