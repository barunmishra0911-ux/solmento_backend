import { ok } from "../utils/http.js";
import {
  getUnreadNotificationCount,
  listUserNotifications,
  markAllAsRead,
  markAsRead,
} from "../services/notificationService.js";

export async function getNotificationsController(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const userId = req.auth.userId;
    const { page, limit, unreadOnly } = req.query;

    const data = await listUserNotifications({
      tenantId,
      userId,
      page,
      limit,
      unreadOnly: unreadOnly === "true" || unreadOnly === "1",
    });

    return ok(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function getUnreadCountController(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const userId = req.auth.userId;

    const unreadCount = await getUnreadNotificationCount({ tenantId, userId });
    return ok(res, { unreadCount });
  } catch (error) {
    return next(error);
  }
}

export async function patchMarkReadController(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const userId = req.auth.userId;
    const notificationId = req.params.id;

    const notification = await markAsRead({
      tenantId,
      userId,
      notificationId,
    });

    return ok(res, { notification });
  } catch (error) {
    return next(error);
  }
}

export async function patchMarkAllReadController(req, res, next) {
  try {
    const tenantId = req.auth.tenantId;
    const userId = req.auth.userId;

    await markAllAsRead({ tenantId, userId });
    return ok(res, { message: "All notifications marked as read." });
  } catch (error) {
    return next(error);
  }
}
