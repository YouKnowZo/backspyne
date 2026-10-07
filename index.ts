import express from "express";
import type { Express } from "express";

// Vercel's Express framework detection requires the entrypoint itself to import
// express and export the Express instance as its default export.
const app = express();

// The API application is imported from its bundled build artifact rather than its
// TypeScript sources: Vercel transpiles files individually, so it cannot resolve the
// workspace's bundler-style imports or its TypeScript-only libraries.
const apiApp: Promise<Express> = import("./dist/api/handler.mjs").then(
  (module) => (module as unknown as { default: Express }).default,
);

app.use(async (req, res, next) => {
  try {
    (await apiApp)(req, res, next);
  } catch (error) {
    next(error);
  }
});

export default app;
