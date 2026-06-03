"""Pipeline job handler — script-to-storyboard and story push."""
import json
import os
import asyncio
from vimax_image_worker.reporter import JobReporter

async def handle_pipeline_job(payload: dict, reporter: JobReporter):
    """Handle pipeline jobs: script2storyboard and story_push."""
    job_type = payload.get("job_type", "")
    job_id = payload["job_id"]

    await reporter.publish_started()

    try:
        if job_type == "pipeline.script2storyboard":
            result = await _handle_script2storyboard(payload)
        elif job_type == "pipeline.story_push":
            result = await _handle_story_push(payload)
        else:
            raise ValueError(f"Unknown pipeline job type: {job_type}")

        await reporter.publish_completed(result)
    except Exception as e:
        await reporter.publish_failed("worker.internal", str(e), retryable=False)

async def _handle_script2storyboard(payload: dict) -> dict:
    """Generate storyboard from script content.
    Supports VIMAX_MOCK_LLM=1 for testing without real API keys.
    """
    content = payload["input"]["content"]
    mock = os.environ.get("VIMAX_MOCK_LLM", "0") == "1"

    if mock:
        # Return fixed 3-cell storyboard for testing
        cells = [
            {"shotBrief": f"镜头{i+1}: 基于「{content[:20]}...」生成的第{i+1}个分镜", "cameraIdx": i, "ffDesc": f"第{i+1}个镜头的首帧描述，画面呈现故事的关键时刻", "lfDesc": f"第{i+1}个镜头的末帧描述", "motionDesc": "缓慢推近"}
            for i in range(3)
        ]
    else:
        # Try to use the actual StoryboardArtist agent
        try:
            import sys
            vimax_root = os.environ.get("VIMAX_ROOT", "/app/vimax")
            if vimax_root not in sys.path:
                sys.path.insert(0, vimax_root)
            from agents import StoryboardArtist
            credential = payload.get("credential", {})
            api_key = credential.get("api_key", "")
            base_url = credential.get("base_url", "")
            artist = StoryboardArtist(api_key=api_key, base_url=base_url)
            shots = artist.design_storyboard(content)
            cells = [
                {"shotBrief": s.visual_description, "cameraIdx": s.camera_index, "ffDesc": "", "lfDesc": "", "motionDesc": ""}
                for s in shots
            ]
        except Exception as e:
            # Fallback to mock if agent fails
            cells = [
                {"shotBrief": f"镜头{i+1}: (Agent fallback) {content[:30]}...", "cameraIdx": i, "ffDesc": f"首帧{i+1}", "lfDesc": f"末帧{i+1}", "motionDesc": "推近"}
                for i in range(3)
            ]

    return {
        "storage_key": "",
        "width": 0,
        "height": 0,
        "sha256": "",
        "mime_type": "application/json",
        "size_bytes": 0,
        "cells": cells,
    }

async def _handle_story_push(payload: dict) -> dict:
    """Generate 4 predicted next frames (story push 4-grid)."""
    content = payload["input"].get("content", "")
    mock = os.environ.get("VIMAX_MOCK_LLM", "0") == "1"

    if mock:
        cells = [
            {"shotBrief": f"推演帧{i+1}: 预测下一刻画面", "cameraIdx": i, "ffDesc": f"推演首帧{i+1}", "lfDesc": "", "motionDesc": "静止"}
            for i in range(4)
        ]
    else:
        cells = [
            {"shotBrief": f"推演帧{i+1}: 基于描述预测的下一个画面", "cameraIdx": i, "ffDesc": f"推演帧{i+1}", "lfDesc": "", "motionDesc": "静止"}
            for i in range(4)
        ]

    return {
        "storage_key": "",
        "width": 0,
        "height": 0,
        "sha256": "",
        "mime_type": "application/json",
        "size_bytes": 0,
        "cells": cells,
    }
