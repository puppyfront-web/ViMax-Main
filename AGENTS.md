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

## 已移除

以下根目录 Python 文件为早期并行设计，**未接入 Web 主链路**，已归档删除：

- `agents/decision_agent.py`
- `agents/supervision_agent.py`
- `pipelines/chat_pipeline.py`

如需 CLI 级完整管线（idea2video / script2video），使用根目录 `main_idea2video.py` / `main_script2video.py`。
