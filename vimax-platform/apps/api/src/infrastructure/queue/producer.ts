import type { ImageJobPayload, VideoJobPayload } from "@vimax/contracts";
import { getImageQueue, getVideoQueue } from "./bullmq.js";

/**
 * Enqueue an image generation job via BullMQ.
 */
export async function enqueueImageJob(payload: ImageJobPayload): Promise<void> {
  const queue = getImageQueue();
  await queue.add(payload.job_type, payload, { jobId: payload.job_id });
}

/**
 * Enqueue a video generation job via BullMQ.
 */
export async function enqueueVideoJob(payload: VideoJobPayload): Promise<void> {
  const queue = getVideoQueue();
  await queue.add(payload.job_type, payload, { jobId: payload.job_id });
}
