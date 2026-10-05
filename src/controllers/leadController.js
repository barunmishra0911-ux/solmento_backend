import { HttpError, ok } from "../utils/http.js";
import { recordAudit } from "../services/auditService.js";
import { createNotification } from "../services/notificationService.js";
import {
  listLeadsQuerySchema,
  assignLeadSchema,
  assignBulkLeadsSchema,
} from "../validators/auth.js";
import {
  getDashboardKPIs,
  listLeads,
  getLeadById,
  getLeadConversation,
  getLeadManagementMetrics,
  assignLead,
  assignBulkLeads,
  extractConversationInsights,
  updateLeadDetails,
  softDeleteLead,
  getCounsellorDashboardData,
  listInboxConversations,
  getInboxConversationDetails,
  saveConversationFeedback,
  listFollowUps,
  createFollowUp,
  updateFollowUp,
  listCalls,
  createCall,
  getCounsellorPerformanceData,
  getCounsellorAvailability,
  updateCounsellorLiveStatus,
  updateCounsellorSchedule,
  addCounsellorLeave,
  deleteCounsellorLeave,
  getAdminDashboardData,
} from "../services/leadService.js";

export async function getAdminDashboardController(req, res, next) {
  try {
    const data = await getAdminDashboardData(req.auth.tenantId, req.query);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function getLeadKPIs(req, res, next) {
  try {
    const queryOptions = { ...req.query };
    if (req.auth.role === "COUNSELLOR") {
      queryOptions.counsellorId = String(req.auth.userId || req.auth.sub);
    }
    return ok(res, await getDashboardKPIs(req.auth.tenantId, queryOptions));
  } catch (error) {
    return next(error);
  }
}

export async function listStudentLeads(req, res, next) {
  try {
    const parsed = listLeadsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Invalid query parameters.",
        parsed.error.flatten().fieldErrors,
      );
    }
    const queryOptions = { ...parsed.data };
    if (req.auth.role === "COUNSELLOR") {
      queryOptions.counsellorId = String(req.auth.userId || req.auth.sub);
    }
    return ok(res, await listLeads(req.auth.tenantId, queryOptions));
  } catch (error) {
    return next(error);
  }
}

export async function getLeadDetails(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) throw new HttpError(400, "Lead id is required.");
    const lead = await getLeadById(req.auth.tenantId, id);
    if (!lead) throw new HttpError(404, "Lead not found.");

    if (req.auth.role === "COUNSELLOR") {
      const assignedId = lead.assignedTo?.id;
      const currentUserId = req.auth.userId || req.auth.sub;
      if (!assignedId || String(assignedId) !== String(currentUserId)) {
        throw new HttpError(
          403,
          "You do not have permission to access this lead.",
        );
      }
    }

    const convo = await getLeadConversation(req.auth.tenantId, id);

    // Derive facts from real conversation messages if not explicitly set in fields_json
    const insights = extractConversationInsights(convo.messages || []);
    const ki = lead.keyInfo || {};

    const hasCourses =
      ki.coursesInterested &&
      (Array.isArray(ki.coursesInterested)
        ? ki.coursesInterested.length > 0
        : String(ki.coursesInterested).trim() !== "" &&
        ki.coursesInterested !== "Not provided");
    if (!hasCourses && insights.courses.length > 0) {
      ki.coursesInterested = insights.courses;
    }

    if (!ki.feesQuery || ki.feesQuery === "Not provided") {
      ki.feesQuery = insights.feesQuery;
    }

    if (!ki.hostelQuery || ki.hostelQuery === "Not provided") {
      ki.hostelQuery = insights.hostelQuery;
    }

    if (!ki.hostelFees || ki.hostelFees === "Not provided") {
      ki.hostelFees = insights.hostelFees;
    }

    if (!ki.preferredIntake || ki.preferredIntake === "Not provided") {
      ki.preferredIntake = insights.preferredIntake;
    }

    if (!ki.location || ki.location === "Not provided") {
      ki.location = insights.location;
    }

    if (!ki.additionalNotes || ki.additionalNotes === "Not provided") {
      ki.additionalNotes = insights.notes;
    }

    lead.keyInfo = ki;

    return ok(res, {
      lead,
      conversation: convo.exists ? convo.conversation : null,
      messages: convo.messages || [],
    });
  } catch (error) {
    return next(error);
  }
}

