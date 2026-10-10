// Client-ready assessment reports.
//
// The report is the deliverable an operator hands to a client, so it is served as a
// self-contained document rather than as data for the console to re-render: what is printed
// is exactly what was modelled on the server. Everything that appears in it comes from
// stored relay observations and the operator's own plan.
//
// One route serves two audiences, and the difference is only how it is authorized:
//  - the signed-in operator opens their own copy with their session, and
//  - anyone holding a share link opens a copy scoped to the account that issued it, until
//    that link's signed expiry passes.
// Entitlements gate the *notice*, not access. A plan that does not include client-ready
// export still receives the document, marked as a trial, because the fastest way to
// explain what a paid plan adds is to show it.

import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { rfDevices, scanNodes } from "@workspace/db/schema";
import { buildAssessment } from "@workspace/assessment";
import { requireAuth, getOptionalUserId, type AuthenticatedRequest } from "../lib/auth";
import { ownerEntitlements } from "../lib/billing/subscriptions";
import { planDefinition } from "../lib/billing/plans";
import { renderAssessmentReport } from "../lib/report";
import { createReportShareToken, readReportShareToken, shareLinksAvailable, SHARE_TTL_DAYS } from "../lib/reportShare";
import { toAssessmentDevice } from "../lib/assessmentInput";

const router: IRouter = Router();

/** How many stored observations one report can model, newest first. */
const REPORT_DEVICE_LIMIT = 250;

/**
 * A display-only label from the query string. These values are never used for
 * authorization, and anything that survives here is escaped again when rendered.
 */
export function displayLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);
  return cleaned || fallback;
}

/**
 * Creates a link the operator can hand to a client. The labels travel inside the signature,
 * so a recipient cannot relabel the document by editing the URL.
 */
router.post("/report/assessment/share", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!shareLinksAvailable()) {
      res.status(503).json({ error: "Share links are not configured on this deployment." });
      return;
    }
    const created = createReportShareToken({
      ownerId: req.userId!,
      site: displayLabel(req.body?.site, "Unnamed site"),
      operatorName: displayLabel(req.body?.for, "Licensed operator"),
    });
    if (!created) {
      res.status(503).json({ error: "Share links are not configured on this deployment." });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      url: `/api/report/assessment?share=${encodeURIComponent(created.token)}`,
      expiresAt: new Date(created.expiresAt).toISOString(),
      days: SHARE_TTL_DAYS,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/report/assessment", async (req: AuthenticatedRequest, res, next) => {
  try {
    const shareToken = typeof req.query.share === "string" ? req.query.share : "";
    const share = shareToken ? readReportShareToken(shareToken) : null;
    if (shareToken && !share) {
      res.status(401).json({ error: "This assessment link is invalid or has expired. Ask the operator for a new one." });
      return;
    }
    const sessionOwner = getOptionalUserId(req);
    const ownerId = share?.ownerId ?? sessionOwner;
    if (!ownerId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const [rows, nodes] = await Promise.all([
      db
        .select()
        .from(rfDevices)
        .where(eq(rfDevices.ownerId, ownerId))
        .orderBy(desc(rfDevices.lastSeenAt))
        .limit(REPORT_DEVICE_LIMIT),
      db
        .select()
        .from(scanNodes)
        .where(eq(scanNodes.ownerId, ownerId))
        .orderBy(desc(scanNodes.lastHeartbeatAt)),
    ]);

    const now = Date.now();
    const assessment = buildAssessment({ devices: rows.map((row) => toAssessmentDevice(row, now)), now });
    const { planId, entitlements } = await ownerEntitlements(ownerId);

    const html = renderAssessmentReport(assessment, {
      operatorName: share ? share.operatorName || "Licensed operator" : displayLabel(req.query.for, "Licensed operator"),
      planName: planDefinition(planId).name,
      trial: !entitlements.reportExport,
      generatedAt: new Date(),
      relays: nodes.map((node) => ({ name: node.name, lastHeartbeat: node.lastHeartbeatAt ?? null })),
      considered: rows.length,
      siteLabel: share ? share.site || nodes[0]?.name || "Unnamed site" : displayLabel(req.query.site, nodes[0]?.name ?? "Unnamed site"),
      sharedUntil: share ? new Date(share.expiresAt) : null,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="backspyne-assessment-${new Date().toISOString().slice(0, 10)}.html"`,
    );
    res.send(html);
  } catch (error) {
    next(error);
  }
});

export default router;
