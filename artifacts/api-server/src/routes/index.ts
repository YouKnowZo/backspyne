import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import adminSessionRouter from "./adminSession";
import backspyneRouter from "./backspyne";
import billingRouter from "./billing";
import publicRouter from "./public";
import relaysRouter from "./relays";
import reportsRouter from "./reports";

const router: IRouter = Router();

router.use(healthRouter);
// Public and administrative routes come first: neither requires a Clerk session, so neither
// should be behind a router that assumes one.
router.use(publicRouter);
router.use(adminSessionRouter);
router.use(adminRouter);
router.use(backspyneRouter);
router.use(billingRouter);
router.use(relaysRouter);
router.use(reportsRouter);

export default router;
