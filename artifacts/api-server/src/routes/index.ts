import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import adminSessionRouter from "./adminSession";
import backspyneRouter from "./backspyne";
import billingRouter from "./billing";
import bridgeRouter from "./bridge";
import calibrationRouter from "./calibration";
import phoneRelayRouter from "./phoneRelay";
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
// Three routers own prefixes of their own and no other module mounts them. They were written
// and left out of this list, which meant the console's calibration walk, the phone relay, and
// the bridge download all answered 404 on a deployment that shipped the code for them.
router.use(calibrationRouter);
router.use(phoneRelayRouter);
router.use(bridgeRouter);

export default router;
