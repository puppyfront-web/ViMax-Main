/**
 * BullMQ Queue + Worker for image & video generation jobs.
 *
 * Architecture:
 *   TS API enqueues → BullMQ Queue → Bridge Worker picks up
 *   → LPUSH to Redis list (Python worker BRPOPs)
 *   → Python publishes events → TS PubSub consumer
 *   → On completed: BullMQ job resolved
 *   → On failed:    BullMQ triggers retry (exponential backoff, 3 attempts)
 */
import { Queue, Worker, type Job } from "bullmq";
import type { ImageJobPayload, VideoJobPayload } from "@vimax/contracts";
import { ImageJobPayloadSchema, VideoJobPayloadSchema } from "@vimax/contracts";
import { config } from "../../config/env.js";
import { getRedisQueue, QUEUE_KEY as IMAGE_QUEUE_KEY } from "../redis/client.js";

// ---- Queues ----

const IMAGE_QUEUE_NAME = "q.image.std";
const VIDEO_QUEUE_NAME = "q.video.std";
const VIDEO_QUEUE_KEY = "vimax:queue:q.video.std";

let _imageQueue: Queue | null = null;
let _videoQueue: Queue | null = null;

export function getImageQueue(): Queue {
  if (!_imageQueue) {
    _imageQueue = new Queue(IMAGE_QUEUE_NAME, {
      connection: { url: config.redisUrl() },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 3600 * 24 },
        removeOnFail: { age: 3600 * 24 * 7 },
      },
    });
  }
  return _imageQueue;
}

export function getVideoQueue(): Queue {
  if (!_videoQueue) {
    _videoQueue = new Queue(VIDEO_QUEUE_NAME, {
      connection: { url: config.redisUrl() },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 10000 },
        removeOnComplete: { age: 3600 * 24 * 7 },
        removeOnFail: { age: 3600 * 24 * 14 },
      },
    });
  }
  return _videoQueue;
}

// ---- Image Bridge Worker ----

let _imageBridgeWorker: Worker | null = null;

export function startBridgeWorker(): Worker {
  if (_imageBridgeWorker) return _imageBridgeWorker;

  _imageBridgeWorker = new Worker(
    IMAGE_QUEUE_NAME,
    async (job: Job) => {
      const payload = job.data as ImageJobPayload;
      const parsed = ImageJobPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Invalid image job payload: ${parsed.error.message}`);
      }
      const redis = getRedisQueue();
      await redis.lpush(IMAGE_QUEUE_KEY, JSON.stringify(payload));
    },
    {
      connection: { url: config.redisUrl() },
      concurrency: 5,
    },
  );

  _imageBridgeWorker.on("failed", (job, err) => {
    console.error(`[BullMQ image bridge] Job ${job?.id} failed:`, err.message);
  });
  _imageBridgeWorker.on("completed", (job) => {
    console.log(`[BullMQ image bridge] Job ${job.id} forwarded`);
  });

  return _imageBridgeWorker;
}

// ---- Video Bridge Worker ----

let _videoBridgeWorker: Worker | null = null;

export function startVideoBridgeWorker(): Worker {
  if (_videoBridgeWorker) return _videoBridgeWorker;

  _videoBridgeWorker = new Worker(
    VIDEO_QUEUE_NAME,
    async (job: Job) => {
      const payload = job.data as VideoJobPayload;
      const parsed = VideoJobPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Invalid video job payload: ${parsed.error.message}`);
      }
      const redis = getRedisQueue();
      await redis.lpush(VIDEO_QUEUE_KEY, JSON.stringify(payload));
    },
    {
      connection: { url: config.redisUrl() },
      concurrency: 2, // Video generation is slower/expensive
    },
  );

  _videoBridgeWorker.on("failed", (job, err) => {
    console.error(`[BullMQ video bridge] Job ${job?.id} failed:`, err.message);
  });
  _videoBridgeWorker.on("completed", (job) => {
    console.log(`[BullMQ video bridge] Job ${job.id} forwarded`);
  });

  return _videoBridgeWorker;
}

// ---- Teardown ----

export async function closeQueue(): Promise<void> {
  await Promise.all([
    _imageQueue?.close(),
    _videoQueue?.close(),
    _imageBridgeWorker?.close(),
    _videoBridgeWorker?.close(),
  ]);
  _imageQueue = null;
  _videoQueue = null;
  _imageBridgeWorker = null;
  _videoBridgeWorker = null;
}

// Re-export for backward compat
export { getImageQueue as getQueue };
