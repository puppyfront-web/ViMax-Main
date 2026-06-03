"""Concat job handler — merges multiple video clips using ffmpeg."""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from vimax_image_worker.asset_downloader import download_objects
from vimax_image_worker.asset_uploader import upload_file
from vimax_image_worker.reporter import JobReporter

logger = logging.getLogger(__name__)


class ConcatJobInput(BaseModel):
    storage_keys: list[str]


class ConcatJobCallback(BaseModel):
    event_channel: str
    upload_bucket: str
    upload_prefix: str


class ConcatJobPayload(BaseModel):
    job_id: str
    job_type: str
    input: ConcatJobInput
    callback: ConcatJobCallback
    cache_key: str
    timeout_ms: int = Field(default=120_000)


def _check_ffmpeg() -> bool:
    """Check if ffmpeg is available on the system."""
    return shutil.which("ffmpeg") is not None


def _concat_videos(input_paths: list[Path], output_path: Path) -> None:
    """Concatenate videos using ffmpeg concat demuxer."""
    # Write concat file list
    concat_list = output_path.parent / "concat_list.txt"
    with open(concat_list, "w") as f:
        for p in input_paths:
            f.write(f"file '{p.as_posix()}'\n")

    cmd = [
        "ffmpeg",
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(concat_list),
        "-c", "copy",
        str(output_path),
    ]
    logger.info("Running: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg concat failed: {result.stderr}")


async def _run_concat(payload: ConcatJobPayload, redis_client) -> None:
    reporter = JobReporter(redis_client, payload.callback.event_channel, payload.job_id)
    await reporter.started()

    if not _check_ffmpeg():
        raise RuntimeError("ffmpeg not found on system PATH")

    workdir = Path(tempfile.mkdtemp(prefix=f"vimax-concat-{payload.job_id}-"))
    try:
        storage_keys = payload.input.storage_keys
        if len(storage_keys) < 2:
            raise ValueError("Need at least 2 video clips to concatenate")

        await reporter.progress(10, f"Downloading {len(storage_keys)} video clips")

        # Download all videos
        local_paths = download_objects(
            storage_keys,
            workdir,
            bucket=payload.callback.upload_bucket,
        )

        await reporter.progress(40, "Concatenating videos with ffmpeg")

        output_path = workdir / f"{payload.job_id}_merged.mp4"
        await asyncio.to_thread(_concat_videos, local_paths, output_path)

        await reporter.progress(80, "Uploading merged video")

        meta = upload_file(
            output_path,
            bucket=payload.callback.upload_bucket,
            prefix=payload.callback.upload_prefix,
        )

        await reporter.completed(
            {
                "storage_key": meta["storage_key"],
                "width": meta["width"],
                "height": meta["height"],
                "sha256": meta["sha256"],
                "mime_type": meta["mime_type"],
                "size_bytes": meta["size_bytes"],
            }
        )
    except Exception as exc:
        logger.exception("Concat job %s failed", payload.job_id)
        await reporter.failed(
            error_code="concat.failed",
            error_message=str(exc),
            retryable=False,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def handle_concat_job(raw: dict[str, Any], redis_client) -> None:
    payload = ConcatJobPayload.model_validate(raw)
    asyncio.run(_run_concat(payload, redis_client))
