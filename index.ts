import express from "express";
import apiApp from "./artifacts/api-server/src/app";

// Vercel's Express framework detection looks for an entrypoint that imports
// express and exports the Express instance as its default export. The outer
// app here exists only to satisfy that contract; all routing, middleware, and
// error handling live in the api-server application mounted below.
const app = express();

app.use(apiApp);

export default app;
