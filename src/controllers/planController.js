import { ok } from "../utils/http.js";
import { createPlan, listPlans, updatePlan } from "../services/planService.js";
export async function getPlans(_req, res, next) {
  try {
    return ok(res, { plans: await listPlans() });
  } catch (error) {
    return next(error);
  }
}
export async function postPlan(req, res, next) {
  try {
    return ok(
      res,
      { plan: await createPlan(req.body, req.auth.sub, req.ip) },
      201,
    );
  } catch (error) {
    return next(error);
  }
}
export async function patchPlan(req, res, next) {
  try {
    return ok(res, {
      plan: await updatePlan(req.params.id, req.body, req.auth.sub, req.ip),
    });
  } catch (error) {
    return next(error);
  }
}
