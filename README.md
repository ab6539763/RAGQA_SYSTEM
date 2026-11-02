# 寻知 · Agent 智能问答

支持 SSE 流式问答、RAG 文档引用、联网搜索和多模态图片输入。生产形态采用无状态 API、后台 Worker、PostgreSQL、Redis/BullMQ、SeaweedFS S3、Qdrant 和 Ollama，并由 Nginx 负载均衡。

## 文档

开发、测试、调试、部署与故障排查的完整说明见 [docs/manual.md](docs/manual.md)。

## 本地 Docker 部署

需要 Docker Desktop（Windows/macOS）或 Docker Engine + Compose v2。首次启动会拉取容器镜像和 `nomic-embed-text` embedding 模型，下载时长取决于网络。

```powershell
Copy-Item .env.example .env  # 仅首次部署；如果已有 .env，不要覆盖，保留现有 LLM_API_KEY 并补齐其他变量
# 编辑 .env：至少设置 LLM_API_KEY；并修改 PostgreSQL、对象存储、Grafana 默认密码
docker compose up --build -d
```

默认模型密钥为空时可以启动本地演示模式；配置 DeepSeek Key 后启用在线回答。将 `.env` 中的示例密码替换为独立强密码，勿将 `.env` 提交到 Git。Web 入口默认绑定 `127.0.0.1:18080`，适合放在主机 HTTPS 反向代理之后；将反向代理的上游指向 `http://127.0.0.1:18080`，并让反向代理覆盖 `X-Real-IP` 和 `X-Forwarded-Proto` 为真实客户端地址及外部协议。应用本身不终止 TLS，也不提供用户登录鉴权，请勿直接把该 HTTP 端口暴露到公网。

访问入口：

- Web 问答：http://localhost:18080（仅本机回环地址）
- Grafana 仪表盘：http://localhost:3001（账号密码见 `.env`）
- Prometheus：http://localhost:9090
- SeaweedFS S3 endpoint：http://localhost:8333
- Qdrant Dashboard：http://localhost:6333/dashboard

停止服务但保留数据：`docker compose down`。删除 PostgreSQL、Redis、SeaweedFS、Qdrant、Ollama 和监控数据卷：`docker compose down -v`（会永久删除这些数据）。

## 迁移到 Kubernetes（Docker Desktop）

`k8s/` 包含 PostgreSQL、Redis、SeaweedFS、Qdrant、Ollama、双副本 API、Worker、Nginx、Prometheus 和 Grafana 的 Kubernetes 资源；数据组件使用 PVC 持久化。Kubernetes 集群当前必须先在 Docker Desktop 的 **Kubernetes** 页面创建并运行，`kubectl` context 应为 `docker-desktop`。然后在项目目录运行：

```powershell
./deploy-k8s.ps1
```

迁移脚本会构建并导入本地 API 镜像，读取 `.env` 创建 Kubernetes Secret，等待数据服务就绪；随后停止 Compose 前端、排空问答队列、迁移 PostgreSQL 数据和 SeaweedFS 对象，并在新 Qdrant 中重新建立向量索引。新环境健康检查通过后，脚本停止 Compose 服务但保留原 Docker volumes 作为回退副本，不会删除它们。Web、Grafana、Prometheus 由 `k8s/web-entry.yaml` 中的 LoadBalancer Service 发布到 `127.0.0.1` 的 18080、3001、9090 端口；Docker Desktop 的 cloud provider 会为每个 LoadBalancer Service 发布一个宿主端口，因此这三个 Service 与集群内 Service 分开定义，不依赖 `kubectl port-forward`，Docker Desktop 重启后依然可用。

Kubernetes PVC 会占用独立于 Compose volumes 的磁盘空间。首次启动 Ollama 会重新拉取 embedding 模型；迁移期间问答入口会短暂中断。若迁移脚本失败，会尝试重新启动 Compose 服务。

### 横向扩展

在单台 Docker 主机上运行两个 API 实例：

```powershell
docker compose up --build -d --scale api=2
```

