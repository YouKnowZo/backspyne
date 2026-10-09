import { Router, type IRouter } from "express";
import healthRouter from "./health";
import backspyneRouter from "./backspyne";
import billingRouter from "./billing";
import relaysRouter from "./relays";

const router: IRouter = Router();

router.use(healthRouter);
router.use(backspyneRouter);
router.use(billingRouter);
router.use(relaysRouter);

export default router;
