import { Router } from "express";
import { authenticate, authenticateSuperAdmin } from "../middleware/auth.js";
import { authorize, requirePermission } from "../middleware/rbac.js";
import { requireTenantContext } from "../middleware/tenant.js";
import {
  createAdminAccount,
  createTeamMemberAccount,
  getAdminAccounts,
  getTeamMembers,
} from "../controllers/accountController.js";
import {
  getAuditLogs,
  getTenantAuditLogsController,
  exportAuditLogsController,
  getCompanyProfileController,
  putCompanyProfileController,
  getTenant,
  getTenants,
  patchTenant,
} from "../controllers/tenantController.js";
import {
  createRecord,
  deleteRecord,
  listRecords,
  restoreRecord,
} from "../controllers/platformController.js";
import {
  getPlans,
  patchPlan,
  postPlan,
} from "../controllers/planController.js";
import { getDashboardMetrics } from "../controllers/dashboardController.js";
import {
  destroyCounsellor,
  getCounsellors,
  patchCounsellor,
  postCounsellor,
  restoreCounsellorController,
} from "../controllers/counsellorController.js";
import {
  destroyChatbot,
  getChatbotBuilderById,
  getChatbotById,
  getChatbotCrawlStatusController,
  getChatbots,
  patchChatbotStatus,
  postChatbot,
  postChatbotBuilderPublish,
  postChatbotDuplicate,
  postCrawlChatbotWebsite,
  putChatbotBuilderDraft,
  restoreChatbotController,
} from "../controllers/chatbotController.js";
import {
  getAdminDashboardController,
  getLeadDetails,
  getLeadKPIs,
  listStudentLeads,
  getLeadManagementMetricsController,
  postAssignLead,
  postAssignBulkLeads,
  patchLeadDetails,
  deleteLeadController,
  getCounsellorDashboardController,
  getInboxConversations,
  getInboxConversationById,
  postConversationFeedbackController,
  getFollowUpsController,
  postFollowUpController,
  patchFollowUpController,
  getCallsController,
  postCallController,
  getCounsellorPerformanceController,
  getCounsellorAvailabilityController,
  patchCounsellorStatusController,
  putCounsellorScheduleController,
  postCounsellorLeaveController,
  deleteCounsellorLeaveController,
} from "../controllers/leadController.js";
import {
  getReportsController,
  postReportActivityController,
} from "../controllers/reportController.js";
import {
  getWhatsAppConfigController,
  saveWhatsAppConfigController,
  disconnectWhatsAppController,
  getWhatsAppLeadsController,
  sendWhatsAppMessageController,
  getWhatsAppBroadcastsController,
} from "../controllers/whatsappController.js";
import {
  getRolesController,
  getRoleByIdController,
  getPermissionsCatalogController,
  getRolePermissionsController,
  createRoleController,
  updateRoleController,
  updateRolePermissionsController,
  deleteRoleController,
  restoreRoleController,
} from "../controllers/roleController.js";
import {
  getNotificationsController,
  getUnreadCountController,
  patchMarkReadController,
  patchMarkAllReadController,
} from "../controllers/notificationController.js";

const router = Router();

