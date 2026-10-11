// Every route that must answer without a database.
//
// `routes/index.ts` is the whole API, and importing it imports the billing, relay, and
// admin-revenue routers, every one of which reaches `@workspace/db` — a module that throws at
// import time when `DATABASE_URL` is unset. That is the right behaviour for a route that needs
// rows, but it must not decide the fate of a route that needs none: a pricing page a prospect
// can read, and an administrator's sign-in, are both answerable from configuration alone.
//
// So the unauthenticated surface lives here, imports no database module, and is what `app.ts`
// mounts for `/public/*` and for the three administrator credential paths. Anything with rows
// behind it stays in `index.ts`.

import { Router, type IRouter } from "express";

import adminSessionRouter from "./adminSession";
import publicRouter from "./public";

const router: IRouter = Router();

router.use(publicRouter);
router.use(adminSessionRouter);

export default router;