export async function patchLeadDetails(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) throw new HttpError(400, "Lead id is required.");

    if (req.auth.role === "COUNSELLOR") {
      const lead = await getLeadById(req.auth.tenantId, id);
      if (!lead) throw new HttpError(404, "Lead not found.");
      const assignedId = lead.assignedTo?.id;
      const currentUserId = req.auth.userId || req.auth.sub;
      if (!assignedId || String(assignedId) !== String(currentUserId)) {
        throw new HttpError(
          403,
          "You do not have permission to update this lead.",
        );
      }
    }

    const updatedLead = await updateLeadDetails(
      req.auth.tenantId,
      id,
      req.body || {},
    );
    if (!updatedLead) throw new HttpError(404, "Lead not found.");

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId || req.auth.sub,
      action: "Updated",
      targetType: "Student Lead",
      targetId: id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "My Leads",
        page: "Lead Status",
        details: `Updated lead status to "${req.body?.status || req.body?.pipelineStage || 'Interested'}"`,
        summaryTitle: "Lead Status Updated",
        summarySubtitle: "Lead pipeline stage was updated",
      },
      ipAddress: req.ip,
    });

    return ok(res, {
      success: true,
      lead: updatedLead,
      message: "Lead details updated successfully.",
    });
  } catch (error) {
    return next(error);
  }
}

export async function deleteLeadController(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) throw new HttpError(400, "Lead id is required.");

    const result = await softDeleteLead(
      req.auth.tenantId,
      id,
      req.auth.userId || req.auth.sub,
    );

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId || req.auth.sub,
      action: "Deleted",
      targetType: "Lead",
      targetId: id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Lead",
        page: "Lead Management",
        details: `Soft deleted lead (ID: ${id})`,
        summaryTitle: "Lead Deleted",
        summarySubtitle: "Lead was removed from active lists",
      },
      ipAddress: req.ip,
    });

    return ok(res, {
      success: true,
      lead: result,
      message: "Lead deleted successfully.",
    });
  } catch (error) {
    return next(error);
  }
}

export async function getLeadManagementMetricsController(req, res, next) {
  try {
    return ok(res, await getLeadManagementMetrics(req.auth.tenantId, req.query));
  } catch (error) {
    return next(error);
  }
}

export async function postAssignLead(req, res, next) {
  try {
    const parsed = assignLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Invalid assignment payload.",
        parsed.error.flatten().fieldErrors,
      );
    }
    const result = await assignLead(req.auth.tenantId, parsed.data);

    if (parsed.data.counsellorId) {
      createNotification({
        tenantId: req.auth.tenantId,
        recipientUserId: parsed.data.counsellorId,
        actorUserId: req.auth.userId,
        type: "LEAD_ASSIGNED",
        title: "New Student Lead Assigned",
        message: `Student lead #${parsed.data.leadId} has been assigned to you.`,
        module: "Leads",
        entityType: "lead",
        entityId: parsed.data.leadId,
        priority: "INFO",
      }).catch(() => {});
    }

    return ok(res, result);
  } catch (error) {
    return next(error);
  }
}

export async function postAssignBulkLeads(req, res, next) {
  try {
    const parsed = assignBulkLeadsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Invalid bulk assignment payload.",
        parsed.error.flatten().fieldErrors,
      );
    }
    const result = await assignBulkLeads(req.auth.tenantId, parsed.data);

    if (parsed.data.counsellorId && Array.isArray(parsed.data.leadIds) && parsed.data.leadIds.length > 0) {
      createNotification({
        tenantId: req.auth.tenantId,
        recipientUserId: parsed.data.counsellorId,
        actorUserId: req.auth.userId,
        type: "LEAD_ASSIGNED",
        title: "Bulk Student Leads Assigned",
        message: `${parsed.data.leadIds.length} student leads have been assigned to you.`,
        module: "Leads",
        entityType: "lead",
        entityId: parsed.data.leadIds[0],
        priority: "INFO",
      }).catch(() => {});
    }

    return ok(res, result);
  } catch (error) {
    return next(error);
  }
}

