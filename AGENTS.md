# ViMax Platform — Agent Architecture

## 决策层（唯一实现）

Web 平台的 AI 对话与工具编排由 TypeScript 实现：

- `vimax-platform/apps/api/src/domain/agent/decision-layer.ts` — 决策 Agent、工具定义与执行
- `vimax-platform/apps/api/src/realtime/websocket.ts` — Chat WebSocket 入口（`chat.send` / `chat.stop`）
- `vimax-platform/apps/api/src/domain/canvas/pipeline-orchestrator.ts` — 全自动管线编排（script→分镜→镜头→图片→视频→合成）

## Python ViMax 集成

仓库根目录的 HKUDS/ViMax 多智能体框架通过 **Worker 桥接** 调用，不作为独立 HTTP 服务：

- `workers/image/vimax_image_worker/vimax_bridge.py` — 挂载 `VIMAX_ROOT`，调用 `StoryboardArtist` 等 Agent
- `pipeline.script2storyboard` — 剧本转分镜（走 Python StoryboardArtist）

## 标准生产路径

```
输入(创意/剧本) → Chat Agent → script 节点
  → [全自动] pipeline-orchestrator
  → storyboard_cell → shot → image → video → concat → 下载
```

## 资产存储策略（Local-first）

中间产物二进制存**用户设备**（浏览器 IndexedDB），云端对象存储只做**瞬时中转**：

- `apps/web/src/lib/local-assets.ts` — IndexedDB 本地资产金库
- `apps/web/src/features/assets/useAssetSource.ts` — local-first 解析：本地命中直出 objectURL；未命中拉取二进制落库，随后（仅 generated 资产）调用 `asset.offload` 删除远端副本
- `apps/api/src/domain/asset/asset-offload.ts` — offload（幂等，upload 资产受保护）+ TTL 清扫（`ASSET_SWEEP_TTL_HOURS`，默认 24h，0 关闭）
- 用户手动「存到云端」走既有 requestUpload 通道，产物标记 `source=upload`，永不自动清除
- `assets.offloaded_at` 非空 = 二进制已不在云端（元数据行保留以维持节点引用）

## 已移除

以下根目录 Python 文件为早期并行设计，**未接入 Web 主链路**，已归档删除：

- `agents/decision_agent.py`
- `agents/supervision_agent.py`
- `pipelines/chat_pipeline.py`

如需 CLI 级完整管线（idea2video / script2video），使用根目录 `main_idea2video.py` / `main_script2video.py`。
