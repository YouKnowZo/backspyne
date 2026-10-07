import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  logger.warn({ env: process.env.PORT }, "PORT not set; defaulting to 0 (OS-assigned)");
}
const port = rawPort ? Number(rawPort) : 0;
if (Number.isNaN(port) || port < 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}
app.listen(port, () => {
  logger.info({ port, host: process.env.HOST || '0.0.0.0' }, "Server listening");
});
