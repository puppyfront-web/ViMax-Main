import "dotenv/config";
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config/env.js";
import { getDb } from "./infrastructure/db/client.js";
import { startAllBridgeWorkers } from "./infrastructure/queue/bullmq.js";
import { startJobEventConsumer } from "./infrastructure/pubsub/consumer.js";
import { jobSseHandler } from "./realtime/job-sse.route.js";
import { createWebSocketServer, handleUpgrade } from "./realtime/websocket.js";
import { initVendorRegistry } from "./domain/vendor/vendor-registry.js";
import { initSkillRegistry } from "./domain/skill/skill-registry.js";
import { seedModels } from "./domain/model/model.service.js";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/trpc.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3010", "http://127.0.0.1:3010"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/health", (c) => c.json({ ok: true, service: "vimax-api" }));

app.get("/sse/jobs/:jobId", jobSseHandler);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (opts) => createContext(opts),
  }),
);

const port = config.apiPort();
const host = config.apiHost();

async function bootstrap() {
  try {
    getDb();
    console.log("Database connection initialized");

    // Seed default models if table is empty
    try {
      const seeded = await seedModels();
      if (seeded > 0) console.log(`Seeded ${seeded} default models`);
    } catch (err) {
      console.warn("Model seeding skipped:", (err as Error).message);
    }
  } catch (err) {
    console.warn("Database not connected yet:", (err as Error).message);
  }

  try {
    startAllBridgeWorkers();
    console.log("BullMQ bridge workers started (image/video/concat/audio/pipeline)");
  } catch (err) {
    console.warn("BullMQ bridge workers not started:", (err as Error).message);
  }

  try {
    await startJobEventConsumer();
  } catch (err) {
    console.warn("Job event consumer not started:", (err as Error).message);
  }

  // Create WebSocket server
  createWebSocketServer();

  // Initialize vendor plugin system
  initVendorRegistry();

  // Initialize skill system
  initSkillRegistry();

  // Start Hono HTTP server — serve() returns the underlying http.Server
  const httpServer = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`ViMax API listening on http://${info.address}:${info.port}`);
    console.log(`SSE endpoint: http://${info.address}:${info.port}/sse/jobs/:jobId`);
    console.log(`WebSocket endpoint: ws://${info.address}:${info.port}/ws`);
  });

  // Handle WebSocket upgrades on the same HTTP server
  httpServer.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head);
  });
}

bootstrap();
