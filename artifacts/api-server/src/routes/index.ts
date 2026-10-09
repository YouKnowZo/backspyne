import { Router, type IRouter } from "express";
import healthRouter from "./health";
import backspyneRouter from "./backspyne";
import billingRouter from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(backspyneRouter);
router.use(billingRouter);

export default router;