export async function getCounsellorDashboardController(req, res, next) {
  try {
    const counsellorId =
      req.auth.role === "COUNSELLOR"
        ? req.auth.userId
        : req.query.counsellorId
          ? Number(req.query.counsellorId)
          : req.auth.userId;

    const data = await getCounsellorDashboardData(
      req.auth.tenantId,
      counsellorId,
      req.query,
    );
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function getInboxConversations(req, res, next) {
  try {
    const options = { ...req.query };
    if (req.auth.role === "COUNSELLOR") {
      options.counsellorId = String(req.auth.userId || req.auth.sub);
    }
    const data = await listInboxConversations(req.auth.tenantId, options);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function getInboxConversationById(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) throw new HttpError(400, "Conversation ID is required.");
    const options = {};
    if (req.auth.role === "COUNSELLOR") {
      options.counsellorId = String(req.auth.userId || req.auth.sub);
    }
    const data = await getInboxConversationDetails(req.auth.tenantId, id, options);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function postConversationFeedbackController(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) throw new HttpError(400, "Conversation ID is required.");

    const userContext = {
      userId: req.auth.userId || req.auth.sub,
      role: req.auth.role,
      name: req.auth.name,
    };

    const result = await saveConversationFeedback(
      req.auth.tenantId,
      id,
      req.body || {},
      userContext,
    );

    return ok(res, result, 201);
  } catch (error) {
    return next(error);
  }
}

export async function getFollowUpsController(req, res, next) {
  try {
    const options = { ...req.query };
    if (req.auth.role === "COUNSELLOR") {
      options.counsellorId = String(req.auth.userId || req.auth.sub);
    }
    const data = await listFollowUps(req.auth.tenantId, options);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function postFollowUpController(req, res, next) {
  try {
    const data = await createFollowUp(req.auth.tenantId, req.body || {}, req.auth);

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId || req.auth.sub,
      action: "Created",
      targetType: "Follow Ups",
      targetId: data?.id || "FUP",
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Follow Ups",
        page: "New Follow Up",
        details: `Created new follow-up (ID: FUP-${data?.id || "221"})`,
        summaryTitle: "Follow Up Created",
        summarySubtitle: "Follow up task was scheduled",
      },
      ipAddress: req.ip,
    });

    return ok(res, data, 201);
  } catch (error) {
    return next(error);
  }
}

export async function patchFollowUpController(req, res, next) {
  try {
    const { id } = req.params;
    const data = await updateFollowUp(req.auth.tenantId, id, req.body || {}, req.auth);

    await recordAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId || req.auth.sub,
      action: "Updated",
      targetType: "Follow Ups",
      targetId: id,
      metadata: {
        userName: req.auth.email,
        userRole: req.auth.role === "ADMIN" ? "Admin" : "Counsellor",
        module: "Follow Ups",
        page: "Follow Up List",
        details: `Updated follow-up status (ID: FUP-${id})`,
        summaryTitle: "Follow Up Updated",
        summarySubtitle: "Follow up status was modified",
      },
      ipAddress: req.ip,
    });

    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function getCallsController(req, res, next) {
  try {
    const options = { ...req.query };
    if (req.auth.role === "COUNSELLOR") {
      options.counsellorId = String(req.auth.userId || req.auth.sub);
    }
    const data = await listCalls(req.auth.tenantId, options);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function postCallController(req, res, next) {
  try {
    const data = await createCall(req.auth.tenantId, req.body || {}, req.auth);
    return ok(res, data, 201);
  } catch (error) {
    return next(error);
  }
}

export async function getCounsellorPerformanceController(req, res, next) {
  try {
    const counsellorId =
      req.auth.role === "COUNSELLOR"
        ? req.auth.userId
        : req.query.counsellorId
          ? Number(req.query.counsellorId)
          : req.auth.userId;

    const data = await getCounsellorPerformanceData(
      req.auth.tenantId,
      counsellorId,
      req.query,
    );
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function getCounsellorAvailabilityController(req, res, next) {
  try {
    const counsellorId =
      req.auth.role === "COUNSELLOR"
        ? req.auth.userId
        : req.query.counsellorId
          ? Number(req.query.counsellorId)
          : req.auth.userId;

    const data = await getCounsellorAvailability(req.auth.tenantId, counsellorId);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function patchCounsellorStatusController(req, res, next) {
  try {
    const counsellorId =
      req.auth.role === "COUNSELLOR"
        ? req.auth.userId
        : req.query.counsellorId
          ? Number(req.query.counsellorId)
          : req.auth.userId;

    const { status } = req.body || {};
    const data = await updateCounsellorLiveStatus(req.auth.tenantId, counsellorId, status);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function putCounsellorScheduleController(req, res, next) {
  try {
    const counsellorId =
      req.auth.role === "COUNSELLOR"
        ? req.auth.userId
        : req.query.counsellorId
          ? Number(req.query.counsellorId)
          : req.auth.userId;

    const { schedule } = req.body || {};
    const data = await updateCounsellorSchedule(req.auth.tenantId, counsellorId, schedule);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function postCounsellorLeaveController(req, res, next) {
  try {
    const counsellorId =
      req.auth.role === "COUNSELLOR"
        ? req.auth.userId
        : req.query.counsellorId
          ? Number(req.query.counsellorId)
          : req.auth.userId;

    const data = await addCounsellorLeave(req.auth.tenantId, counsellorId, req.body || {});
    return ok(res, data, 201);
  } catch (error) {
    return next(error);
  }
}

export async function deleteCounsellorLeaveController(req, res, next) {
  try {
    const counsellorId =
      req.auth.role === "COUNSELLOR"
        ? req.auth.userId
        : req.query.counsellorId
          ? Number(req.query.counsellorId)
          : req.auth.userId;

    const { leaveId } = req.params;
    const data = await deleteCounsellorLeave(req.auth.tenantId, counsellorId, leaveId);
    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}
