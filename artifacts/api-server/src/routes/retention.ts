// Operator-configurable observation retention windows and one-click site data purge.
//
// Mounted under `/api/retention` and `/api/retention/purge`.
// Mutations require same-origin headers and an authenticated operator session.

import { Router, type IRouter } from "express";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { safeOrigin } from "../lib/billing/stripe";
import { planDefinition } from "../lib/billing/plans";
import { parsePurgeRequest, parseRequestedRetentionDays } from "../lib/retention";
import {
  executeDataPurge,
  readRetentionFootprint,
  resolveOwnerRetention,
  saveRetentionPreference,
} from "../lib/retentionStore";

const router: IRouter = Router();

router.use((req, res, next) => {
  if (req.path.startsWith("/retention") && (req.method === "POST" || req.method === "PUT" || req.method === "DELETE")) {
    const origin = req.header("origin");
    const allowed = safeOrigin(process.env.FRONTEND_ORIGIN ?? process.env.APP_ORIGIN);
    if ((origin && allowed && origin !== allowed) || req.header("sec-fetch-site") === "cross-site") {
      res.status(403).json({ error: "Cross-origin retention mutations are not allowed" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
  }
  next();
});

async function buildRetentionResponse(ownerId: string) {
  const { policy, preference, planId } = await resolveOwnerRetention(ownerId);
  const footprint = await readRetentionFootprint(ownerId, policy.cutoffDate);
  return {
    planId,
    planName: planDefinition(planId).name,
    configuredDays: policy.configuredDays,
    effectiveDays: policy.effectiveDays,
    planMaxDays: policy.planMaxDays,
    planUnlimited: policy.planUnlimited,
    autoPrune: policy.autoPrune,
    cutoffDate: policy.cutoffDate.toISOString(),
    lastPurgedAt: preference.lastPurgedAt,
    updatedAt: preference.updatedAt,
    options: policy.options,
    footprint,
  };
}

router.get("/retention", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await buildRetentionResponse(req.userId!));
  } catch (error) {
    next(error);
  }
});

router.put("/retention", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const requestedDays = parseRequestedRetentionDays(req.body?.retentionDays);
    if (requestedDays === undefined) {
      res.status(400).json({ error: "retentionDays must be null (plan default) or one of 1, 3, 7, 14, 30, 90, 365" });
      return;
    }
    const autoPrune = typeof req.body?.autoPrune === "boolean" ? req.body.autoPrune : true;
    const { policy, planId } = await resolveOwnerRetention(req.userId!);
    if (requestedDays !== null && !policy.planUnlimited && requestedDays > policy.planMaxDays) {
      res.status(403).json({
        error: `The ${planDefinition(planId).name} plan includes up to ${policy.planMaxDays} days of observation history. Upgrade your plan to retain ${requestedDays} days.`,
        code: "retention_exceeds_plan",
        planMaxDays: policy.planMaxDays,
      });
      return;
    }
    const saved = await saveRetentionPreference(req.userId!, {
      retentionDays: requestedDays,
      autoPrune,
    });
    if (!saved) {
      res.status(503).json({ error: "The retention policy could not be saved on this deployment" });
      return;
    }
    const nextState = await buildRetentionResponse(req.userId!);
    if (nextState.autoPrune && nextState.footprint.devicesExpired + nextState.footprint.sightingsExpired > 0) {
      await executeDataPurge(req.userId!, {
        scope: "expired",
        cutoffDate: new Date(nextState.cutoffDate),
      });
      res.json(await buildRetentionResponse(req.userId!));
      return;
    }
    res.json(nextState);
  } catch (error) {
    next(error);
  }
});

router.post("/retention/purge", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = parsePurgeRequest(req.body);
    if (!parsed) {
      res.status(400).json({
        error: 'Provide scope: "expired" to prune expired history, or scope: "site" with confirm: "PURGE" to clear all site observations.',
      });
      return;
    }
    const { policy } = await resolveOwnerRetention(req.userId!);
    const summary = await executeDataPurge(req.userId!, {
      scope: parsed.scope,
      cutoffDate: policy.cutoffDate,
      resetRelays: parsed.resetRelays,
    });
    const state = await buildRetentionResponse(req.userId!);
    res.json({
      purged: summary,
      retention: state,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