router.post(
  "/superadmin/admins",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  createAdminAccount,
);
router.get(
  "/superadmin/admins",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  getAdminAccounts,
);
router.get(
  "/superadmin/tenants",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  getTenants,
);
router.get(
  "/superadmin/tenants/:id",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  getTenant,
);
router.patch(
  "/superadmin/tenants/:id",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  patchTenant,
);
router.get(
  "/superadmin/audit-logs",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  getAuditLogs,
);
router.get(
  "/superadmin/plans",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  getPlans,
);
router.get(
  "/superadmin/dashboard",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  getDashboardMetrics,
);
router.post(
  "/superadmin/plans",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  postPlan,
);
router.patch(
  "/superadmin/plans/:id",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  patchPlan,
);
router.get(
  "/superadmin/modules/:module",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  listRecords,
);
router.post(
  "/superadmin/modules/:module",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  createRecord,
);
router.delete(
  "/superadmin/modules/:module/:id",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  deleteRecord,
);
router.post(
  "/superadmin/modules/:module/:id/restore",
  authenticateSuperAdmin,
  authorize("SUPER_ADMIN"),
  restoreRecord,
);
router.post(
  "/admin/team-members",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  createTeamMemberAccount,
);
router.get(
  "/admin/team-members",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getTeamMembers,
);
router.get(
  "/admin/counsellors/dashboard",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  getCounsellorDashboardController,
);
router.get(
  "/admin/counsellors",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getCounsellors,
);
router.post(
  "/admin/counsellors",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  postCounsellor,
);
router.patch(
  "/admin/counsellors/:id",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  patchCounsellor,
);
router.delete(
  "/admin/counsellors/:id",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  destroyCounsellor,
);
router.post(
  "/admin/counsellors/:id/restore",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  restoreCounsellorController,
);
router.get(
  "/admin/chatbots",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getChatbots,
);
router.post(
  "/admin/chatbots",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  postChatbot,
);
router.get(
  "/admin/chatbots/:id/builder",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getChatbotBuilderById,
);
router.put(
  "/admin/chatbots/:id/builder",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  putChatbotBuilderDraft,
);
router.post(
  "/admin/chatbots/:id/builder/publish",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  postChatbotBuilderPublish,
);
router.get(
  "/admin/chatbots/:id",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getChatbotById,
);
router.patch(
  "/admin/chatbots/:id/status",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  patchChatbotStatus,
);
router.post(
  "/admin/chatbots/:id/duplicate",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  postChatbotDuplicate,
);
router.delete(
  "/admin/chatbots/:id",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  destroyChatbot,
);
router.post(
  "/admin/chatbots/:id/restore",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  restoreChatbotController,
);
router.post(
  "/admin/chatbots/:id/crawl",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  postCrawlChatbotWebsite,
);
router.get(
  "/admin/chatbots/:id/crawl-status",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getChatbotCrawlStatusController,
);
router.get(
  "/admin/dashboard",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getAdminDashboardController,
);
router.get(
  "/admin/counsellor/dashboard",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("dashboard.view"),
  getCounsellorDashboardController,
);
router.get(
  "/admin/leads/kpis",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("dashboard.view", "my_leads.view"),
  getLeadKPIs,
);
router.get(
  "/admin/leads/students",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("my_leads.view"),
  listStudentLeads,
);
router.get(
  "/admin/leads/students/:id",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("my_leads.view"),
  getLeadDetails,
);
router.patch(
  "/admin/leads/students/:id",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("my_leads.update"),
  patchLeadDetails,
);
router.delete(
  "/admin/leads/students/:id",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  deleteLeadController,
);
router.get(
  "/admin/leads/management/metrics",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getLeadManagementMetricsController,
);
router.post(
  "/admin/leads/assign",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  postAssignLead,
);
router.post(
  "/admin/leads/assign/bulk",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  postAssignBulkLeads,
);
router.get(
  "/admin/inbox/conversations",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("inbox.view"),
  getInboxConversations,
);
router.get(
  "/admin/inbox/conversations/:id",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("inbox.view"),
  getInboxConversationById,
);
router.post(
  "/admin/inbox/conversations/:id/feedback",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("inbox.update", "inbox.create"),
  postConversationFeedbackController,
);
router.get(
  "/admin/leads/follow-ups",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("follow_ups.view"),
  getFollowUpsController,
);
router.post(
  "/admin/leads/follow-ups",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("follow_ups.create"),
  postFollowUpController,
);
router.patch(
  "/admin/leads/follow-ups/:id",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("follow_ups.update"),
  patchFollowUpController,
);
router.get(
  "/admin/calls",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("calls.view"),
  getCallsController,
);
router.post(
  "/admin/calls",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("calls.create"),
  postCallController,
);
router.get(
  "/admin/counsellors/performance",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("performance.view"),
  getCounsellorPerformanceController,
);
router.get(
  "/admin/counsellors/:id/performance",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("performance.view"),
  getCounsellorPerformanceController,
);

