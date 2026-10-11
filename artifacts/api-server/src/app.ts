import express, { type Express } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { adminConfigured } from "./lib/adminAuth";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

app.set("trust proxy", 1);
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: process.env.FRONTEND_ORIGIN || false }));
if (process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}
app.use(express.json({
  limit: "256kb",
  verify: (req, _res, buffer) => {
    (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: true }));

async function routeApi(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (req.path === "/healthz" && req.method === "GET") {
    res.json({ status: "ok", database: process.env.DATABASE_URL ? "configured" : "not_configured" });
    return;
  }
  // Two families of route deliberately answer without Clerk, because neither is an operator
  // request: the public plan catalog is the pricing page, and the administrator's sign-in,
  // sign-out, and session read are how the deployment's own owner gets in when a third-party
  // identity provider is not configured (a local checkout, or a staging deployment). Both are
  // still gated on their own configuration — a deployment with no administrator configured
  // says so rather than exposing a login that could never succeed.
  //
  // They are served by `./routes/open`, which imports no database module. Importing the whole
  // API here would pull in `@workspace/db`, and that module throws at import time when
  // `DATABASE_URL` is unset — turning a route that needs no rows into a 500.
  if (req.path.startsWith("/public/")) {
    try {
      const { default: router } = await import("./routes/open");
      router(req, res, next);
    } catch (error) {
      next(error);
    }
    return;
  }
  const adminAuthPath = req.path === "/admin/login" || req.path === "/admin/logout" || req.path === "/admin/session";
  if (adminAuthPath && adminConfigured()) {
    try {
      const { default: router } = await import("./routes/open");
      router(req, res, next);
    } catch (error) {
      next(error);
    }
    return;
  }
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: "Database is not configured; telemetry and operator data are unavailable" });
    return;
  }
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    // With no Clerk instance, an administrator session is the only identity this deployment
    // has. Anything that needs an owner still requires the database above, so this widens who
    // may ask, never what is answered without data.
    if (adminConfigured()) {
      try {
        const { default: router } = await import("./routes");
        router(req, res, next);
      } catch (error) {
        next(error);
      }
      return;
    }
    res.status(503).json({ error: "Authentication is not configured; operator API is unavailable" });
    return;
  }
  try {
    const { default: router } = await import("./routes");
    router(req, res, next);
  } catch (error) {
    next(error);
  }
}

app.use("/api", routeApi);

const webDir = path.resolve(process.cwd(), "dist/web");

let builtHtml: string | null = null;
async function serveShell(_req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    if (!builtHtml) builtHtml = await readFile(path.resolve(webDir, "index.html"), "utf8");
    res.type("html").send(builtHtml);
  } catch (error) {
    next(error);
  }
}

app.get("/assets/:file", async (req, res, next) => {
  try {
    const fileName = String(req.params.file || "");
    if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
      res.status(404).end();
      return;
    }
    const filePath = path.resolve(webDir, "assets", fileName);
    const contents = await readFile(filePath);
    res.type(path.extname(filePath)).set("Cache-Control", "public, max-age=31536000, immutable").send(contents);
  } catch (error) {
    next(error);
  }
});
app.get("/manifest.webmanifest", async (_req, res, next) => {
  try {
    res.type("application/manifest+json").send(await readFile(path.resolve(webDir, "manifest.webmanifest")));
  } catch (error) { next(error); }
});
app.get("/sw.js", async (_req, res, next) => {
  try {
    res.type("application/javascript").set("Service-Worker-Allowed", "/").send(await readFile(path.resolve(webDir, "sw.js")));
  } catch (error) { next(error); }
});
app.get("/favicon.svg", async (_req, res, next) => {
  try {
    res.type("image/svg+xml").send(await readFile(path.resolve(webDir, "favicon.svg")));
  } catch (error) { next(error); }
});
app.get("/logo.svg", async (_req, res, next) => {
  try {
    res.type("image/svg+xml").send(await readFile(path.resolve(webDir, "logo.svg")));
  } catch (error) { next(error); }
});
app.get("/", serveShell);
app.get("/index.html", serveShell);
app.get("/legal", serveShell);
app.get("/user-portal", serveShell);
// The administrator's own address is a client route like any other view: without it a
// bookmark, a refresh, or a pasted link to /admin reaches the shell's 404 instead of the
// sign-in form, and the one account that exists to open a deployment cannot get in.
app.get("/admin", serveShell);
app.get("/admin/*splat", serveShell);
// The console's views live at their own addresses, so a deep link, a shared link, or a
// refresh inside any of them has to reach the shell rather than a 404.
app.get("/user-portal/*splat", serveShell);
app.get("/sign-in", serveShell);
app.get("/sign-in/*splat", serveShell);
app.get("/sign-up", serveShell);
app.get("/sign-up/*splat", serveShell);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (process.env.BACKSPYNE_TRACE_ERRORS === "1") console.error("TRACE:", err);
  logger.error({ err }, "Unhandled API request error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

export default app;
