import { env } from "../config/env.js";
import {
  authenticateSuperAdminUser,
  authenticateUser,
  findSuperAdminById,
  findUserById,
  updateUserProfile,
} from "../services/authService.js";
import {
  registerCompany,
  verifyEmail,
} from "../services/registrationService.js";
import { recordAudit } from "../services/auditService.js";
import { signAccessToken, signSuperAdminToken } from "../middleware/auth.js";
import { HttpError, ok } from "../utils/http.js";
import {
  loginSchema,
  registerSchema,
  verificationTokenSchema,
} from "../validators/auth.js";

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: env.COOKIE_SECURE,
  path: "/",
};

const superAdminCookieOptions = { ...cookieOptions };
const AUTH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function login(req, res, next) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        422,
        "Please enter a valid email and password.",
        parsed.error.flatten().fieldErrors,
      );
    const user = await authenticateUser(
      parsed.data.email,
      parsed.data.password,
    );
    if (user.role === "SUPER_ADMIN")
      throw new HttpError(403, "Use the Super Admin sign-in page.");
    const token = signAccessToken(user);
    res.cookie("access_token", token, {
      ...cookieOptions,
      maxAge: parsed.data.rememberMe ? AUTH_COOKIE_MAX_AGE_MS : undefined,
    });

    await recordAudit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "Logged In",
      targetType: "Authentication",
      targetId: user.id,
      metadata: {
        userName: user.name,
        userEmail: user.email,
        userRole: user.role === "ADMIN" ? "Admin" : user.role === "COUNSELLOR" ? "Counsellor" : user.role,
        module: "Authentication",
        page: "Login",
        details: "User logged in to the system",
        summaryTitle: "User Login",
        summarySubtitle: "User authenticated successfully",
      },
      ipAddress: req.ip,
    });

    return ok(res, { user, token });
  } catch (error) {
    return next(error);
  }
}

export async function superAdminLogin(req, res, next) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        422,
        "Please enter a valid email and password.",
        parsed.error.flatten().fieldErrors,
      );
    const user = await authenticateSuperAdminUser(
      parsed.data.email,
      parsed.data.password,
    );
    res.cookie("super_admin_access_token", signSuperAdminToken(user), {
      ...superAdminCookieOptions,
      maxAge: parsed.data.rememberMe ? AUTH_COOKIE_MAX_AGE_MS : undefined,
    });
    return ok(res, { user });
  } catch (error) {
    return next(error);
  }
}

export async function register(req, res, next) {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        422,
        "Please complete all registration fields correctly.",
        parsed.error.flatten().fieldErrors,
      );
    const result = await registerCompany(parsed.data);
    return ok(
      res,
      {
        user: result.user,
        requiresEmailVerification: true,
        ...(result.verificationToken
          ? { verificationToken: result.verificationToken }
          : {}),
      },
      201,
    );
  } catch (error) {
    return next(error);
  }
}

export async function verifyEmailAddress(req, res, next) {
  try {
    const parsed = verificationTokenSchema.safeParse(req.params);
    if (!parsed.success)
      throw new HttpError(400, "A valid verification token is required.");
    return ok(res, await verifyEmail(parsed.data.token));
  } catch (error) {
    return next(error);
  }
}

export async function me(req, res, next) {
  try {
    return ok(res, { user: await findUserById(req.auth.sub) });
  } catch (error) {
    return next(error);
  }
}

export async function updateProfile(req, res, next) {
  try {
    const userId = req.auth?.sub;
    if (!userId) throw new HttpError(401, "Authentication required.");
    const user = await updateUserProfile(userId, req.body || {});

    await recordAudit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "Updated Profile",
      targetType: "User",
      targetId: user.id,
      metadata: {
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
        module: "Account",
        page: "Profile",
        details: "User updated their profile information",
        summaryTitle: "Profile Updated",
        summarySubtitle: `${user.name} updated personal information`,
      },
      ipAddress: req.ip,
    }).catch(() => undefined);

    return ok(res, { user, message: "Profile updated successfully." });
  } catch (error) {
    return next(error);
  }
}

export async function superAdminMe(req, res, next) {
  try {
    return ok(res, { user: await findSuperAdminById(req.auth.sub) });
  } catch (error) {
    return next(error);
  }
}

export function logout(_req, res) {
  res.clearCookie("access_token", cookieOptions);
  return ok(res, { loggedOut: true });
}

export function superAdminLogout(_req, res) {
  res.clearCookie("super_admin_access_token", superAdminCookieOptions);
  return ok(res, { loggedOut: true });
}
