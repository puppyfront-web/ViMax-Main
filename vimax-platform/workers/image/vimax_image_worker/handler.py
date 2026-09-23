"""Image job handler — bridges queue payload to ViMax ImageGenerator."""

from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import shutil
import tempfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from vimax_image_worker.asset_downloader import download_objects
from vimax_image_worker.asset_uploader import upload_file
from vimax_image_worker.reporter import JobReporter

logger = logging.getLogger(__name__)


class ImageJobCredential(BaseModel):
    class_path: str
    api_key: str
    base_url: str | None = None
    model: str | None = None


class ImageJobInput(BaseModel):
    prompt: str
    size: str
    reference_storage_keys: list[str] | None = None


class ImageJobCallback(BaseModel):
    event_channel: str
    upload_bucket: str
    upload_prefix: str


class ImageJobPayload(BaseModel):
    job_id: str
    job_type: str
    model_id: str
    credential: ImageJobCredential
    input: ImageJobInput
    callback: ImageJobCallback
    cache_key: str
    timeout_ms: int = Field(default=120_000)


def _build_generator(credential: ImageJobCredential):
    module_path, cls_name = credential.class_path.rsplit(".", 1)
    cls = getattr(importlib.import_module(module_path), cls_name)
    candidates: dict[str, Any] = {"api_key": credential.api_key}
    if credential.base_url:
        candidates["base_url"] = credential.base_url
    if credential.model:
        candidates["model"] = credential.model
    # Generators hardcode their endpoint; only pass kwargs they accept.
    accepted = inspect.signature(cls.__init__).parameters
    init_args = {k: v for k, v in candidates.items() if k in accepted}
    return cls(**init_args)


def _map_error(exc: Exception) -> tuple[str, str, bool]:
    message = str(exc).lower()
    if "rate" in message and "limit" in message:
        return "provider.rate_limited", str(exc), True
    if "401" in message or "unauthorized" in message or "api key" in message:
        return "provider.invalid_api_key", str(exc), False
    if "timeout" in message:
        return "provider.timeout", str(exc), True
    if "content" in message and "policy" in message:
        return "provider.content_policy_violation", str(exc), False
    return "worker.internal", str(exc), True


async def _run(payload: ImageJobPayload, redis_client) -> None:
    reporter = JobReporter(redis_client, payload.callback.event_channel, payload.job_id)
    await reporter.started()

    workdir = Path(tempfile.mkdtemp(prefix=f"vimax-{payload.job_id}-"))
    try:
        ref_paths = download_objects(
            payload.input.reference_storage_keys or [],
            workdir,
            bucket=payload.callback.upload_bucket,
        )
        await reporter.progress(20, "Loading image generator")

        generator = _build_generator(payload.credential)
        await reporter.progress(40, "Calling image model")

        output = await generator.generate_single_image(
            prompt=payload.input.prompt,
            reference_image_paths=ref_paths,
            size=payload.input.size,
        )

        local_path = workdir / f"{payload.job_id}.png"
        output.save(str(local_path))

        await reporter.progress(80, "Uploading result")
        meta = upload_file(
            local_path,
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
        logger.exception("Job %s failed", payload.job_id)
        code, message, retryable = _map_error(exc)
        await reporter.failed(
            error_code=code,
            error_message=message,
            retryable=retryable,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def handle_image_job(raw: dict[str, Any], redis_client) -> None:
    payload = ImageJobPayload.model_validate(raw)
    asyncio.run(_run(payload, redis_client))