Nginx 将普通请求和 SSE 连接分发给 API 实例。API 不保存本地会话状态；PostgreSQL、Redis、MinIO 和 Qdrant 是共享后端。聊天排队由 BullMQ 持久化；`MODEL_CONCURRENCY` 控制跨 Worker 的全局模型并发槽位，`CHAT_WORKER_CONCURRENCY` 控制任务消费并发，`MAX_CHAT_QUEUE` 限制积压长度。默认槽位为 8，超过后用户会看到排队状态。失败的模型任务最多自动重试 1 次。

文档上传先写入 SeaweedFS S3 和 PostgreSQL，再由独立文档队列解析、切分、生成 embedding 并索引到 Qdrant；聊天 API 不在用户请求中执行全库建索引。上传的图片也保存在对象存储，后台问答任务只携带对象键。

首次启动会将现有 `data/sessions.json` 和 `data/documents.json` 幂等导入 PostgreSQL/SeaweedFS，并为旧文档重新建立 Qdrant 索引。旧 JSON 文件保留在宿主机 `data/` 目录，不会被删除。

### 容量和监控

`/metrics` 导出 API 请求数、延迟直方图、HTTP 错误、问答/文档队列长度、模型并发槽位和模型服务错误；Prometheus 抓取这些指标、Qdrant 指标，以及 Ollama 当前运行模型的模型大小与显存用量。Grafana 默认仪表盘可观察队列、API P95、错误率和本地 embedding 模型资源。

DeepSeek 的账单额度/账户余额不由此应用查询；模型侧 429 和服务错误会计数并展示，真实余额请在 DeepSeek 控制台核对。Ollama 返回运行模型的大小与 GPU 显存字段，不提供通用 Prometheus CPU 指标；容器 CPU/内存可在 Docker Desktop 的容器资源面板观察。

200 人同时打开页面与 200 人同时发起模型生成是不同容量目标。当前默认模型并发为 8，其余请求排队；请先核对 DeepSeek 账号并发/速率额度，再按真实 prompt 长度、联网搜索占比和响应时延做并发压测。应用不预先承诺固定吞吐量。

## 环境配置

`.env.example` 列出 Docker Compose 使用的变量：

- `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`：OpenAI-compatible 模型服务。DeepSeek 当前应使用 API 名称 `deepseek-flash`，服务端对应 V4.1-Flash-1017。
- `MODEL_CONCURRENCY`：全局同时占用模型生成槽位的上限。
- `CHAT_RATE_LIMIT_PER_MINUTE`：单 IP 每分钟问答请求数。
- `MAX_CHAT_QUEUE`：等待中的问答任务最大数量。
- `PG_POOL_MAX`：每个 API/Worker 进程的 PostgreSQL 连接池上限；扩容时需同时估算所有容器连接数。
- `EMBEDDING_MODEL`：默认 `nomic-embed-text:latest`，首次部署由 Ollama 容器拉取。

默认资源全部由 Docker 命名卷持久化。可以用 `docker compose ps` 查看容器状态、`docker compose logs -f api worker` 查看应用日志。

## 项目结构

- `server.js`：HTTP API、SSE、上传、限流和 Prometheus 指标。
- `worker.js`：问答流式生成、全局模型并发槽位、文档解析与 embedding 索引。
- `src/db.js`：PostgreSQL 会话、消息、文档及索引状态存储。
- `src/queue.js`：Redis/BullMQ 队列、事件流和分布式模型并发槽位。
- `src/storage.js`：S3-compatible 对象存储（SeaweedFS）。
- `src/agent.js`、`src/providers/`、`src/tools/`：Agent 编排、模型适配与检索工具。
- `deploy/`：Nginx、Prometheus 和 Grafana 配置。

## 兼容的直接 Node 开发

当前应用默认读取 Docker Compose 服务地址，直接在 Windows 主机运行时请将 `.env` 的 `DATABASE_URL`、`REDIS_URL`、`S3_ENDPOINT`、`OLLAMA_BASE_URL`、`QDRANT_URL` 指向 localhost，并先启动这些依赖服务。浏览器使用同源 `/api`，无需额外配置。
