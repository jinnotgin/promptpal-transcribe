import path from "node:path";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import pkg from "./package.json" with { type: "json" };
import { siteUrlMeta } from "./scripts/siteUrlMeta.js";
import { dropOrtWasm } from "./scripts/dropOrtWasm.js";

export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    tailwindcss(),
    // Absolute share-image URLs and a canonical link when VITE_SITE_URL is set.
    siteUrlMeta(loadEnv(mode, process.cwd(), "").VITE_SITE_URL),
    // Drop ONNX Runtime's 24-28 MB WASM files; they load from jsDelivr at runtime.
    dropOrtWasm(),
  ],
  // Shown as the app version in the UI.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // Keep onnxruntime-web out of dependency pre-bundling, which breaks how it
  // locates its WASM loader.
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
  // Model workers are ES modules so they can import onnxruntime-web.
  worker: {
    format: "es",
    optimizeDeps: {
      exclude: ["onnxruntime-web"],
    },
  },
}));
