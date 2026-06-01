import "dotenv/config";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config/env.js";
import { getDb } from "./infrastructure/db/client.js";
import { startBridgeWorker } from "./infrastructure/queue/bullmq.js";
import { startJobEventConsumer } from "./infrastructure/pubsub/consumer.js";
import { jobSseHandler } from "./realtime/job-sse.route.js";
import { appRouter } from "./trpc/router.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/health", (c) => c.json({ ok: true, service: "vimax-api" }));

app.get("/sse/jobs/:jobId", jobSseHandler);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
  }),
);

const port = config.apiPort();
const host = config.apiHost();

async function bootstrap() {
  try {
    getDb();
    console.log("Database connection initialized");
  } catch (err) {
    console.warn("Database not connected yet:", (err as Error).message);
  }

  try {
    startBridgeWorker();
    console.log("BullMQ bridge worker started");
  } catch (err) {
    console.warn("BullMQ bridge worker not started:", (err as Error).message);
  }

  try {
    await startJobEventConsumer();
  } catch (err) {
    console.warn("Job event consumer not started:", (err as Error).message);
  }

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`ViMax API listening on http://${info.address}:${info.port}`);
    console.log(`SSE endpoint: http://${info.address}:${info.port}/sse/jobs/:jobId`);
  });
}

bootstrap();
