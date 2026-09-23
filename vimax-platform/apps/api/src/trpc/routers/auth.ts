import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import * as authService from "../../domain/auth/auth.service.js";

const t = initTRPC.create();

export const authRouter = t.router({
  register: t.procedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(6, "Password must be at least 6 characters"),
        name: z.string().min(1, "Name is required"),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await authService.registerUser(input.email, input.password, input.name);
      return result;
    }),

  login: t.procedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await authService.loginUser(input.email, input.password);
      return result;
    }),

  refresh: t.procedure
    .input(
      z.object({
        refreshToken: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const tokens = await authService.refreshSession(input.refreshToken);
      return tokens;
    }),

  logout: t.procedure
    .input(
      z.object({
        refreshToken: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      await authService.logoutSession(input.refreshToken);
      return { ok: true };
    }),

  me: t.procedure
    .input(
      z.object({
        accessToken: z.string().min(1),
      }),
    )
    .query(async ({ input }) => {
      const user = await authService.getUserFromToken(input.accessToken);
      if (!user) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired token" });
      }
      return { user };
    }),
});
