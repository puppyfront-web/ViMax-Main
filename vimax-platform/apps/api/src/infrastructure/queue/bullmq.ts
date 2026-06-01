/**
 * BullMQ Queue + Worker for image generation jobs.
 *
 * Architecture:
 *   TS API enqueues → BullMQ Queue → Bridge Worker picks up
 *   → LPUSH to Redis list (Python worker BRPOPs)
 *   → Python publishes events → TS PubSub consumer
 *   → On completed: BullMQ job resolved
 *   → On failed:    BullMQ triggers retry (exponential backoff, 3 attempts)
 */
import { Queue, Worker, type Job } from "bullmq";
import type { ImageJobPayload } from "@vimax/contracts";
import { ImageJobPayloadSchema } from "@vimax/contracts";
import { config } from "../../config/env.js";
import { getRedisQueue, QUEUE_KEY } from "../redis/client.js";

// ---- Queue ----

const QUEUE_NAME = "q.image.std";

let _queue: Queue | null = null;

export function getImageQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: { url: config.redisUrl() },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: { age: 3600 * 24 },   // keep 1 day
        removeOnFail: { age: 3600 * 24 * 7 },     // keep 1 week
      },
    });
  }
  return _queue;
}

// ---- Bridge Worker ----
// Takes BullMQ jobs and pushes them to the Redis list that the Python
// worker BRPOPs from.  The Python worker is unaware of BullMQ; it just
// reads raw JSON from the list and publishes events back via Pub/Sub.

let _bridgeWorker: Worker | null = null;

export function startBridgeWorker(): Worker {
  if (_bridgeWorker) return _bridgeWorker;

  _bridgeWorker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const payload = job.data as ImageJobPayload;

      // Validate payload before forwarding
      const parsed = ImageJobPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Invalid job payload: ${parsed.error.message}`);
      }

      const redis = getRedisQueue();
      await redis.lpush(QUEUE_KEY, JSON.stringify(payload));

      // The Python worker will publish events to events:job:{job_id}.
      // The TS PubSub consumer (pubsub/consumer.ts) receives them and
      // updates DB + SSE connections.  The bridge worker does NOT wait
      // for completion — it just forwards and returns.  Completion/
      // failure is handled out-of-band via Pub/Sub.
    },
    {
      connection: { url: config.redisUrl() },
      concurrency: 5,
    },
  );

  _bridgeWorker.on("failed", (job, err) => {
    console.error(`[BullMQ bridge] Job ${job?.id} failed:`, err.message);
  });

  _bridgeWorker.on("completed", (job) => {
    console.log(`[BullMQ bridge] Job ${job.id} forwarded to Python queue`);
  });

  return _bridgeWorker;
}

export async function closeQueue(): Promise<void> {
  await Promise.all([
    _queue?.close(),
    _bridgeWorker?.close(),
  ]);
  _queue = null;
  _bridgeWorker = null;
}
