"""Redis queue consumer for video concat jobs."""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
from pathlib import Path

import redis
from dotenv import load_dotenv

from vimax_image_worker.concat_handler import handle_concat_job

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

QUEUE_NAME = "q.concat.std"
QUEUE_KEY = f"vimax:queue:{QUEUE_NAME}"


def setup_vimax_path() -> None:
    vimax_root = os.environ.get("VIMAX_ROOT", "..")
    resolved = Path(vimax_root).resolve()
    if str(resolved) not in sys.path:
        sys.path.insert(0, str(resolved))


def main() -> None:
    load_dotenv()
    setup_vimax_path()

    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    client = redis.from_url(
        redis_url,
        decode_responses=True,
        socket_timeout=10,
        socket_connect_timeout=5,
    )

    logger.info("ViMax concat worker started, queue=%s", QUEUE_NAME)

    running = True

    def shutdown(_signum, _frame):
        nonlocal running
        running = False
        logger.info("Shutting down concat worker...")

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while running:
        item = client.brpop(QUEUE_KEY, timeout=5)
        if not item:
            continue

        _, raw = item
        try:
            payload = json.loads(raw)
            handle_concat_job(payload, client)
        except Exception:
            logger.exception("Failed to process concat job")


if __name__ == "__main__":
    main()
