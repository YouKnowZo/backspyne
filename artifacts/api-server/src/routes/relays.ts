import { Router, type IRouter } from "express";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { ownerEntitlements } from "../lib/billing/subscriptions";
import {
  countActiveRelayTokens,
  createRelayToken,
  listRelayTokens,
  revokeRelayToken,
} from "../lib/relays";

const router: IRouter = Router();

function relayAllowance(maxRelays: number, active: number, unlimited = false) {
  return { maxRelays, active, remaining: Math.max(0, maxRelays - active), unlimited };
}

/** Pairing state for the signed-in operator. Token digests are never returned. */
router.get("/relays", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const [relays, allowance] = await Promise.all([
      listRelayTokens(req.userId!),
      (async () => {
        const { entitlements } = await ownerEntitlements(req.userId!);
        return entitlements;
      })(),
    ]);
    const active = relays.filter((relay) => relay.active).length;
    res.json({ relays, allowance: relayAllowance(allowance.maxRelays, active, allowance.unlimited === true) });
  } catch (error) {
    next(error);
  }
});

/**
 * Creates a pairing token. The plaintext value is returned exactly once, because only
 * its digest is stored; an operator who loses it revokes the relay and pairs again.
 */
router.post("/relays", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 120) : "";
    if (!label) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    const { entitlements } = await ownerEntitlements(req.userId!);
    const active = await countActiveRelayTokens(req.userId!);
    if (active >= entitlements.maxRelays) {
      res.status(403).json({
        error: `The current plan allows ${entitlements.maxRelays} paired relay${entitlements.maxRelays === 1 ? "" : "s"}`,
        code: "relay_limit_reached",
        maxRelays: entitlements.maxRelays,
        active,
      });
      return;
    }
    const created = await createRelayToken(req.userId!, label);
    res.status(201).json({ relay: created.relay, token: created.token, allowance: relayAllowance(entitlements.maxRelays, active + 1, entitlements.unlimited === true) });
  } catch (error) {
    next(error);
  }
});

router.post("/relays/:id/revoke", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const relay = await revokeRelayToken(req.userId!, String(req.params.id));
    if (!relay) {
      res.status(404).json({ error: "Relay token not found" });
      return;
    }
    res.json({ relay });
  } catch (error) {
    next(error);
  }
});

export default router;