// Counsellor Availability routes (Hour 4 Part 4)
router.get(
  "/admin/counsellors/availability",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("availability.view"),
  getCounsellorAvailabilityController,
);
router.patch(
  "/admin/counsellors/availability/status",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("availability.update"),
  patchCounsellorStatusController,
);
router.put(
  "/admin/counsellors/availability/schedule",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("availability.update"),
  putCounsellorScheduleController,
);
router.post(
  "/admin/counsellors/availability/leaves",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("availability.create", "availability.update"),
  postCounsellorLeaveController,
);
router.delete(
  "/admin/counsellors/availability/leaves/:leaveId",
  authenticate,
  authorize("ADMIN", "COUNSELLOR"),
  requireTenantContext,
  requirePermission("availability.delete", "availability.update"),
  deleteCounsellorLeaveController,
);

// Reports routes
router.get(
  "/admin/reports",
  authenticate,
  authorize("ADMIN", "HEAD_COUNSELLOR", "COUNSELLOR"),
  requireTenantContext,
  getReportsController,
);

router.post(
  "/admin/reports/activity",
  authenticate,
  authorize("ADMIN", "HEAD_COUNSELLOR", "COUNSELLOR"),
  requireTenantContext,
  postReportActivityController,
);

// WhatsApp Phase 1 routes
router.get(
  "/admin/whatsapp/config",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getWhatsAppConfigController,
);

router.post(
  "/admin/whatsapp/config",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  saveWhatsAppConfigController,
);

router.post(
  "/admin/whatsapp/disconnect",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  disconnectWhatsAppController,
);

router.get(
  "/admin/whatsapp/leads",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getWhatsAppLeadsController,
);

router.post(
  "/admin/whatsapp/send",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  sendWhatsAppMessageController,
);

router.get(
  "/admin/whatsapp/broadcasts",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getWhatsAppBroadcastsController,
);

// Audit Logs API
router.get(
  "/admin/audit-logs",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getTenantAuditLogsController,
);

router.get(
  "/admin/audit-logs/export",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  exportAuditLogsController,
);

// Notifications API
router.get(
  "/admin/notifications",
  authenticate,
  authorize("ADMIN", "HEAD_COUNSELLOR", "COUNSELLOR"),
  requireTenantContext,
  getNotificationsController,
);

router.get(
  "/admin/notifications/unread-count",
  authenticate,
  authorize("ADMIN", "HEAD_COUNSELLOR", "COUNSELLOR"),
  requireTenantContext,
  getUnreadCountController,
);

router.patch(
  "/admin/notifications/:id/read",
  authenticate,
  authorize("ADMIN", "HEAD_COUNSELLOR", "COUNSELLOR"),
  requireTenantContext,
  patchMarkReadController,
);

router.patch(
  "/admin/notifications/read-all",
  authenticate,
  authorize("ADMIN", "HEAD_COUNSELLOR", "COUNSELLOR"),
  requireTenantContext,
  patchMarkAllReadController,
);

// Company Profile API
router.get(
  "/admin/company-profile",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getCompanyProfileController,
);

router.put(
  "/admin/company-profile",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  putCompanyProfileController,
);

// Dynamic Roles & Permissions APIs
router.get(
  "/admin/permissions",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getPermissionsCatalogController,
);

router.get(
  "/admin/roles",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getRolesController,
);

router.get(
  "/admin/roles/:id",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getRoleByIdController,
);

router.post(
  "/admin/roles",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  createRoleController,
);

router.put(
  "/admin/roles/:id",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  updateRoleController,
);

router.delete(
  "/admin/roles/:id",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  deleteRoleController,
);

router.post(
  "/admin/roles/:id/restore",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  restoreRoleController,
);

router.get(
  "/admin/roles/:id/permissions",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  getRolePermissionsController,
);

router.put(
  "/admin/roles/:id/permissions",
  authenticate,
  authorize("ADMIN"),
  requireTenantContext,
  updateRolePermissionsController,
);

export default router;
