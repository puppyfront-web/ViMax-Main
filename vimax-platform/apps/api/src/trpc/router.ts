import { initTRPC } from "@trpc/server";
import { IMAGE_MODELS } from "@vimax/contracts";
import { assetRouter, imageRouter } from "./routers/image.js";

const t = initTRPC.create();

export const appRouter = t.router({
  health: t.procedure.query(() => ({ ok: true, service: "vimax-api" })),

  model: t.router({
    listImageModels: t.procedure.query(() => ({
      items: IMAGE_MODELS.map(({ init_args: _init, class_path: _cls, ...rest }) => rest),
    })),
  }),

  image: imageRouter,
  asset: assetRouter,
});

export type AppRouter = typeof appRouter;
