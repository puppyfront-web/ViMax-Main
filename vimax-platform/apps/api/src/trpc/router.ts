import { IMAGE_MODELS, VIDEO_MODELS } from "@vimax/contracts";
import { getModels, getDefaultModel } from "../domain/model/model.service.js";
import { canvasRouter } from "./routers/canvas.js";
import { chatRouter } from "./routers/chat.js";
import { assetRouter, imageRouter } from "./routers/image.js";
import { videoRouter } from "./routers/video.js";
import { vendorRouter, skillRouter } from "./routers/vendor.js";
import { workbenchRouter } from "./routers/workbench.js";
import { novelRouter } from "./routers/novel.js";
import { authRouter } from "./routers/auth.js";
import { modelRouter } from "./routers/model.js";
import { router, publicProcedure } from "./trpc.js";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, service: "vimax-api" })),

  /** DB-backed model configuration CRUD */
  modelConfig: modelRouter,

  /** Legacy model listing (backward-compat, now DB-backed with hardcoded fallback) */
  model: router({
    listImageModels: publicProcedure.query(async () => {
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
    listVideoModels: publicProcedure.query(async () => {
      try {
        const items = await getModels("default", "video");
        return {
          items: items.map((m) => {
            const cfg = m.config as Record<string, unknown>;
            return {
              id: m.id,
              label: m.name,
              provider: m.provider,
              maxDuration: Number(cfg?.maxDuration ?? 10),
              resolutions: (cfg?.resolutions as string[] | undefined) ?? ["720p"],
              supports_reference: Boolean(cfg?.supports_reference ?? true),
              credits_per_second: Number(cfg?.credits_per_second ?? 1),
            };
          }),
        };
      } catch {
        return {
          items: VIDEO_MODELS.map(({ init_args: _init, class_path: _cls, ...rest }) => rest),
        };
      }
    }),
    listTextModels: publicProcedure.query(async () => {
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
  video: videoRouter,
  asset: assetRouter,
  canvas: canvasRouter,
  chat: chatRouter,
  vendor: vendorRouter,
  skill: skillRouter,
  workbench: workbenchRouter,
  novel: novelRouter,
});

export type AppRouter = typeof appRouter;
