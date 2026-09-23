"""Audio worker — BRPOP from q.audio.std and dispatch.

Mirrors concat_main.py: the bridge LPUSHes bridge-shaped job payloads to
`vimax:queue:q.audio.std`, this worker BRPOPs them and hands each payload
to the audio handler together with a Redis-backed job reporter.
"""
from __future__ import annotations

import json
import logging
import os
import signal

import redis

from vimax_image_worker.audio_handler import handle_audio_job
from vimax_image_worker.reporter import JobReporter

QUEUE_KEY = "vimax:queue:q.audio.std"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("audio-worker")


def main() -> None:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    client = redis.from_url(
        redis_url,
        decode_responses=True,
        socket_timeout=10,
        socket_connect_timeout=5,
    )

    logger.info("ViMax audio worker started, queue=%s", QUEUE_KEY)

    running = True

    def shutdown(_signum, _frame):
        nonlocal running
        running = False
        logger.info("Shutting down audio worker...")

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while running:
        try:
            item = client.brpop(QUEUE_KEY, timeout=5)
        except redis.RedisError:
            logger.warning("Redis connection error on %s, reconnecting", QUEUE_KEY, exc_info=True)
            client = redis.from_url(
                redis_url,
                decode_responses=True,
                socket_timeout=10,
                socket_connect_timeout=5,
            )
            continue
        if not item:
            continue

        _, raw = item
        try:
            payload = json.loads(raw)
            reporter = JobReporter(client, payload["callback"]["event_channel"], payload["job_id"])
            import asyncio

            asyncio.run(handle_audio_job(payload, reporter))
        except Exception:
            logger.exception("Failed to process audio job")


if __name__ == "__main__":
    main()
