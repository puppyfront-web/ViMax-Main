import type { ImageJobPayload } from "@vimax/contracts";
import { getImageQueue } from "./bullmq.js";

/**
 * Enqueue an image generation job via BullMQ.
 *
 * BullMQ handles retry (3 attempts, exponential backoff 5s),
 * job timeout (120s), and job persistence.
 *
 * A bridge worker picks up the job and forwards it to the
 * Redis list consumed by the Python worker.
 */
export async function enqueueImageJob(payload: ImageJobPayload): Promise<void> {
  const queue = getImageQueue();
  await queue.add(payload.job_type, payload, {
    jobId: payload.job_id,
  });
}
