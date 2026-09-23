"""Pipeline job handler — script-to-storyboard and story push."""
from vimax_image_worker.reporter import JobReporter
from vimax_image_worker.vimax_bridge import design_storyboard_cells


async def handle_pipeline_job(payload: dict, reporter: JobReporter):
    """Handle pipeline jobs: script2storyboard and story_push."""
    job_type = payload.get("job_type", "")

    await reporter.started()

    try:
        if job_type == "pipeline.script2storyboard":
            result = await _handle_script2storyboard(payload)
        elif job_type == "pipeline.story_push":
            result = await _handle_story_push(payload)
        else:
            raise ValueError(f"Unknown pipeline job type: {job_type}")

        await reporter.completed(result)
    except Exception as e:
        await reporter.failed(error_code="worker.internal", error_message=str(e), retryable=False)


async def _handle_script2storyboard(payload: dict) -> dict:
    """Generate storyboard via ViMax StoryboardArtist (same agent as CLI pipeline)."""
    content = payload["input"]["content"]
    credential = payload.get("credential", {})
    characters = payload["input"].get("characters")
    user_requirement = payload["input"].get("user_requirement")

    cells = await design_storyboard_cells(
        content,
        credential,
        characters=characters,
        user_requirement=user_requirement,
    )

    return _pipeline_json_result(cells)


async def _handle_story_push(_payload: dict) -> dict:
    raise NotImplementedError(
        "pipeline.story_push is not implemented yet; use script2storyboard for real ViMax storyboard generation"
    )


def _pipeline_json_result(cells: list[dict]) -> dict:
    return {
        "storage_key": "",
        "width": 0,
        "height": 0,
        "sha256": "",
        "mime_type": "application/json",
        "size_bytes": 0,
        "cells": cells,
    }
