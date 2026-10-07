import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env.PORT || "8080";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  logger.info({ port, host }, "Server listening");
});
