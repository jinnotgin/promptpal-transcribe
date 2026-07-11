import { createRouter, createWebHistory } from "vue-router";
import { TRANSCRIPTION_ROUTE_NAMES } from "@/features/transcription/lib/transcriptionRoutes.js";

const TranscriptionView = () => import("@/views/TranscriptionView.vue");

/** @type {import("vue-router").RouteRecordRaw[]} */
export const routes = [
  {
    path: "/",
    redirect: { name: TRANSCRIPTION_ROUTE_NAMES.start },
  },
  {
    path: "/transcribe",
    name: TRANSCRIPTION_ROUTE_NAMES.start,
    component: TranscriptionView,
    meta: { product: "transcribe" },
  },
  {
    path: "/transcribe/history",
    name: TRANSCRIPTION_ROUTE_NAMES.history,
    component: TranscriptionView,
    meta: { product: "transcribe" },
  },
  {
    path: "/transcribe/history/:transcriptId",
    name: TRANSCRIPTION_ROUTE_NAMES.detail,
    component: TranscriptionView,
    meta: { product: "transcribe" },
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: { name: TRANSCRIPTION_ROUTE_NAMES.start },
  },
];

export function createAppRouter(
  history = createWebHistory(import.meta.env.BASE_URL),
) {
  return createRouter({ history, routes });
}
