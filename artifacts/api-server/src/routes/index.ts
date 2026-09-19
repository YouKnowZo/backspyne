import { Router, type IRouter } from "express";
import healthRouter from "./health";
import backspyneRouter from "./backspyne";

const router: IRouter = Router();

router.use(healthRouter);
router.use(backspyneRouter);

export default router;
