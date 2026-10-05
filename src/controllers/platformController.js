import { ok } from "../utils/http.js";
import {
  createPlatformRecord,
  deletePlatformRecord,
  listPlatformRecords,
  restorePlatformRecord,
} from "../services/platformRecordService.js";

export async function listRecords(req, res, next) {
  try {
    return ok(res, {
      records: await listPlatformRecords(req.params.module, req.query),
    });
  } catch (error) {
    return next(error);
  }
}
export async function createRecord(req, res, next) {
  try {
    return ok(
      res,
      {
        record: await createPlatformRecord(
          req.params.module,
          req.body,
          req.auth.sub,
          req.ip,
        ),
      },
      201,
    );
  } catch (error) {
    return next(error);
  }
}
export async function deleteRecord(req, res, next) {
  try {
    await deletePlatformRecord(
      req.params.module,
      req.params.id,
      req.auth.sub,
      req.ip,
    );
    return ok(res, { deleted: true });
  } catch (error) {
    return next(error);
  }
}
export async function restoreRecord(req, res, next) {
  try {
    const record = await restorePlatformRecord(
      req.params.module,
      req.params.id,
      req.auth.sub,
      req.ip,
    );
    return ok(res, { record });
  } catch (error) {
    return next(error);
  }
}
