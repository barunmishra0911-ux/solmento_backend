import { ok } from "../utils/http.js";
import {
  getReportsData,
  createReportActivity,
} from "../services/reportService.js";

export async function getReportsController(req, res, next) {
  try {
    const data = await getReportsData(req.auth.tenantId, req.query, req.auth);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function postReportActivityController(req, res, next) {
  try {
    const record = await createReportActivity(
      req.auth.tenantId,
      req.auth.sub,
      req.body,
      req.auth,
    );
    return ok(res, { activity: record }, 201);
  } catch (error) {
    return next(error);
  }
}
