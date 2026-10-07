import app from "./app";

// Bundled deploy entrypoint: exports the Express application without starting a
// listener. The Vercel function entrypoint imports this build artifact instead of
// the TypeScript sources, because the platform transpiles files individually and
// cannot follow the workspace's bundler-style imports.
export default app;
