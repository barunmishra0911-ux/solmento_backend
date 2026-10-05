import { HttpError, ok } from "../utils/http.js";
import { createAdminSchema, createTeamMemberSchema } from "../validators/auth.js";
import {
  createAdmin,
  createTeamMember,
  listTeamMembers,
  listAdmins,
} from "../services/accountService.js";

export async function createAdminAccount(req, res, next) {
  try {
    const parsed = createAdminSchema.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        422,
        "Please provide a valid company, name, email and password.",
        parsed.error.flatten().fieldErrors,
      );
    return ok(
      res,
      {
        user: await createAdmin({
          ...parsed.data,
          createdByUserId: req.auth.sub,
        }),
      },
      201,
    );
  } catch (error) {
    return next(error);
  }
}

export async function getAdminAccounts(_req, res, next) {
  try {
    return ok(res, { admins: await listAdmins() });
  } catch (error) {
    return next(error);
  }
}

export async function createTeamMemberAccount(req, res, next) {
  try {
    const parsed = createTeamMemberSchema.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        422,
        "Please provide a valid team role, name, email and password.",
        parsed.error.flatten().fieldErrors,
      );
    return ok(
      res,
      {
        user: await createTeamMember({
          ...parsed.data,
          adminUserId: req.auth.sub,
          tenantId: req.auth.tenantId,
        }),
      },
      201,
    );
  } catch (error) {
    return next(error);
  }
}

export async function getTeamMembers(req, res, next) {
  try {
    return ok(res, {
      members: await listTeamMembers(req.auth.sub, req.auth.tenantId),
    });
  } catch (error) {
    return next(error);
  }
}
