import { describe, expect, it } from "vitest";
import { TRANSCRIPTION_ROUTE_NAMES } from "@/features/transcription/lib/transcriptionRoutes.js";
import { routes } from "./router.js";

describe("standalone router", () => {
  it("redirects the public root directly to Transcribe", () => {
    const rootRoute = routes.find((route) => route.path === "/");

    expect(rootRoute).toMatchObject({
      redirect: { name: TRANSCRIPTION_ROUTE_NAMES.start },
    });
  });

  it("exposes public start, history, and transcript detail routes", () => {
    expect(
      routes
        .filter((route) => route.meta?.product === "transcribe")
        .map(({ path, name, meta }) => ({
          path,
          name,
          requiresAuth: meta.requiresAuth,
        })),
    ).toEqual([
      {
        path: "/transcribe",
        name: TRANSCRIPTION_ROUTE_NAMES.start,
        requiresAuth: undefined,
      },
      {
        path: "/transcribe/history",
        name: TRANSCRIPTION_ROUTE_NAMES.history,
        requiresAuth: undefined,
      },
      {
        path: "/transcribe/history/:transcriptId",
        name: TRANSCRIPTION_ROUTE_NAMES.detail,
        requiresAuth: undefined,
      },
    ]);
  });
});
