import { initTRPC } from "@trpc/server";
import { IMAGE_MODELS, VIDEO_MODELS } from "@vimax/contracts";
import { getModels, getDefaultModel } from "../domain/model/model.service.js";
import { canvasRouter } from "./routers/canvas.js";
import { chatRouter } from "./routers/chat.js";
import { assetRouter, imageRouter } from "./routers/image.js";
import { vendorRouter, skillRouter } from "./routers/vendor.js";
import { workbenchRouter } from "./routers/workbench.js";
import { novelRouter } from "./routers/novel.js";
import { authRouter } from "./routers/auth.js";
import { modelRouter } from "./routers/model.js";

const t = initTRPC.create();

export const appRouter = t.router({
  health: t.procedure.query(() => ({ ok: true, service: "vimax-api" })),

  /** DB-backed model configuration CRUD */
  modelConfig: modelRouter,

  /** Legacy model listing (backward-compat, now DB-backed with hardcoded fallback) */
  model: t.router({
    listImageModels: t.procedure.query(async () => {
      try {
        const items = await getModels("default", "image");
        return {
          items: items.map((m) => ({
            id: m.id,
            label: m.name,
            provider: m.provider,
            sizes: (m.config as Record<string, unknown>)?.sizes ?? ["1024x1024"],
            supports_reference: (m.config as Record<string, unknown>)?.supports_reference ?? true,
            credits_per_image: 1,
          })),
        };
      } catch {
        return {
          items: IMAGE_MODELS.map(({ init_args: _init, class_path: _cls, ...rest }) => rest),
        };
      }
    }),
    listVideoModels: t.procedure.query(async () => {
      try {
        const items = await getModels("default", "video");
        return {
          items: items.map((m) => ({
            id: m.id,
            label: m.name,
            provider: m.provider,
            maxDuration: (m.config as Record<string, unknown>)?.maxDuration ?? 10,
            resolutions: (m.config as Record<string, unknown>)?.resolutions ?? ["720p"],
            supports_reference: (m.config as Record<string, unknown>)?.supports_reference ?? true,
            credits_per_second: 1,
          })),
        };
      } catch {
        return {
          items: VIDEO_MODELS.map(({ init_args: _init, class_path: _cls, ...rest }) => rest),
        };
      }
    }),
    listTextModels: t.procedure.query(async () => {
      try {
        const items = await getModels("default", "text");
        return { items };
      } catch {
        return { items: [] };
      }
    }),
  }),

  auth: authRouter,
  image: imageRouter,
  asset: assetRouter,
  canvas: canvasRouter,
  chat: chatRouter,
  vendor: vendorRouter,
  skill: skillRouter,
  workbench: workbenchRouter,
  novel: novelRouter,
});

export type AppRouter = typeof appRouter;
