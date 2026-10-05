import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate, authenticateSuperAdmin } from "../middleware/auth.js";
import { login, logout, me, updateProfile, register, superAdminLogin, superAdminLogout, superAdminMe, verifyEmailAddress } from "../controllers/authController.js";

const router = Router();
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, skipSuccessfulRequests: true });
const superAdminLoginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, skipSuccessfulRequests: true });

router.post("/login", loginLimit, login);
router.post("/superadmin/login", superAdminLoginLimit, superAdminLogin);
router.post("/register", register);
router.get("/verify-email/:token", verifyEmailAddress);
router.post("/logout", logout);
router.get("/me", authenticate, me);
router.put("/profile", authenticate, updateProfile);
router.post("/superadmin/logout", superAdminLogout);
router.get("/superadmin/me", authenticateSuperAdmin, superAdminMe);

export default router;
