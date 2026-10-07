"""Pipeline worker — BRPOP from q.pipeline.full and dispatch."""
import json
import os
import sys
import asyncio
import logging

import redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pipeline-worker")

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
QUEUE_KEY = "vimax:queue:q.pipeline.full"

from vimax_image_worker.reporter import JobReporter
from vimax_image_worker.pipeline_handler import handle_pipeline_job


def main():
    # redis-py 8.x defaults socket_timeout to 5s — a blocking BRPOP with a
    # matching command timeout races it, so keep the socket deadline wider
    # than the BRPOP timeout (same shape as main.py's image worker loop).
    def connect() -> redis.Redis:
        return redis.Redis.from_url(REDIS_URL, socket_timeout=10, socket_connect_timeout=5)

    r = connect()
    log.info("Pipeline worker started, waiting on %s", QUEUE_KEY)

    while True:
        try:
            item = r.brpop(QUEUE_KEY, timeout=5)
        except redis.exceptions.RedisError:
            # A blocking BRPOP can die on a transient socket error; rebuild
            # the connection instead of taking the worker down.
            log.warning("Redis connection error on %s, reconnecting", QUEUE_KEY, exc_info=True)
            r = connect()
            continue
        # Idle tick — brpop returned no job within the timeout.
        if item is None:
            continue
        _, raw = item
        payload = json.loads(raw)
        job_id = payload["job_id"]
        job_type = payload.get("job_type", "unknown")
        log.info("Received %s job: %s", job_type, job_id)

        reporter = JobReporter(
            r,
            payload["callback"]["event_channel"],
            job_id,
        )

        try:
            asyncio.run(handle_pipeline_job(payload, reporter))
        except Exception:
            log.exception("Pipeline job %s failed", job_id)


if __name__ == "__main__":
    main()
