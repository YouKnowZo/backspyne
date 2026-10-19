import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

export default defineConfig({
  base: "/",
  plugins: [
    mockupPreviewPlugin(),
    react(),
    tailwindcss({ optimize: false }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    // esbuild >=0.28 no longer lowers destructuring down to the es2020 default target.
    // This sandbox previews on modern browsers only, so ask for a modern target.
    target: "es2022",
  },
  server: {
    port: 0,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port: 0,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
