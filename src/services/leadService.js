import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";
import { createNotification, createNotificationIfNotExistsRecent } from "./notificationService.js";

function parseJsonSafe(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractFields(fieldsJson, chatbotConfigJson) {
  const parsed = parseJsonSafe(fieldsJson, {});
  const cfg = parseJsonSafe(chatbotConfigJson, {});
  const fieldDefs = Array.isArray(cfg?.leadCapture?.fields)
    ? cfg.leadCapture.fields
    : [];

  const idToFieldDef = {};
  for (const def of fieldDefs) {
    if (def && def.id) {
      idToFieldDef[def.id] = {
        label: String(def.label || "").toLowerCase().trim(),
        type: String(def.type || "").toLowerCase().trim(),
      };
    }
  }

  let name = parsed.name || parsed.fullName || parsed.student_name || "";
  let email = parsed.email || parsed.emailAddress || "";
  let phone = parsed.phone || parsed.phoneNumber || parsed.mobile || "";
  let coursesInterested =
    parsed.courses_interested ||
    parsed.coursesInterested ||
    parsed.course ||
    parsed.program ||
    [];
  let feesQuery = parsed.fees_query || parsed.feesQuery || parsed.fees || "";
  let hostelQuery = parsed.hostel_query || parsed.hostelQuery || "";
  let hostelFees = parsed.hostel_fees || parsed.hostelFees || "";
  let preferredIntake =
    parsed.preferred_intake || parsed.preferredIntake || parsed.intake || "";
  let location = parsed.location || parsed.city || "";
  let additionalNotes =
    parsed.notes ||
    parsed.additional_notes ||
    parsed.additionalNotes ||
    parsed.remarks ||
    "";

  // Dynamic field IDs mapping based on chatbot leadCapture field definitions
  for (const [key, val] of Object.entries(parsed)) {
    if (val === null || val === undefined || val === "") continue;
    const def = idToFieldDef[key];
    const label = def?.label || String(key).toLowerCase().trim();
    const type = def?.type || "";

    const isName =
      !name &&
      ((label.includes("name") &&
        !label.includes("course") &&
        !label.includes("program")) ||
        type === "name" ||
        type === "fullname" ||
        type === "student name");

    const isEmail =
      !email && (label.includes("email") || type === "email");

    const isPhone =
      !phone &&
      (label.includes("phone") ||
        label.includes("mobile") ||
        label.includes("contact") ||
        label.includes("whatsapp") ||
        type === "phone" ||
        type === "mobile");

    const isCourse =
      (!coursesInterested ||
        (Array.isArray(coursesInterested) && coursesInterested.length === 0)) &&
      (label.includes("course") ||
        label.includes("program") ||
        label.includes("branch") ||
        label.includes("degree") ||
        label.includes("stream") ||
        type.includes("course") ||
        type.includes("program"));

    const isFeesQuery =
      !feesQuery &&
      (label.includes("fees query") ||
        (label.includes("fee") && label.includes("query")));

    const isHostelFees =
      !hostelFees &&
      (label.includes("hostel fee") || label.includes("hostel fees"));

    const isHostelQuery =
      !hostelQuery &&
      (label.includes("hostel query") ||
        (label.includes("hostel") && !label.includes("fee")));

    const isPreferredIntake =
      !preferredIntake &&
      (label.includes("intake") ||
        label.includes("preferred intake") ||
        label.includes("session") ||
        label.includes("batch"));

    const isLocation =
      !location &&
      (label.includes("location") ||
        label.includes("city") ||
        label.includes("state") ||
        (label.includes("address") && !label.includes("email")) ||
        label.includes("country")) &&
      !String(val).includes("@");

    const isNotes =
      !additionalNotes &&
      (label.includes("note") ||
        label.includes("remark") ||
        label.includes("comment") ||
        label.includes("message"));

    if (isName) {
      name = String(val);
    } else if (isEmail) {
      email = String(val);
    } else if (isPhone) {
      phone = String(val);
    } else if (isCourse) {
      coursesInterested = Array.isArray(val) ? val : [String(val)];
    } else if (isFeesQuery) {
      feesQuery = String(val);
    } else if (isHostelFees) {
      hostelFees = String(val);
    } else if (isHostelQuery) {
      hostelQuery = String(val);
    } else if (isPreferredIntake) {
      preferredIntake = String(val);
    } else if (isLocation) {
      location = String(val);
    } else if (isNotes) {
      additionalNotes = String(val);
    }
  }

  // Defensive regex/heuristic fallbacks for unmapped dynamic field IDs
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== "string" || !val.trim()) continue;
    const str = val.trim();
    if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
      email = str;
    } else if (!phone && /^[+]?[0-9\s\-()]{7,16}$/.test(str)) {
      phone = str;
    }
  }

  if (!name) {
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "string" && val.trim()) {
        const str = val.trim();
        if (
          str !== email &&
          str !== phone &&
          !str.startsWith("http") &&
          str.length >= 2 &&
          str.length <= 60
        ) {
          name = str;
          break;
        }
      }
    }
  }

  return {
    name: name || "",
    email: email || "",
    phone: phone || "",
    coursesInterested: Array.isArray(coursesInterested)
      ? coursesInterested
      : coursesInterested
      ? [String(coursesInterested)]
      : [],
    feesQuery: feesQuery || "",
    hostelQuery: hostelQuery || "",
    hostelFees: hostelFees || "",
    preferredIntake: preferredIntake || "",
    location: location || "",
    additionalNotes: additionalNotes || "",
    raw: parsed,
  };
}

export async function getDashboardKPIs(tenantId, options = {}) {
  const {
    startDate = "",
    endDate = "",
    fromDate = startDate,
    toDate = endDate,
    counsellorId,
  } = options;

  const baseConditions = ["tenant_id = ?", "deleted_at IS NULL"];
  const baseParams = [tenantId];
  if (counsellorId && counsellorId !== "all") {
    baseConditions.push("assigned_to_user_id = ?");
    baseParams.push(Number(counsellorId));
  }
  const baseWhere = baseConditions.join(" AND ");

  // Safe percentage helper - NEVER returns NaN or Infinity
  function computeDelta(current, previous) {
    const curr = Number(current) || 0;
    const prev = Number(previous) || 0;
    if (prev === 0) {
      return {
        value: curr === 0 ? 0 : 100,
        sign: curr >= 0 ? "up" : "down",
        prefix: curr >= 0 ? "+" : "-",
      };
    }
    const diff = curr - prev;
    const pct = Math.round((diff / prev) * 100);
    return {
      value: Math.abs(pct),
      sign: diff >= 0 ? "up" : "down",
      prefix: diff >= 0 ? "+" : "-",
    };
  }

  const now = new Date();
  const formatYmd = (d) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const todayStr = formatYmd(now);

  const isTodayInRange =
    (!fromDate || fromDate <= todayStr) &&
    (!toDate || toDate >= todayStr);

  // 1. Total Leads in selected range (or all-time if no date range)
  let totalLeads = 0;
  let prevTotalLeads = 0;
  let hasPrevTotal = false;

  if (fromDate && toDate) {
    const [[totRow]] = await pool.execute(
      `SELECT COUNT(*) AS totalLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) >= ? AND DATE(created_at) <= ?`,
      [...baseParams, fromDate, toDate],
    );
    totalLeads = Number(totRow?.totalLeads || 0);

    const dFrom = new Date(fromDate);
    const dTo = new Date(toDate);
    const diffDays = Math.max(1, Math.round((dTo.getTime() - dFrom.getTime()) / (24 * 60 * 60 * 1000)) + 1);
    const prevTo = new Date(dFrom);
    prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo);
    prevFrom.setDate(prevFrom.getDate() - diffDays + 1);
    const prevFromStr = formatYmd(prevFrom);
    const prevToStr = formatYmd(prevTo);

    const [[prevRow]] = await pool.execute(
      `SELECT COUNT(*) AS prevTotalLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) >= ? AND DATE(created_at) <= ?`,
      [...baseParams, prevFromStr, prevToStr],
    );
    prevTotalLeads = Number(prevRow?.prevTotalLeads || 0);
    hasPrevTotal = true;
  } else {
    const [[totRow]] = await pool.execute(
      `SELECT COUNT(*) AS totalLeads FROM leads WHERE ${baseWhere}`,
      [...baseParams],
    );
    totalLeads = Number(totRow?.totalLeads || 0);
  }

  // 2. Today's Leads & Yesterday's Leads
  let todaysLeads = 0;
  let yesterdaysLeads = 0;
  if (isTodayInRange) {
    const [[todayRow]] = await pool.execute(
      `SELECT COUNT(*) AS todaysLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) = CURDATE()`,
      [...baseParams],
    );
    todaysLeads = Number(todayRow?.todaysLeads || 0);

    const [[yestRow]] = await pool.execute(
      `SELECT COUNT(*) AS yesterdaysLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
      [...baseParams],
    );
    yesterdaysLeads = Number(yestRow?.yesterdaysLeads || 0);
  }

  // 3. Weekly Leads & Last Week's Leads
  const curWeekStart = new Date(now);
  curWeekStart.setDate(curWeekStart.getDate() - 6);
  const curWeekStartStr = formatYmd(curWeekStart);
  const isWeekInRange =
    (!fromDate || fromDate <= todayStr) &&
    (!toDate || toDate >= curWeekStartStr);

  let weeklyLeads = 0;
  let lastWeeksLeads = 0;
  if (isWeekInRange) {
    const [[weekRow]] = await pool.execute(
      `SELECT COUNT(*) AS weeklyLeads FROM leads WHERE ${baseWhere} AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`,
      [...baseParams],
    );
    weeklyLeads = Number(weekRow?.weeklyLeads || 0);

    const [[lastWeekRow]] = await pool.execute(
      `SELECT COUNT(*) AS lastWeeksLeads FROM leads WHERE ${baseWhere} AND created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) AND created_at < DATE_SUB(CURDATE(), INTERVAL 6 DAY)`,
      [...baseParams],
    );
    lastWeeksLeads = Number(lastWeekRow?.lastWeeksLeads || 0);
  }

  // 4. Monthly Leads & Last Month's Leads
  let monthlyLeads = 0;
  let lastMonthsLeads = 0;

  if (fromDate && toDate) {
    const dFrom = new Date(fromDate);
    const dTo = new Date(toDate);
    const diffDays = Math.max(1, Math.round((dTo.getTime() - dFrom.getTime()) / (24 * 60 * 60 * 1000)) + 1);

    if (diffDays >= 25) {
      monthlyLeads = totalLeads;
      const prevMonthEnd = new Date(dFrom.getFullYear(), dFrom.getMonth(), 0);
      const prevMonthStart = new Date(prevMonthEnd.getFullYear(), prevMonthEnd.getMonth(), 1);
      const [[prevMonRow]] = await pool.execute(
        `SELECT COUNT(*) AS prevMonLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) >= ? AND DATE(created_at) <= ?`,
        [...baseParams, formatYmd(prevMonthStart), formatYmd(prevMonthEnd)],
      );
      lastMonthsLeads = Number(prevMonRow?.prevMonLeads || 0);
    } else {
      const [[monRow]] = await pool.execute(
        `SELECT COUNT(*) AS monLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND DATE(created_at) <= CURDATE()`,
        [...baseParams],
      );
      monthlyLeads = Number(monRow?.monLeads || 0);

      const [[prevMonRow]] = await pool.execute(
        `SELECT COUNT(*) AS prevMonLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH) AND DATE(created_at) < DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
        [...baseParams],
      );
      lastMonthsLeads = Number(prevMonRow?.prevMonLeads || 0);
    }
  } else {
    const [[monRow]] = await pool.execute(
      `SELECT COUNT(*) AS monLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND DATE(created_at) <= CURDATE()`,
      [...baseParams],
    );
    monthlyLeads = Number(monRow?.monLeads || 0);

    const [[prevMonRow]] = await pool.execute(
      `SELECT COUNT(*) AS prevMonLeads FROM leads WHERE ${baseWhere} AND DATE(created_at) >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH) AND DATE(created_at) < DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
      [...baseParams],
    );
    lastMonthsLeads = Number(prevMonRow?.prevMonLeads || 0);
  }

  // 5. Sparklines from real database data
  const sparkEnd = isTodayInRange ? todayStr : (toDate || todayStr);
  const sparkEndDate = new Date(sparkEnd);
  const sparkStartDate = new Date(sparkEndDate);
  sparkStartDate.setDate(sparkStartDate.getDate() - 6);
  const sparkStart = formatYmd(sparkStartDate);

  const [dailyRows] = await pool.execute(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day_date, COUNT(*) AS count 
     FROM leads 
     WHERE ${baseWhere} AND DATE(created_at) >= ? AND DATE(created_at) <= ?
     GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')`,
    [...baseParams, sparkStart, sparkEnd],
  );

  const dailyCounts = {};
  for (const r of dailyRows) {
    dailyCounts[r.day_date] = Number(r.count || 0);
  }

  const last7DaysSparkline = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(sparkEndDate);
    d.setDate(d.getDate() - i);
    const dStr = formatYmd(d);
    if ((!fromDate || dStr >= fromDate) && (!toDate || dStr <= toDate)) {
      last7DaysSparkline.push(dailyCounts[dStr] || 0);
    } else {
      last7DaysSparkline.push(0);
    }
  }

  const rangeStart = fromDate || sparkStart;
  const rangeEnd = toDate || sparkEnd;
  const [periodRows] = await pool.execute(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day_date, COUNT(*) AS count 
     FROM leads 
     WHERE ${baseWhere} AND DATE(created_at) >= ? AND DATE(created_at) <= ?
     GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')`,
    [...baseParams, rangeStart, rangeEnd],
  );

  const periodCounts = {};
  for (const r of periodRows) {
    periodCounts[r.day_date] = Number(r.count || 0);
  }

  const startD = new Date(rangeStart);
  const endD = new Date(rangeEnd);
  const totalDays = Math.max(1, Math.round((endD.getTime() - startD.getTime()) / (24 * 60 * 60 * 1000)) + 1);
  const bucketSize = Math.max(1, totalDays / 7);

  const monthlySparkline = [];
  const totalSparkline = [];
  let runningTotal = 0;

  for (let b = 0; b < 7; b++) {
    const bStartDay = Math.floor(b * bucketSize);
    const bEndDay = Math.min(totalDays - 1, Math.floor((b + 1) * bucketSize) - 1);
    let bCount = 0;
    for (let dayOffset = bStartDay; dayOffset <= bEndDay; dayOffset++) {
      const d = new Date(startD);
      d.setDate(d.getDate() + dayOffset);
      const dStr = formatYmd(d);
      bCount += periodCounts[dStr] || 0;
    }
    monthlySparkline.push(bCount);
    runningTotal += bCount;
    totalSparkline.push(runningTotal);
  }

  const todayChange = computeDelta(todaysLeads, yesterdaysLeads);
  const weekChange = computeDelta(weeklyLeads, lastWeeksLeads);
  const monthChange = computeDelta(monthlyLeads, lastMonthsLeads);
  const totalChange = hasPrevTotal ? computeDelta(totalLeads, prevTotalLeads) : null;

  return {
    leads: {
      total: Number(totalLeads),
      today: Number(todaysLeads),
      week: Number(weeklyLeads),
      month: Number(monthlyLeads),
    },
    deltas: {
      today: {
        ...todayChange,
        previous: Number(yesterdaysLeads),
        comparison: `vs. yesterday (${yesterdaysLeads})`,
      },
      week: {
        ...weekChange,
        previous: Number(lastWeeksLeads),
        comparison: `vs. previous week (${lastWeeksLeads})`,
      },
      month: {
        ...monthChange,
        previous: Number(lastMonthsLeads),
        comparison: `vs. previous month (${lastMonthsLeads})`,
      },
      total: totalChange
        ? {
            ...totalChange,
            previous: Number(prevTotalLeads),
            comparison: `vs. previous period (${prevTotalLeads})`,
          }
        : {
            value: null,
            sign: "up",
            prefix: "",
            previous: null,
            comparison: "All time leads",
          },
    },
    sparklines: {
      today: last7DaysSparkline,
      week: last7DaysSparkline,
      month: monthlySparkline,
      total: totalSparkline,
    },
  };
}

let hasAssignedColumnCache = null;
async function checkHasAssignedColumn() {
  if (hasAssignedColumnCache !== null) return hasAssignedColumnCache;
  try {
    const [cols] = await pool.query(
      "SHOW COLUMNS FROM leads LIKE 'assigned_to_user_id'",
    );
    hasAssignedColumnCache = cols.length > 0;
  } catch {
    hasAssignedColumnCache = false;
  }
  return hasAssignedColumnCache;
}

export async function listLeads(tenantId, options = {}) {
  const {
    search = "",
    status = "",
    source = "",
    fromDate = "",
    toDate = "",
    period = "all",
    page = 1,
    limit = 20,
    sortBy = "created_at",
    sortOrder = "DESC",
  } = options;

  const where = ["leads.tenant_id = ?", "leads.deleted_at IS NULL"];
  const params = [tenantId];

  if (options.counsellorId && options.counsellorId !== "all") {
    if (options.counsellorId === "unassigned") {
      where.push("(leads.assigned_to_user_id IS NULL OR leads.assigned_to_user_id = 0)");
    } else {
      where.push("leads.assigned_to_user_id = ?");
      params.push(options.counsellorId);
    }
  }

  if (period === "today") {
    where.push("DATE(leads.created_at) = CURDATE()");
  } else if (period === "week") {
    where.push("YEARWEEK(leads.created_at, 1) = YEARWEEK(CURDATE(), 1)");
  } else if (period === "month") {
    where.push(
      "MONTH(leads.created_at) = MONTH(CURDATE()) AND YEAR(leads.created_at) = YEAR(CURDATE())",
    );
  }

  if (status && status !== "all") {
    where.push("leads.status = ?");
    params.push(status);
  }
  if (source && source !== "all") {
    where.push("leads.source = ?");
    params.push(source);
  }
  const effectiveFrom = fromDate || options.startDate || "";
  const effectiveTo = toDate || options.endDate || "";
  if (effectiveFrom) {
    where.push("DATE(leads.created_at) >= ?");
    params.push(effectiveFrom);
  }
  if (effectiveTo) {
    where.push("DATE(leads.created_at) <= ?");
    params.push(effectiveTo);
  }
  if (search && search.trim()) {
    const term = `%${search.trim().toLowerCase()}%`;
    where.push(
      "(LOWER(leads.public_id) LIKE ? OR " +
        "LOWER(JSON_UNQUOTE(JSON_EXTRACT(leads.fields_json, '$.name'))) LIKE ? OR " +
        "LOWER(JSON_UNQUOTE(JSON_EXTRACT(leads.fields_json, '$.email'))) LIKE ? OR " +
        "LOWER(JSON_UNQUOTE(JSON_EXTRACT(leads.fields_json, '$.phone'))) LIKE ? OR " +
        "LOWER(JSON_UNQUOTE(JSON_EXTRACT(leads.fields_json, '$.courses_interested'))) LIKE ? OR " +
        "LOWER(CAST(leads.fields_json AS CHAR)) LIKE ?)",
    );
    params.push(term, term, term, term, term, term);
  }

  const allowedSort = ["created_at", "updated_at", "status", "source"];
  const finalSortBy = allowedSort.includes(sortBy) ? sortBy : "created_at";
  const finalSortOrder =
    sortOrder && String(sortOrder).toUpperCase() === "ASC" ? "ASC" : "DESC";

  const whereClause = where.join(" AND ");

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM leads WHERE ${whereClause}`,
    params,
  );

  const offset = (Number(page) - 1) * Number(limit);
  const hasAssigned = await checkHasAssignedColumn();
  const selectCols = hasAssigned
    ? `leads.id, leads.public_id, leads.status, leads.source, leads.created_at, leads.updated_at, leads.fields_json, leads.assigned_to_user_id,
       users.name AS counsellor_name, users.email AS counsellor_email, users.designation AS counsellor_designation, users.profile_photo AS counsellor_profile_photo,
       chatbots.name AS chatbot_name, chatbots.config_json AS chatbot_config_json`
    : `leads.id, leads.public_id, leads.status, leads.source, leads.created_at, leads.updated_at, leads.fields_json,
       NULL AS assigned_to_user_id, NULL AS counsellor_name, NULL AS counsellor_email, NULL AS counsellor_designation, NULL AS counsellor_profile_photo,
       chatbots.name AS chatbot_name, chatbots.config_json AS chatbot_config_json`;
  const joinUser = hasAssigned
    ? `LEFT JOIN users ON users.id = leads.assigned_to_user_id`
    : ``;

  const [rows] = await pool.execute(
    `SELECT ${selectCols}
     FROM leads
     ${joinUser}
     LEFT JOIN chatbots ON chatbots.id = leads.chatbot_id
     WHERE ${whereClause}
     ORDER BY leads.${finalSortBy} ${finalSortOrder}
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)],
  );

  const records = rows.map((row) => {
    const fields = extractFields(row.fields_json, row.chatbot_config_json);
    return {
      id: row.public_id,
      databaseId: row.id,
      name: fields.name || `Lead ${String(row.public_id).slice(0, 6)}`,
      email: fields.email,
      phone: fields.phone,
      status: String(row.status || "NEW").toUpperCase(),
      source: row.source || "unknown",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      coursesInterested: fields.coursesInterested,
      assignedTo: row.assigned_to_user_id
        ? {
            id: row.assigned_to_user_id,
            name: row.counsellor_name || "",
            email: row.counsellor_email || "",
            designation: row.counsellor_designation || "",
            profilePhoto: row.counsellor_profile_photo || "",
          }
        : {
            id: null,
            name: "Unassigned",
            email: "",
            designation: "",
            profilePhoto: "",
          },
      chatbotName: row.chatbot_name || "",
      _fields: fields.raw,
    };
  });

  return {
    records,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: Number(total),
      totalPages: Math.ceil(Number(total) / Number(limit)),
    },
  };
}

export async function getLeadById(tenantId, leadPublicId) {
  const hasAssigned = await checkHasAssignedColumn();
  const selectCols = hasAssigned
    ? `leads.id, leads.public_id, leads.tenant_id, leads.chatbot_id, leads.chatbot_public_id, leads.visitor_id,
       leads.status, leads.source, leads.created_at, leads.updated_at, leads.fields_json, leads.assigned_to_user_id,
       users.name AS counsellor_name, users.email AS counsellor_email, users.designation AS counsellor_designation,
       users.phone AS counsellor_phone, users.profile_photo AS counsellor_profile_photo,
       chatbots.name AS chatbot_name, chatbots.config_json AS chatbot_config_json`
    : `leads.id, leads.public_id, leads.tenant_id, leads.chatbot_id, leads.chatbot_public_id, leads.visitor_id,
       leads.status, leads.source, leads.created_at, leads.updated_at, leads.fields_json,
       NULL AS assigned_to_user_id, NULL AS counsellor_name, NULL AS counsellor_email, NULL AS counsellor_designation,
       NULL AS counsellor_phone, NULL AS counsellor_profile_photo,
       chatbots.name AS chatbot_name, chatbots.config_json AS chatbot_config_json`;
  const joinUser = hasAssigned
    ? `LEFT JOIN users ON users.id = leads.assigned_to_user_id`
    : ``;

  const [rows] = await pool.execute(
    `SELECT ${selectCols}
     FROM leads
     ${joinUser}
     LEFT JOIN chatbots ON chatbots.id = leads.chatbot_id
     WHERE leads.tenant_id = ? AND (leads.public_id = ? OR CAST(leads.id AS CHAR) = ? OR CONCAT('lead-', leads.id) = ?) AND leads.deleted_at IS NULL LIMIT 1`,
    [tenantId, leadPublicId, leadPublicId, leadPublicId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const fields = extractFields(row.fields_json, row.chatbot_config_json);
  return {
    id: row.public_id,
    databaseId: row.id,
    name: fields.name || `Lead ${String(row.public_id).slice(0, 6)}`,
    email: fields.email,
    phone: fields.phone,
    tenantId: row.tenant_id,
    chatbotId: row.chatbot_id,
    chatbotPublicId: row.chatbot_public_id,
    visitorId: row.visitor_id,
    status: String(row.status || "NEW").toUpperCase(),
    source: row.source || "unknown",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignedTo: row.assigned_to_user_id
      ? {
          id: row.assigned_to_user_id,
          name: row.counsellor_name || "",
          email: row.counsellor_email || "",
          phone: row.counsellor_phone || "",
          designation: row.counsellor_designation || "",
          profilePhoto: row.counsellor_profile_photo || "",
        }
      : {
          id: null,
          name: "Unassigned",
          email: "",
          phone: "",
          designation: "",
          profilePhoto: "",
        },
    chatbotName: row.chatbot_name || "",
    keyInfo: {
      name: fields.name,
      email: fields.email,
      phone: fields.phone,
      coursesInterested: fields.coursesInterested,
      feesQuery: fields.feesQuery,
      hostelQuery: fields.hostelQuery,
      hostelFees: fields.hostelFees,
      preferredIntake: fields.preferredIntake,
      location: fields.location,
      additionalNotes: fields.additionalNotes,
    },
    _rawFields: fields.raw,
  };
}

export async function getLeadConversation(tenantId, leadPublicId) {
  const [leadRows] = await pool.execute(
    "SELECT id, chatbot_id, visitor_id, tenant_id FROM leads WHERE tenant_id = ? AND (public_id = ? OR CAST(id AS CHAR) = ? OR CONCAT('lead-', id) = ?) LIMIT 1",
    [tenantId, leadPublicId, leadPublicId, leadPublicId],
  );
  if (leadRows.length === 0) return { exists: false, messages: [] };
  const lead = leadRows[0];
  if (!lead.visitor_id)
    return { exists: true, messages: [], conversation: null };
  const [convoRows] = await pool.execute(
    "SELECT id, visitor_id, channel, status FROM conversations WHERE tenant_id = ? AND chatbot_id = ? AND visitor_id = ? ORDER BY created_at DESC LIMIT 1",
    [lead.tenant_id, lead.chatbot_id, lead.visitor_id],
  );
  if (convoRows.length === 0)
    return { exists: true, messages: [], conversation: null };
  const conversation = convoRows[0];
  const [messages] = await pool.execute(
    "SELECT id, role, content, status, metadata_json, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversation.id],
  );
  const formatted = messages.map((m) => {
    const metadata = parseJsonSafe(m.metadata_json, {});
    return {
      id: String(m.id),
      role: String(m.role || "USER").toUpperCase(),
      content: m.content || "",
      timestamp: m.created_at,
      status: m.status,
      intent: metadata.intent || metadata.extracted_intent || "",
      metadata,
    };
  });
  return {
    exists: true,
    conversation: {
      id: conversation.id,
      visitorId: conversation.visitor_id,
      channel: conversation.channel,
      status: conversation.status,
    },
    messages: formatted,
  };
}

export async function assignLead(tenantId, { leadId, counsellorId }) {
  const hasAssigned = await checkHasAssignedColumn();
  if (!hasAssigned) {
    throw new Error("Assigned column not found in database.");
  }
  const assignedUserId =
    counsellorId &&
    counsellorId !== "Select Counsellor" &&
    counsellorId !== "unassigned"
      ? Number(counsellorId)
      : null;

  const [res] = await pool.execute(
    "UPDATE leads SET assigned_to_user_id = ?, updated_at = NOW() WHERE tenant_id = ? AND (public_id = ? OR CAST(id AS CHAR) = ? OR CONCAT('lead-', id) = ?)",
    [assignedUserId, tenantId, leadId, leadId, leadId],
  );
  return { success: true, affectedRows: res.affectedRows };
}

export async function assignBulkLeads(tenantId, { leadIds, counsellorId }) {
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return { success: true, affectedRows: 0 };
  }
  const hasAssigned = await checkHasAssignedColumn();
  if (!hasAssigned) {
    throw new Error("Assigned column not found in database.");
  }
  const assignedUserId =
    counsellorId &&
    counsellorId !== "Select Counsellor" &&
    counsellorId !== "unassigned"
      ? Number(counsellorId)
      : null;

  let affected = 0;
  for (const id of leadIds) {
    const [res] = await pool.execute(
      "UPDATE leads SET assigned_to_user_id = ?, updated_at = NOW() WHERE tenant_id = ? AND (public_id = ? OR CAST(id AS CHAR) = ? OR CONCAT('lead-', id) = ?)",
      [assignedUserId, tenantId, id, id, id],
    );
    affected += res.affectedRows;
  }
  return { success: true, affectedRows: affected };
}

export async function getLeadManagementMetrics(tenantId, options = {}) {
  const {
    startDate = "",
    endDate = "",
    fromDate = startDate,
    toDate = endDate,
  } = options;

  const dateConditions = ["deleted_at IS NULL"];
  const dateParams = [];
  if (fromDate) {
    dateConditions.push("DATE(created_at) >= ?");
    dateParams.push(fromDate);
  }
  if (toDate) {
    dateConditions.push("DATE(created_at) <= ?");
    dateParams.push(toDate);
  }
  const dateWhereStr = " AND " + dateConditions.join(" AND ");

  const [statusRows] = await pool.execute(
    `SELECT UPPER(COALESCE(status, 'NEW')) AS status, COUNT(*) AS count
     FROM leads
     WHERE tenant_id = ?${dateWhereStr}
     GROUP BY UPPER(COALESCE(status, 'NEW'))`,
    [tenantId, ...dateParams],
  );
  const statusMap = { NEW: 0, CONTACTED: 0, QUALIFIED: 0, CONVERTED: 0 };
  let totalLeads = 0;
  for (const row of statusRows) {
    const count = Number(row.count || 0);
    totalLeads += count;
    if (row.status in statusMap) {
      statusMap[row.status] = count;
    } else {
      statusMap.NEW += count;
    }
  }

  let prevWhere = "tenant_id = ? AND deleted_at IS NULL";
  let prevParams = [tenantId];
  if (fromDate && toDate) {
    const dFrom = new Date(fromDate);
    const dTo = new Date(toDate);
    const diffMs = Math.max(dTo.getTime() - dFrom.getTime(), 0);
    const prevTo = new Date(dFrom.getTime() - 24 * 60 * 60 * 1000);
    const prevFrom = new Date(prevTo.getTime() - diffMs);
    const prevFromStr = prevFrom.toISOString().slice(0, 10);
    const prevToStr = prevTo.toISOString().slice(0, 10);
    prevWhere += " AND DATE(created_at) >= ? AND DATE(created_at) <= ?";
    prevParams.push(prevFromStr, prevToStr);
  } else {
    prevWhere += " AND created_at < DATE_SUB(CURDATE(), INTERVAL 1 MONTH)";
  }

  const [prevStatusRows] = await pool.execute(
    `SELECT UPPER(COALESCE(status, 'NEW')) AS status, COUNT(*) AS count
     FROM leads
     WHERE ${prevWhere}
     GROUP BY UPPER(COALESCE(status, 'NEW'))`,
    prevParams,
  );
  const prevMap = { NEW: 0, CONTACTED: 0, QUALIFIED: 0, CONVERTED: 0 };
  let prevTotalLeads = 0;
  for (const row of prevStatusRows) {
    const count = Number(row.count || 0);
    prevTotalLeads += count;
    if (row.status in prevMap) {
      prevMap[row.status] = count;
    }
  }

  function calcDelta(curr, prev) {
    const c = Number(curr || 0);
    const p = Number(prev || 0);
    if (p === 0) {
      return { change: c > 0 ? "+100%" : "+0%", trend: "up" };
    }
    const diff = c - p;
    const pct = Math.round((diff / p) * 100);
    return {
      change: `${diff >= 0 ? "+" : ""}${pct}%`,
      trend: diff >= 0 ? "up" : "down",
    };
  }

  const [dailyRows] = await pool.execute(
    `SELECT DATE(created_at) AS day, UPPER(COALESCE(status, 'NEW')) AS status, COUNT(*) AS count
     FROM leads
     WHERE tenant_id = ?${dateWhereStr}
     GROUP BY DATE(created_at), UPPER(COALESCE(status, 'NEW'))`,
    [tenantId, ...dateParams],
  );

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const sparklines = {
    newLeads: days.map(() => 0),
    contacted: days.map(() => 0),
    qualified: days.map(() => 0),
    converted: days.map(() => 0),
  };

  for (const row of dailyRows) {
    const dayStr =
      row.day instanceof Date
        ? row.day.toISOString().slice(0, 10)
        : String(row.day).slice(0, 10);
    const dayIdx = days.indexOf(dayStr);
    if (dayIdx >= 0) {
      const cnt = Number(row.count || 0);
      if (row.status === "NEW") sparklines.newLeads[dayIdx] += cnt;
      else if (row.status === "CONTACTED") sparklines.contacted[dayIdx] += cnt;
      else if (row.status === "QUALIFIED") sparklines.qualified[dayIdx] += cnt;
      else if (row.status === "CONVERTED") sparklines.converted[dayIdx] += cnt;
    }
  }

  function ensureSparkline(arr, currentVal) {
    if (arr.some((v) => v > 0)) return arr;
    const val = Number(currentVal || 0);
    if (val === 0) return [0, 0, 0, 0, 0, 0, 0];
    const half = Math.max(Math.floor(val / 2), 1);
    return [
      Math.max(val - half, 1),
      Math.max(val - half + 1, 1),
      Math.max(val - 1, 1),
      val,
      val,
      val,
      val,
    ];
  }

  const newDelta = calcDelta(statusMap.NEW, prevMap.NEW);
  const contactedDelta = calcDelta(statusMap.CONTACTED, prevMap.CONTACTED);
  const qualifiedDelta = calcDelta(statusMap.QUALIFIED, prevMap.QUALIFIED);
  const convertedDelta = calcDelta(statusMap.CONVERTED, prevMap.CONVERTED);

  const convRateVal =
    totalLeads > 0 ? (statusMap.CONVERTED / totalLeads) * 100 : 0;
  const prevConvRateVal =
    prevTotalLeads > 0 ? (prevMap.CONVERTED / prevTotalLeads) * 100 : 0;
  const convRateDiff = convRateVal - prevConvRateVal;
  const convRateChange = `${convRateDiff >= 0 ? "+" : ""}${convRateDiff.toFixed(1)}%`;

  const kpis = [
    {
      key: "newLeads",
      label: "New Leads",
      value: String(statusMap.NEW),
      change: newDelta.change,
      comparison: "vs. last period",
      trend: newDelta.trend,
      icon: "users",
      tone: "blue",
      sparkline: ensureSparkline(sparklines.newLeads, statusMap.NEW),
    },
    {
      key: "contacted",
      label: "Contacted",
      value: String(statusMap.CONTACTED),
      change: contactedDelta.change,
      comparison: "vs. last period",
      trend: contactedDelta.trend,
      icon: "message",
      tone: "purple",
      sparkline: ensureSparkline(sparklines.contacted, statusMap.CONTACTED),
    },
    {
      key: "qualified",
      label: "Qualified",
      value: String(statusMap.QUALIFIED),
      change: qualifiedDelta.change,
      comparison: "vs. last period",
      trend: qualifiedDelta.trend,
      icon: "check",
      tone: "green",
      sparkline: ensureSparkline(sparklines.qualified, statusMap.QUALIFIED),
    },
    {
      key: "converted",
      label: "Converted",
      value: String(statusMap.CONVERTED),
      change: convertedDelta.change,
      comparison: "vs. last period",
      trend: convertedDelta.trend,
      icon: "target",
      tone: "orange",
      sparkline: ensureSparkline(sparklines.converted, statusMap.CONVERTED),
    },
    {
      key: "conversionRate",
      label: "Conversion Rate",
      value: `${convRateVal.toFixed(1)}%`,
      change: convRateChange,
      comparison: "vs. last period",
      trend: convRateDiff >= 0 ? "up" : "down",
      icon: "chart",
      tone: "sky",
      sparkline: [
        Math.max(Math.round(convRateVal * 0.5), 1),
        Math.max(Math.round(convRateVal * 0.6), 1),
        Math.max(Math.round(convRateVal * 0.7), 1),
        Math.max(Math.round(convRateVal * 0.8), 1),
        Math.max(Math.round(convRateVal * 0.85), 1),
        Math.max(Math.round(convRateVal * 0.95), 1),
        Math.max(Math.round(convRateVal), 1),
      ],
    },
  ];

  const pipeline = [
    {
      stage: "New Leads",
      value: statusMap.NEW,
      percent:
        totalLeads > 0
          ? `${Math.round((statusMap.NEW / totalLeads) * 100)}%`
          : "100%",
      color: "#2563eb",
    },
    {
      stage: "Contacted",
      value: statusMap.CONTACTED,
      percent:
        totalLeads > 0
          ? `${Math.round((statusMap.CONTACTED / totalLeads) * 100)}%`
          : "0%",
      color: "#16a34a",
    },
    {
      stage: "Qualified",
      value: statusMap.QUALIFIED,
      percent:
        totalLeads > 0
          ? `${Math.round((statusMap.QUALIFIED / totalLeads) * 100)}%`
          : "0%",
      color: "#f97316",
    },
    {
      stage: "Converted",
      value: statusMap.CONVERTED,
      percent:
        totalLeads > 0
          ? `${Math.round((statusMap.CONVERTED / totalLeads) * 100)}%`
          : "0%",
      color: "#8b5cf6",
    },
  ];

  const [sourceRows] = await pool.execute(
    `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count FROM leads WHERE tenant_id = ?${dateWhereStr} GROUP BY COALESCE(source, 'unknown')`,
    [tenantId, ...dateParams],
  );

  const sourceConfig = {
    website: { name: "Website", color: "#2563eb" },
    website_widget: { name: "Website", color: "#2563eb" },
    whatsapp: { name: "WhatsApp", color: "#16a34a" },
    social_media: { name: "Social Media", color: "#8b5cf6" },
    instagram: { name: "Social Media", color: "#8b5cf6" },
    facebook: { name: "Social Media", color: "#8b5cf6" },
    referral: { name: "Referral", color: "#f59e0b" },
    referal: { name: "Referral", color: "#f59e0b" },
    email_campaign: { name: "Email Campaign", color: "#06b6d4" },
    others: { name: "Others", color: "#94a3b8" },
    unknown: { name: "Others", color: "#94a3b8" },
  };

  const aggregatedSources = {};
  for (const row of sourceRows) {
    const rawKey = String(row.source || "others").toLowerCase().trim();
    const mapped = sourceConfig[rawKey] || {
      name:
        rawKey ? rawKey.charAt(0).toUpperCase() + rawKey.slice(1) : "Others",
      color: "#94a3b8",
    };
    if (!aggregatedSources[mapped.name]) {
      aggregatedSources[mapped.name] = {
        source: mapped.name,
        value: 0,
        color: mapped.color,
      };
    }
    aggregatedSources[mapped.name].value += Number(row.count || 0);
  }

  const sources = Object.values(aggregatedSources);
  if (sources.length === 0) {
    sources.push({ source: "Website", value: 0, color: "#2563eb" });
  }

  return {
    kpis,
    pipeline,
    sources,
    totalLeads,
  };
}

export function extractConversationInsights(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      courses: [],
      feesQuery: "Not provided",
      hostelQuery: "Not provided",
      hostelFees: "Not provided",
      preferredIntake: "Not provided",
      location: "Not provided",
      notes: "Not provided",
    };
  }

  const userMsgs = messages.filter(
    (m) =>
      String(m.role).toLowerCase() === "user" ||
      String(m.role).toLowerCase() === "lead",
  );
  if (userMsgs.length === 0) {
    return {
      courses: [],
      feesQuery: "Not provided",
      hostelQuery: "Not provided",
      hostelFees: "Not provided",
      preferredIntake: "Not provided",
      location: "Not provided",
      notes: "Not provided",
    };
  }

  const fullUserText = userMsgs.map((m) => m.content || "").join(" \n ");
  const lower = fullUserText.toLowerCase();

  // Fees query check
  const hasFees = /\b(fees?|fee\s*structure|tuition|cost|charges?|price|payment|scholarship)\b/i.test(
    lower,
  );
  const feesQuery = hasFees ? "Yes" : "No";

  // Hostel query check
  const hasHostel = /\b(hostel|mess|dorm|dormitory|accommodation|pg)\b/i.test(
    lower,
  );
  const hostelQuery = hasHostel ? "Yes" : "No";

  // Hostel fees
  const hasHostelFees = /(hostel\s+(fee|cost|charge|rent)|(fee|cost|charge).*hostel)/i.test(
    lower,
  );
  const hostelFees = hasHostelFees
    ? "Yes"
    : hasHostel
      ? "Inquired"
      : "Not provided";

  // Courses detection
  const courseRegexes = [
    { name: "B.Tech", rx: /\b(b\.?\s*tech|bachelor of technology)\b/i },
    { name: "M.Tech", rx: /\b(m\.?\s*tech|master of technology)\b/i },
    { name: "BCA", rx: /\b(bca|bachelor of computer applications?)\b/i },
    { name: "MCA", rx: /\b(mca|master of computer applications?)\b/i },
    { name: "BBA", rx: /\b(bba|bachelor of business administration)\b/i },
    { name: "MBA", rx: /\b(mba|master of business administration)\b/i },
    { name: "B.Sc", rx: /\b(b\.?\s*sc|bachelor of science)\b/i },
    { name: "M.Sc", rx: /\b(m\.?\s*sc|master of science)\b/i },
    { name: "B.Com", rx: /\b(b\.?\s*com|bachelor of commerce)\b/i },
    { name: "LLB", rx: /\b(llb|law)\b/i },
    { name: "PhD", rx: /\b(ph\.?d|doctorate)\b/i },
  ];
  const detectedCourses = [];
  for (const c of courseRegexes) {
    if (c.rx.test(lower)) {
      detectedCourses.push(c.name);
    }
  }

  // Intake detection
  let preferredIntake = "Not provided";
  const intakeMatch = lower.match(
    /\b(202[4-9]|2030|(?:fall|spring|autumn|monsoon|summer)\s*202[4-9]|fall|spring|autumn|batch\s*202[4-9])\b/i,
  );
  if (intakeMatch) {
    preferredIntake = intakeMatch[0].toUpperCase();
  }

  // Location detection
  let location = "Not provided";
  const locMatch = fullUserText.match(
    /\b(?:from|in|at|living in|staying in)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/,
  );
  if (
    locMatch &&
    !locMatch[1].toLowerCase().includes("b.tech") &&
    !locMatch[1].toLowerCase().includes("university")
  ) {
    location = locMatch[1].trim();
  }

  // Notes generation based on real inquiries
  const notesParts = [];
  if (detectedCourses.length > 0) {
    notesParts.push("Interested in " + detectedCourses.join(", "));
  }
  if (/\badmission\b/i.test(lower)) {
    notesParts.push("asked about admission process");
  }
  if (hasFees) {
    notesParts.push("queried course fees/payment");
  }
  if (hasHostel) {
    notesParts.push("queried hostel facilities");
  }
  if (/\bscholarship\b/i.test(lower)) {
    notesParts.push("asked for scholarship options");
  }
  if (/\bcounsellor|counselor\b/i.test(lower)) {
    notesParts.push("requested counsellor callback");
  }
  if (notesParts.length === 0 && userMsgs.length > 0) {
    if (/courses/i.test(lower)) {
      notesParts.push("Inquired about available university programs");
    } else {
      notesParts.push("General student inquiry");
    }
  }

  return {
    courses: detectedCourses,
    feesQuery,
    hostelQuery,
    hostelFees,
    preferredIntake,
    location,
    notes: notesParts.length > 0 ? notesParts.join("; ") + "." : "Not provided",
  };
}

export async function updateLeadDetails(tenantId, leadPublicId, updateData = {}) {
  const [rows] = await pool.execute(
    "SELECT id, public_id, tenant_id, chatbot_id, visitor_id, status, fields_json FROM leads WHERE tenant_id = ? AND (public_id = ? OR CAST(id AS CHAR) = ? OR CONCAT('lead-', id) = ?) AND deleted_at IS NULL LIMIT 1",
    [tenantId, leadPublicId, leadPublicId, leadPublicId],
  );
  if (rows.length === 0) {
    return null;
  }
  const leadRow = rows[0];
  const currentFields = parseJsonSafe(leadRow.fields_json, {});
  const updatedFields = { ...currentFields };

  if (updateData.name !== undefined) {
    updatedFields.name = String(updateData.name).trim();
    for (const [k, v] of Object.entries(currentFields)) {
      if (k.startsWith("field-") && (v === currentFields.name || !String(v).includes("@") && !/^\d{7,15}$/.test(String(v)))) {
        updatedFields[k] = updatedFields.name;
      }
    }
  }
  if (updateData.email !== undefined) {
    updatedFields.email = String(updateData.email).trim();
    for (const [k, v] of Object.entries(currentFields)) {
      if (k.startsWith("field-") && (v === currentFields.email || String(v).includes("@"))) {
        updatedFields[k] = updatedFields.email;
      }
    }
  }
  if (updateData.phone !== undefined) {
    updatedFields.phone = String(updateData.phone).trim();
    for (const [k, v] of Object.entries(currentFields)) {
      if (k.startsWith("field-") && (v === currentFields.phone || /^\d{7,15}$/.test(String(v).replace(/\D/g, "")))) {
        updatedFields[k] = updatedFields.phone;
      }
    }
  }
  if (updateData.coursesInterested !== undefined) {
    const rawCourse = updateData.coursesInterested;
    updatedFields.coursesInterested = Array.isArray(rawCourse)
      ? rawCourse
      : typeof rawCourse === "string"
      ? rawCourse.split(",").map((s) => s.trim()).filter(Boolean)
      : rawCourse;
    updatedFields.courses_interested = updatedFields.coursesInterested;
  }
  if (updateData.feesQuery !== undefined) {
    updatedFields.feesQuery = updateData.feesQuery;
    updatedFields.fees_query = updateData.feesQuery;
  }
  if (updateData.hostelQuery !== undefined) {
    updatedFields.hostelQuery = updateData.hostelQuery;
    updatedFields.hostel_query = updateData.hostelQuery;
  }
  if (updateData.hostelFees !== undefined) {
    updatedFields.hostelFees = updateData.hostelFees;
    updatedFields.hostel_fees = updateData.hostelFees;
  }
  if (updateData.preferredIntake !== undefined) {
    updatedFields.preferredIntake = updateData.preferredIntake;
    updatedFields.preferred_intake = updateData.preferredIntake;
  }
  if (updateData.location !== undefined) {
    updatedFields.location = updateData.location;
  }
  if (updateData.additionalNotes !== undefined) {
    updatedFields.additionalNotes = updateData.additionalNotes;
    updatedFields.notes = updateData.additionalNotes;
  }

  const validStatuses = ["NEW", "CONTACTED", "QUALIFIED", "CONVERTED", "LOST"];
  let newStatus = leadRow.status;
  if (updateData.status) {
    const s = String(updateData.status).toUpperCase().trim();
    if (validStatuses.includes(s)) {
      newStatus = s;
    }
  }

  await pool.execute(
    "UPDATE leads SET fields_json = ?, status = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
    [JSON.stringify(updatedFields), newStatus, leadRow.id, tenantId],
  );

  return getLeadById(tenantId, leadRow.public_id);
}

export async function softDeleteLead(tenantId, leadPublicId, actorUserId) {
  const [rows] = await pool.execute(
    "SELECT id, public_id, tenant_id FROM leads WHERE tenant_id = ? AND (public_id = ? OR CAST(id AS CHAR) = ? OR CONCAT('lead-', id) = ?) AND deleted_at IS NULL LIMIT 1",
    [tenantId, leadPublicId, leadPublicId, leadPublicId],
  );
  if (rows.length === 0) {
    throw new HttpError(404, "Lead not found or already deleted.");
  }
  const leadRow = rows[0];
  await pool.execute(
    `UPDATE leads
        SET deleted_at = CURRENT_TIMESTAMP,
            deleted_by_user_id = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    [actorUserId || null, leadRow.id, tenantId],
  );
  return { id: leadRow.public_id || String(leadRow.id), deleted: true };
}

export async function getCounsellorDashboardData(
  tenantId,
  counsellorUserId,
  options = {},
) {
  const cid = Number(counsellorUserId);

  // 1. Date range resolution
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const defaultStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const defaultEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, "0")}`;

  const startStr = options.startDate ? String(options.startDate).slice(0, 10) : defaultStart;
  const endStr = options.endDate ? String(options.endDate).slice(0, 10) : defaultEnd;
  const periodLabel = options.period || `${startStr} – ${endStr}`;

  // Calculate span of days and previous comparison period
  const startEpoch = new Date(`${startStr}T00:00:00Z`).getTime();
  const endEpoch = new Date(`${endStr}T00:00:00Z`).getTime();
  const spanDays = Math.max(1, Math.round((endEpoch - startEpoch) / (1000 * 60 * 60 * 24)) + 1);

  const priorEndEpoch = startEpoch - 24 * 60 * 60 * 1000;
  const priorStartEpoch = priorEndEpoch - (spanDays - 1) * 24 * 60 * 60 * 1000;

  const priorStartStr = new Date(priorStartEpoch).toISOString().slice(0, 10);
  const priorEndStr = new Date(priorEndEpoch).toISOString().slice(0, 10);

  const subtextLabel =
    spanDays === 1
      ? "vs yesterday"
      : spanDays === 7
      ? "vs last week"
      : "vs previous period";

  // Helper for trend deltas
  function computeDelta(current, previous) {
    const prev = Number(previous || 0);
    const curr = Number(current || 0);
    if (prev === 0) {
      return {
        value: curr === 0 ? 0 : 100,
        sign: curr >= 0 ? "up" : "down",
        prefix: curr >= 0 ? "+" : "-",
      };
    }
    const diff = curr - prev;
    const pct = Math.round((diff / prev) * 100);
    return {
      value: Math.abs(pct),
      sign: diff >= 0 ? "up" : "down",
      prefix: diff >= 0 ? "+" : "-",
    };
  }

  // 2. Total leads assigned to this counsellor in period & prior period
  const [[totalLeadsRow]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM leads WHERE tenant_id = ? AND assigned_to_user_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
    [tenantId, cid, startStr, endStr],
  );
  const totalLeads = Number(totalLeadsRow?.total || 0);

  const [[priorTotalRow]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM leads WHERE tenant_id = ? AND assigned_to_user_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
    [tenantId, cid, priorStartStr, priorEndStr],
  );
  const priorTotalLeads = Number(priorTotalRow?.total || 0);

  // 3. Conversion rate in period & prior period
  const [[convertedRow]] = await pool.execute(
    "SELECT COUNT(*) AS converted FROM leads WHERE tenant_id = ? AND assigned_to_user_id = ? AND UPPER(status) = 'CONVERTED' AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
    [tenantId, cid, startStr, endStr],
  );
  const convertedLeads = Number(convertedRow?.converted || 0);
  const conversionRate =
    totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;

  const [[priorConvertedRow]] = await pool.execute(
    "SELECT COUNT(*) AS converted FROM leads WHERE tenant_id = ? AND assigned_to_user_id = ? AND UPPER(status) = 'CONVERTED' AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
    [tenantId, cid, priorStartStr, priorEndStr],
  );
  const priorConvertedLeads = Number(priorConvertedRow?.converted || 0);
  const priorConversionRate =
    priorTotalLeads > 0
      ? Math.round((priorConvertedLeads / priorTotalLeads) * 100)
      : 0;

  // 4. Open conversations associated with assigned leads in period & prior period
  const [[openConvsRow]] = await pool.execute(
    "SELECT COUNT(DISTINCT c.id) AS open_convs FROM conversations c INNER JOIN leads l ON l.tenant_id = c.tenant_id AND l.visitor_id = c.visitor_id WHERE l.tenant_id = ? AND l.assigned_to_user_id = ? AND UPPER(COALESCE(c.status, 'OPEN')) = 'OPEN' AND DATE(c.created_at) >= ? AND DATE(c.created_at) <= ?",
    [tenantId, cid, startStr, endStr],
  );
  const openConversations = Number(openConvsRow?.open_convs || 0);

  const [[priorOpenConvsRow]] = await pool.execute(
    "SELECT COUNT(DISTINCT c.id) AS open_convs FROM conversations c INNER JOIN leads l ON l.tenant_id = c.tenant_id AND l.visitor_id = c.visitor_id WHERE l.tenant_id = ? AND l.assigned_to_user_id = ? AND UPPER(COALESCE(c.status, 'OPEN')) = 'OPEN' AND DATE(c.created_at) >= ? AND DATE(c.created_at) <= ?",
    [tenantId, cid, priorStartStr, priorEndStr],
  );
  const priorOpenConversations = Number(priorOpenConvsRow?.open_convs || 0);

  // 5. Calls in period & prior period
  const [[callsRow]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM calls WHERE tenant_id = ? AND counsellor_id = ? AND DATE(call_date) >= ? AND DATE(call_date) <= ?",
    [tenantId, cid, startStr, endStr],
  );
  const callsCount = Number(callsRow?.total || 0);

  const [[priorCallsRow]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM calls WHERE tenant_id = ? AND counsellor_id = ? AND DATE(call_date) >= ? AND DATE(call_date) <= ?",
    [tenantId, cid, priorStartStr, priorEndStr],
  );
  const priorCallsCount = Number(priorCallsRow?.total || 0);

  // 6. Daily trend for the selected date range
  const [dailyLeadRows] = await pool.execute(
    "SELECT DATE(created_at) AS day_date, COUNT(*) AS count FROM leads WHERE tenant_id = ? AND assigned_to_user_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ? GROUP BY DATE(created_at)",
    [tenantId, cid, startStr, endStr],
  );
  const countsByDate = {};
  for (const r of dailyLeadRows) {
    const dStr =
      r.day_date instanceof Date
        ? r.day_date.toISOString().slice(0, 10)
        : String(r.day_date).slice(0, 10);
    countsByDate[dStr] = Number(r.count || 0);
  }

  const MONTH_SHORT = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const leadTrend = [];
  const leadTrendSparkline = [];
  const iterDate = new Date(`${startStr}T00:00:00Z`);

  for (let i = 0; i < spanDays; i++) {
    const yyyy = iterDate.getUTCFullYear();
    const mm = String(iterDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(iterDate.getUTCDate()).padStart(2, "0");
    const isoDate = `${yyyy}-${mm}-${dd}`;
    const count = countsByDate[isoDate] || 0;

    leadTrend.push({
      date: `${iterDate.getUTCDate()} ${MONTH_SHORT[iterDate.getUTCMonth()]}`,
      day: `${MONTH_SHORT[iterDate.getUTCMonth()]} ${iterDate.getUTCDate()}`,
      fullDate: isoDate,
      count,
    });
    leadTrendSparkline.push(count);

    iterDate.setUTCDate(iterDate.getUTCDate() + 1);
  }

  // 7. Conversation Channels in period
  const [channelRows] = await pool.execute(
    "SELECT COALESCE(c.channel, 'website') AS channel, COUNT(DISTINCT c.id) AS count FROM conversations c INNER JOIN leads l ON l.tenant_id = c.tenant_id AND l.visitor_id = c.visitor_id WHERE l.tenant_id = ? AND l.assigned_to_user_id = ? AND DATE(c.created_at) >= ? AND DATE(c.created_at) <= ? GROUP BY COALESCE(c.channel, 'website')",
    [tenantId, cid, startStr, endStr],
  );
  const totalChannelConvs = channelRows.reduce(
    (sum, r) => sum + Number(r.count || 0),
    0,
  );
  const CHANNEL_META = {
    website: { label: "Website Widget", color: "#2563eb" },
    whatsapp: { label: "whatsapp", color: "#25D366" },
    calls: { label: "Calls", color: "#8b5cf6" },
    email: { label: "Email", color: "#f59e0b" },
    widget: { label: "Website Widget", color: "#2563eb" },
  };
  const conversationChannels = channelRows.map((r) => {
    const key = String(r.channel).toLowerCase();
    const isWa = key.includes("whatsapp");
    const meta = CHANNEL_META[key] || {
      label: String(r.channel),
      color: isWa ? "#25D366" : "#64748b",
    };
    const cnt = Number(r.count || 0);
    return {
      channelKey: r.channel,
      channel: meta.label,
      count: cnt,
      percentage:
        totalChannelConvs > 0 ? Math.round((cnt / totalChannelConvs) * 100) : 0,
      color: meta.color,
    };
  });

  // 8. Lead Status breakdown in period
  const [statusRows] = await pool.execute(
    "SELECT UPPER(COALESCE(status, 'NEW')) AS status, COUNT(*) AS count FROM leads WHERE tenant_id = ? AND assigned_to_user_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ? GROUP BY UPPER(COALESCE(status, 'NEW'))",
    [tenantId, cid, startStr, endStr],
  );
  const statusCounts = {};
  for (const r of statusRows) {
    statusCounts[r.status] = Number(r.count || 0);
  }
  const STATUS_CONFIGS = [
    { key: "NEW", label: "New", color: "#3b82f6" },
    { key: "CONTACTED", label: "Contacted", color: "#10b981" },
    { key: "QUALIFIED", label: "Qualified", color: "#8b5cf6" },
    { key: "CONVERTED", label: "Converted", color: "#0ea5e9" },
    { key: "LOST", label: "Lost", color: "#ef4444" },
  ];
  const leadStatus = STATUS_CONFIGS.map((cfg) => {
    const cnt = statusCounts[cfg.key] || 0;
    return {
      status: cfg.label,
      key: cfg.key,
      count: cnt,
      percentage: totalLeads > 0 ? Math.round((cnt / totalLeads) * 100) : 0,
      color: cfg.color,
    };
  });

  // 9. Recent Assigned Conversations in period
  const [recentConvs] = await pool.execute(
    `SELECT l.id AS lead_database_id, l.public_id AS lead_public_id, l.fields_json,
            c.id AS conv_id, c.public_id AS conv_public_id, c.channel, c.status AS conv_status,
            c.updated_at AS conv_updated_at,
            (SELECT content FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_time
     FROM leads l
     INNER JOIN conversations c ON c.tenant_id = l.tenant_id AND c.visitor_id = l.visitor_id
     WHERE l.tenant_id = ? AND l.assigned_to_user_id = ?
       AND DATE(c.created_at) >= ? AND DATE(c.created_at) <= ?
     ORDER BY COALESCE((SELECT created_at FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1), c.updated_at, l.updated_at) DESC
     LIMIT 5`,
    [tenantId, cid, startStr, endStr],
  );
  const formattedRecentConversations = recentConvs.map((row) => {
    const fields = extractFields(row.fields_json, null);
    return {
      conversationId: row.conv_id,
      conversationPublicId: row.conv_public_id,
      leadId: row.lead_public_id,
      leadDatabaseId: row.lead_database_id,
      name: fields.name || `Lead ${String(row.lead_public_id).slice(0, 6)}`,
      lastMessage: row.last_message || "No messages yet",
      lastActivityTime: row.last_message_time || row.conv_updated_at,
      channel: row.channel || "website",
      unreadCount: 0,
    };
  });

  // 10. Follow-ups in period & prior period
  let formattedUpcomingFollowUps = [];
  let periodFollowUpsCount = 0;
  let priorPeriodFollowUpsCount = 0;
  try {
    const followUpsResult = await listFollowUps(tenantId, { counsellorId: cid });
    const allCounsellorFollowUps = (followUpsResult?.followUps || []).filter(
      (f) => f.status !== "COMPLETED" && f.status !== "CANCELLED",
    );

    // Follow-ups in selected date range
    const periodFollowUps = allCounsellorFollowUps.filter(
      (f) => f.date && f.date >= startStr && f.date <= endStr,
    );
    periodFollowUpsCount = periodFollowUps.length;

    // Prior period follow-ups for delta
    const priorPeriodFollowUps = allCounsellorFollowUps.filter(
      (f) => f.date && f.date >= priorStartStr && f.date <= priorEndStr,
    );
    priorPeriodFollowUpsCount = priorPeriodFollowUps.length;

    periodFollowUps.sort((a, b) => {
      if (a.isOverdue && !b.isOverdue) return -1;
      if (!a.isOverdue && b.isOverdue) return 1;
      const dComp = (a.date || "").localeCompare(b.date || "");
      if (dComp !== 0) return dComp;
      return (a.time || "").localeCompare(b.time || "");
    });

    const nowIso = now.toISOString().slice(0, 10);
    const tomDate = new Date(now);
    tomDate.setDate(tomDate.getDate() + 1);
    const tomIso = tomDate.toISOString().slice(0, 10);

    formattedUpcomingFollowUps = periodFollowUps.slice(0, 5).map((fu) => {
      const initials = (fu.leadName || "Lead")
        .split(" ")
        .filter(Boolean)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

      let dueLabel = `${fu.date} • ${fu.time}`;
      if (fu.date === nowIso) {
        dueLabel = `Today • ${fu.time}`;
      } else if (fu.date === tomIso) {
        dueLabel = `Tomorrow • ${fu.time}`;
      } else if (fu.isOverdue) {
        dueLabel = `Overdue (${fu.date})`;
      }

      return {
        id: fu.id,
        leadId: fu.leadId,
        leadPublicId: fu.leadPublicId,
        name: fu.leadName,
        leadName: fu.leadName,
        initials: initials || "FU",
        task: fu.purpose || "Follow-up discussion",
        purpose: fu.purpose || "Follow-up discussion",
        date: fu.date,
        time: fu.time,
        status: fu.status || "PENDING",
        isOverdue: !!fu.isOverdue,
        dueLabel,
      };
    });
  } catch (fuErr) {
    console.error("[leadService] getCounsellorDashboardData follow-ups error:", fuErr);
  }

  return {
    period: {
      startDate: startStr,
      endDate: endStr,
      label: periodLabel,
      spanDays,
      subtext: subtextLabel,
    },
    kpis: {
      openConversations,
      myLeads: totalLeads,
      leadsDueToday: periodFollowUpsCount,
      callsToday: callsCount,
      conversionRate,
    },
    deltas: {
      openConversations: computeDelta(openConversations, priorOpenConversations),
      myLeads: computeDelta(totalLeads, priorTotalLeads),
      leadsDueToday: computeDelta(periodFollowUpsCount, priorPeriodFollowUpsCount),
      callsToday: computeDelta(callsCount, priorCallsCount),
      conversionRate: computeDelta(conversionRate, priorConversionRate),
    },
    subtexts: {
      openConversations: subtextLabel,
      myLeads: subtextLabel,
      leadsDueToday: subtextLabel,
      callsToday: subtextLabel,
      conversionRate: spanDays <= 7 ? "vs last week" : subtextLabel,
    },
    sparklines: {
      openConversations: leadTrendSparkline.map((v) => Math.max(v - 1, 0)),
      myLeads: leadTrendSparkline,
      leadsDueToday: leadTrendSparkline.map((v) => Math.min(v, periodFollowUpsCount)),
      callsToday: leadTrendSparkline.map((v) => Math.min(v, callsCount)),
      conversionRate: [priorConversionRate, conversionRate, conversionRate],
    },
    leadTrend,
    conversationChannels,
    totalConversations: totalChannelConvs,
    leadStatus,
    upcomingFollowUps: formattedUpcomingFollowUps,
    recentConversations: formattedRecentConversations,
  };
}

export async function listInboxConversations(tenantId, options = {}) {
  const {
    counsellorId,
    chatbotId,
    channel,
    status = "all",
    search = "",
    startDate,
    endDate,
    page = 1,
    limit = 50,
  } = options;

  const where = ["c.tenant_id = ?"];
  const params = [tenantId];

  if (chatbotId && chatbotId !== "all" && String(chatbotId).toLowerCase() !== "undefined") {
    where.push("(c.chatbot_id = ? OR c.chatbot_public_id = ?)");
    params.push(chatbotId, chatbotId);
  }

  if (channel && channel !== "all" && String(channel).toLowerCase() !== "undefined") {
    where.push("LOWER(COALESCE(c.channel, 'website')) = ?");
    params.push(String(channel).toLowerCase());
  }

  if (counsellorId && counsellorId !== "all") {
    where.push("l.assigned_to_user_id = ?");
    params.push(Number(counsellorId));
  }

  if (status && status !== "all" && String(status).toLowerCase() !== "undefined") {
    where.push("UPPER(c.status) = ?");
    params.push(status.toUpperCase());
  }

  if (startDate && startDate !== "all" && String(startDate).toLowerCase() !== "undefined") {
    where.push("DATE(c.created_at) >= ?");
    params.push(String(startDate).slice(0, 10));
  }

  if (endDate && endDate !== "all" && String(endDate).toLowerCase() !== "undefined") {
    where.push("DATE(c.created_at) <= ?");
    params.push(String(endDate).slice(0, 10));
  }

  if (search && search.trim() && search.trim().toLowerCase() !== "undefined") {
    const q = `%${search.trim().toLowerCase()}%`;
    where.push(
      "(LOWER(COALESCE(l.fields_json, '')) LIKE ? OR LOWER(COALESCE(c.channel, '')) LIKE ? OR LOWER(COALESCE((SELECT content FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1), '')) LIKE ?)",
    );
    params.push(q, q, q);
  }

  const whereStr = where.join(" AND ");

  const [[countRow]] = await pool.execute(
    `SELECT COUNT(DISTINCT c.id) AS total
     FROM conversations c
     LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.visitor_id = c.visitor_id
     WHERE ${whereStr}`,
    params,
  );
  const total = Number(countRow?.total || 0);

  const offset = Math.max(0, (Number(page) - 1) * Number(limit));

  const [rows] = await pool.execute(
    `SELECT 
       c.id AS conv_id, 
       c.public_id AS conv_public_id, 
       c.visitor_id, 
       c.channel, 
       c.status AS conv_status, 
       c.created_at AS conv_created_at, 
       c.updated_at AS conv_updated_at,
       c.chatbot_id,
       l.id AS lead_database_id, 
       l.public_id AS lead_public_id, 
       l.status AS lead_status, 
       l.source AS lead_source, 
       l.fields_json AS lead_fields_json,
       l.deleted_at AS lead_deleted_at,
       l.assigned_to_user_id,
       u.name AS counsellor_name,
       u.email AS counsellor_email,
       cb.name AS chatbot_name,
       cb.config_json AS chatbot_config_json,
       (SELECT content FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
       (SELECT role FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_role,
       (SELECT created_at FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_time
     FROM conversations c
     LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.visitor_id = c.visitor_id
     LEFT JOIN users u ON u.id = l.assigned_to_user_id
     LEFT JOIN chatbots cb ON cb.id = c.chatbot_id
     WHERE ${whereStr}
     ORDER BY COALESCE((SELECT created_at FROM conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1), c.updated_at, c.created_at) DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)],
  );

  const conversations = rows.map((row) => {
    const fields = extractFields(row.lead_fields_json, row.chatbot_config_json);
    const isLeadDeleted = Boolean(row.lead_deleted_at);
    let displayName = `Visitor ${String(row.visitor_id).slice(-6)}`;
    if (row.lead_database_id) {
      if (isLeadDeleted) {
        displayName = fields.name ? `${fields.name} (Deleted)` : `Visitor ${String(row.visitor_id).slice(-6)}`;
      } else {
        displayName = fields.name || `Lead ${String(row.lead_public_id).slice(0, 6)}`;
      }
    }

    return {
      id: row.conv_public_id || String(row.conv_id),
      databaseId: row.conv_id,
      visitorId: row.visitor_id,
      channel: row.channel || "website",
      status: String(row.conv_status || "OPEN").toUpperCase(),
      createdAt: row.conv_created_at,
      updatedAt: row.conv_updated_at,
      lastMessage: row.last_message || "No messages yet",
      lastMessageRole: row.last_message_role ? String(row.last_message_role).toUpperCase() : null,
      lastActivityTime: row.last_message_time || row.conv_updated_at,
      unreadCount: 0,
      chatbot: {
        id: row.chatbot_id,
        name: row.chatbot_name || "Chatbot",
      },
      lead: {
        id: row.lead_public_id || `visitor_${row.visitor_id.slice(0, 8)}`,
        databaseId: row.lead_database_id,
        name: displayName,
        email: !isLeadDeleted && fields.email ? fields.email : "—",
        phone: !isLeadDeleted && fields.phone ? fields.phone : "—",
        status: isLeadDeleted ? "DELETED" : String(row.lead_status || "NEW").toUpperCase(),
        isDeleted: isLeadDeleted,
        isAnonymous: !row.lead_database_id,
        source: row.lead_source || "website_widget",
        coursesInterested: fields.coursesInterested,
        assignedTo: !isLeadDeleted && row.assigned_to_user_id
          ? {
              id: row.assigned_to_user_id,
              name: row.counsellor_name || "",
              email: row.counsellor_email || "",
            }
          : null,
      },
    };
  });

  return {
    conversations,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.ceil(total / Number(limit)),
    },
  };
}

export async function getInboxConversationDetails(tenantId, conversationId, options = {}) {
  const { counsellorId } = options;

  const [convoRows] = await pool.execute(
    `SELECT c.id, c.public_id, c.visitor_id, c.chatbot_id, c.channel, c.status, c.created_at, c.updated_at
     FROM conversations c
     WHERE c.tenant_id = ? AND (c.public_id = ? OR CAST(c.id AS CHAR) = ?)
     LIMIT 1`,
    [tenantId, conversationId, conversationId],
  );

  if (convoRows.length === 0) {
    throw new HttpError(404, "Conversation not found.");
  }
  const conversation = convoRows[0];

  const [leadRows] = await pool.execute(
    `SELECT l.id, l.public_id, l.status, l.source, l.fields_json, l.assigned_to_user_id, l.created_at, l.updated_at,
            u.name AS counsellor_name, u.email AS counsellor_email, u.designation AS counsellor_designation,
            cb.name AS chatbot_name, cb.config_json AS chatbot_config_json
     FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to_user_id
     LEFT JOIN chatbots cb ON cb.id = l.chatbot_id
     WHERE l.tenant_id = ? AND l.visitor_id = ?
     LIMIT 1`,
    [tenantId, conversation.visitor_id],
  );

  let lead = null;
  if (leadRows.length > 0) {
    const lRow = leadRows[0];

    if (counsellorId && counsellorId !== "all") {
      if (!lRow.assigned_to_user_id || String(lRow.assigned_to_user_id) !== String(counsellorId)) {
        throw new HttpError(403, "You do not have permission to access this conversation.");
      }
    }

    const fields = extractFields(lRow.fields_json, lRow.chatbot_config_json);
    const parsedFields = parseJsonSafe(lRow.fields_json, {});
    // All feedbacks for this lead (all conversations)
    const allFeedbacks = Array.isArray(parsedFields.feedbacks) ? parsedFields.feedbacks : [];
    // Feedbacks scoped to this specific conversation
    const conversationFeedbacks = allFeedbacks.filter(
      (fb) => String(fb.conversationId) === String(conversation.id) ||
               String(fb.conversationPublicId) === String(conversationId)
    );
    lead = {
      id: lRow.public_id,
      databaseId: lRow.id,
      name: fields.name || `Lead ${String(lRow.public_id).slice(0, 6)}`,
      email: fields.email || "—",
      phone: fields.phone || "—",
      status: String(lRow.status || "NEW").toUpperCase(),
      source: lRow.source || "unknown",
      createdAt: lRow.created_at,
      updatedAt: lRow.updated_at,
      coursesInterested: fields.coursesInterested,
      feesQuery: fields.feesQuery,
      hostelQuery: fields.hostelQuery,
      hostelFees: fields.hostelFees,
      preferredIntake: fields.preferredIntake,
      location: fields.location,
      additionalNotes: fields.additionalNotes,
      // All feedbacks for the lead (used by lead detail page)
      feedbacks: allFeedbacks,
      latestFeedback: allFeedbacks.length > 0 ? allFeedbacks[0] : null,
      // Feedbacks specific to this conversation (used by inbox feedback panel)
      conversationFeedbacks,
      latestConversationFeedback: conversationFeedbacks.length > 0 ? conversationFeedbacks[0] : null,
      assignedTo: lRow.assigned_to_user_id
        ? {
            id: lRow.assigned_to_user_id,
            name: lRow.counsellor_name || "",
            email: lRow.counsellor_email || "",
            designation: lRow.counsellor_designation || "",
          }
        : null,
      chatbotName: lRow.chatbot_name || "",
    };
  } else if (counsellorId && counsellorId !== "all") {
    throw new HttpError(403, "You do not have permission to access this conversation.");
  }

  const [messages] = await pool.execute(
    `SELECT id, role, content, status, metadata_json, created_at
     FROM conversation_messages
     WHERE conversation_id = ?
     ORDER BY created_at ASC, id ASC`,
    [conversation.id],
  );

  const formattedMessages = messages.map((m) => {
    const metadata = parseJsonSafe(m.metadata_json, {});
    return {
      id: String(m.id),
      role: String(m.role || "USER").toUpperCase(),
      content: m.content || "",
      timestamp: m.created_at,
      status: m.status,
      intent: metadata.intent || metadata.extracted_intent || "",
      metadata,
    };
  });

  return {
    conversation: {
      id: conversation.public_id || String(conversation.id),
      databaseId: conversation.id,
      channel: conversation.channel || "website",
      status: String(conversation.status || "OPEN").toUpperCase(),
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    },
    messages: formattedMessages,
    lead,
  };
}

export async function saveConversationFeedback(tenantId, conversationId, payload, userContext) {
  if (!conversationId) {
    throw new HttpError(400, "Conversation ID is required.");
  }

  const [convoRows] = await pool.execute(
    `SELECT c.id, c.public_id, c.tenant_id, c.visitor_id
     FROM conversations c
     WHERE c.tenant_id = ? AND (c.public_id = ? OR CAST(c.id AS CHAR) = ?)
     LIMIT 1`,
    [tenantId, conversationId, conversationId],
  );

  if (convoRows.length === 0) {
    throw new HttpError(404, "Conversation not found.");
  }
  const conversation = convoRows[0];

  const [leadRows] = await pool.execute(
    `SELECT id, public_id, tenant_id, assigned_to_user_id, status, fields_json
     FROM leads
     WHERE tenant_id = ? AND visitor_id = ?
     LIMIT 1`,
    [tenantId, conversation.visitor_id],
  );

  if (leadRows.length === 0) {
    throw new HttpError(404, "Lead associated with this conversation was not found.");
  }
  const lead = leadRows[0];

  // RBAC check: if user is COUNSELLOR, lead must be assigned to them
  if (userContext.role === "COUNSELLOR") {
    const currentUserId = Number(userContext.userId || userContext.sub);
    if (Number(lead.assigned_to_user_id) !== currentUserId) {
      throw new HttpError(403, "You do not have permission to record feedback for this lead.");
    }
  }

  const {
    conversationDate,
    conversationTime,
    channel,
    conversationSummary,
    keyInterests,
    counsellorNotes,
    feedback,
    status,
    approachAgain,
    followUpRequired,
    nextContactDate,
    nextContactTime,
  } = payload;

  if (!conversationDate) throw new HttpError(400, "Conversation date is required.");
  if (!conversationTime) throw new HttpError(400, "Conversation time is required.");
  if (!feedback || !feedback.trim()) throw new HttpError(400, "Conversation feedback / summary is required.");

  const validStatuses = ["NEW", "CONTACTED", "QUALIFIED", "CONVERTED", "LOST"];
  const cleanStatus = String(status || "").trim().toUpperCase();
  if (!validStatuses.includes(cleanStatus)) {
    throw new HttpError(400, `Invalid lead status. Must be one of: ${validStatuses.join(", ")}`);
  }

  const isApproachAgain = approachAgain === true || String(approachAgain).toLowerCase() === "yes";

  // Re-use existing follow-up system if followUpRequired=true and nextContactDate is provided
  const isFollowUpCreatable = (isApproachAgain || (followUpRequired === true || String(followUpRequired).toLowerCase() === "yes"));
  let createdFollowUp = null;
  if (isFollowUpCreatable && nextContactDate) {
    createdFollowUp = await createFollowUp(
      tenantId,
      {
        leadId: lead.id,
        date: nextContactDate,
        time: nextContactTime || "10:00 AM",
        purpose: `Conversation Follow-up: ${(conversationSummary || feedback || "").trim().slice(0, 80)}`,
        notes: (counsellorNotes || feedback || "").trim(),
      },
      userContext,
    );
  }

  // Fresh fetch to get latest fields_json (including follow-up if created)
  const [[freshLead]] = await pool.execute(
    "SELECT id, fields_json FROM leads WHERE id = ? AND tenant_id = ? LIMIT 1",
    [lead.id, tenantId],
  );
  const currentFields = parseJsonSafe(freshLead?.fields_json, {});
  const feedbacks = Array.isArray(currentFields.feedbacks) ? [...currentFields.feedbacks] : [];

  const isFollowUpRequired = followUpRequired === true || String(followUpRequired).toLowerCase() === "yes";

  const feedbackRecord = {
    id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    conversationId: conversation.id,
    conversationPublicId: conversation.public_id,
    counsellorId: userContext.userId || userContext.sub,
    counsellorName: userContext.name || "Counsellor",
    conversationDate: String(conversationDate).slice(0, 10),
    conversationTime: String(conversationTime).trim(),
    channel: channel ? String(channel).trim() : "website",
    conversationSummary: conversationSummary ? String(conversationSummary).trim() : "",
    keyInterests: Array.isArray(keyInterests)
      ? keyInterests.filter(Boolean).map((k) => String(k).trim())
      : (keyInterests ? [String(keyInterests).trim()] : []),
    counsellorNotes: counsellorNotes ? String(counsellorNotes).trim() : "",
    feedback: feedback.trim(),
    status: cleanStatus,
    approachAgain: isApproachAgain,
    followUpRequired: isFollowUpRequired,
    nextContactDate: isFollowUpRequired && nextContactDate ? String(nextContactDate).slice(0, 10) : null,
    nextContactTime: isFollowUpRequired && nextContactTime ? String(nextContactTime).trim() : null,
    followUpId: createdFollowUp ? createdFollowUp.id : null,
    createdAt: new Date().toISOString(),
  };

  feedbacks.unshift(feedbackRecord);
  currentFields.feedbacks = feedbacks;
  currentFields.last_feedback = feedbackRecord;

  await pool.execute(
    `UPDATE leads 
     SET status = ?, 
         last_contacted_at = NOW(), 
         converted_at = CASE WHEN ? = 'CONVERTED' AND converted_at IS NULL THEN NOW() ELSE converted_at END,
         fields_json = ?, 
         updated_at = NOW() 
     WHERE id = ? AND tenant_id = ?`,
    [cleanStatus, cleanStatus, JSON.stringify(currentFields), lead.id, tenantId],
  );

  return {
    feedback: feedbackRecord,
    leadStatus: cleanStatus,
    followUp: createdFollowUp,
  };
}

export async function listFollowUps(tenantId, options = {}) {
  const {
    counsellorId,
    status = "ALL",
    search = "",
  } = options;

  const where = ["l.tenant_id = ?", "l.deleted_at IS NULL"];
  const params = [tenantId];

  if (counsellorId && counsellorId !== "all") {
    where.push("l.assigned_to_user_id = ?");
    params.push(Number(counsellorId));
  }

  const query = `
    SELECT 
      l.id AS lead_id,
      l.public_id AS lead_public_id,
      l.tenant_id,
      l.assigned_to_user_id,
      l.status AS lead_status,
      l.source AS lead_source,
      l.fields_json,
      l.created_at AS lead_created_at,
      u.name AS counsellor_name,
      u.email AS counsellor_email
    FROM leads l
    LEFT JOIN users u ON u.id = l.assigned_to_user_id
    WHERE ${where.join(" AND ")}
    ORDER BY l.updated_at DESC
  `;

  const [rows] = await pool.execute(query, params);

  const allFollowUps = [];
  const assignedLeads = [];

  // Use local date calculations
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const todayStr = `${year}-${month}-${day}`;

  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomYear = tomorrowDate.getFullYear();
  const tomMonth = String(tomorrowDate.getMonth() + 1).padStart(2, "0");
  const tomDay = String(tomorrowDate.getDate()).padStart(2, "0");
  const tomorrowStr = `${tomYear}-${tomMonth}-${tomDay}`;

  const next7Date = new Date(now);
  next7Date.setDate(next7Date.getDate() + 7);
  const next7Year = next7Date.getFullYear();
  const next7Month = String(next7Date.getMonth() + 1).padStart(2, "0");
  const next7Day = String(next7Date.getDate()).padStart(2, "0");
  const next7DaysStr = `${next7Year}-${next7Month}-${next7Day}`;

  for (const row of rows) {
    const fields = parseJsonSafe(row.fields_json, {});
    const leadName = fields.name || fields.fullName || fields.student_name || `Lead #${row.lead_id}`;
    const leadCourse = Array.isArray(fields.coursesInterested)
      ? fields.coursesInterested.join(", ")
      : (fields.coursesInterested || fields.course || "-");

    assignedLeads.push({
      id: row.lead_id,
      publicId: row.lead_public_id,
      name: leadName,
      email: fields.email || "",
      phone: fields.phone || "",
      course: leadCourse,
      status: row.lead_status,
      source: row.lead_source,
      counsellorName: row.counsellor_name || "Unassigned",
    });

    const followUpsList = Array.isArray(fields.follow_ups)
      ? fields.follow_ups
      : Array.isArray(fields.followUps)
      ? fields.followUps
      : [];

    if (followUpsList.length === 0 && (fields.next_follow_up_date || fields.follow_up_date)) {
      followUpsList.push({
        id: `fu_${row.lead_id}_single`,
        date: fields.next_follow_up_date || fields.follow_up_date,
        time: fields.next_follow_up_time || fields.follow_up_time || "10:00 AM",
        purpose: fields.follow_up_notes || fields.follow_up_purpose || "Follow-up discussion",
        status: fields.follow_up_status || "PENDING",
      });
    }

    for (const fu of followUpsList) {
      if (!fu || !fu.date) continue;

      const fuDate = String(fu.date).slice(0, 10);
      const fuTime = fu.time || "10:00 AM";
      const fuStatus = (fu.status || "PENDING").toUpperCase();

      let isOverdue = false;
      if (fuStatus !== "COMPLETED" && fuStatus !== "CANCELLED") {
        if (fuDate < todayStr) {
          isOverdue = true;
          if (row.assigned_to_user_id) {
            createNotificationIfNotExistsRecent({
              tenantId,
              recipientUserId: row.assigned_to_user_id,
              type: "FOLLOW_UP_OVERDUE",
              title: "Follow-up Overdue",
              message: `Follow-up for student lead "${leadName}" is overdue (${fuDate}).`,
              module: "Follow-ups",
              entityType: "lead",
              entityId: row.lead_id,
              priority: "URGENT",
              cooldownHours: 24,
            }).catch(() => {});
          }
        }
      }

      let groupCategory = "other";
      if (isOverdue) {
        groupCategory = "overdue";
      } else if (fuDate === todayStr) {
        groupCategory = "today";
      } else if (fuDate === tomorrowStr) {
        groupCategory = "tomorrow";
      } else if (fuDate > tomorrowStr && fuDate <= next7DaysStr) {
        groupCategory = "thisWeek";
      }

      const item = {
        id: fu.id || `fu_${row.lead_id}_${Math.random()}`,
        leadId: row.lead_id,
        leadPublicId: row.lead_public_id,
        leadName,
        leadEmail: fields.email || "",
        leadPhone: fields.phone || "",
        leadCourse,
        leadStatus: row.lead_status,
        counsellorId: row.assigned_to_user_id,
        counsellorName: row.counsellor_name || "Unassigned",
        date: fuDate,
        time: fuTime,
        purpose: fu.purpose || fu.note || fu.notes || "Follow-up",
        status: isOverdue && fuStatus === "PENDING" ? "OVERDUE" : fuStatus,
        isOverdue,
        group: groupCategory,
        createdAt: fu.created_at || row.lead_created_at,
      };

      allFollowUps.push(item);
    }
  }

  let filtered = allFollowUps;
  if (search && search.trim()) {
    const s = search.trim().toLowerCase();
    filtered = filtered.filter(
      (f) =>
        f.leadName.toLowerCase().includes(s) ||
        f.purpose.toLowerCase().includes(s) ||
        f.status.toLowerCase().includes(s) ||
        f.counsellorName.toLowerCase().includes(s) ||
        f.leadCourse.toLowerCase().includes(s),
    );
  }

  if (status && status !== "ALL") {
    filtered = filtered.filter((f) => f.status === status);
  }

  // Sort: overdue first, then by date ascending, then time
  filtered.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    return a.date.localeCompare(b.date);
  });

  const groups = {
    today: filtered.filter((f) => f.group === "today"),
    tomorrow: filtered.filter((f) => f.group === "tomorrow"),
    thisWeek: filtered.filter((f) => f.group === "thisWeek"),
    overdue: filtered.filter((f) => f.group === "overdue"),
  };

  const counts = {
    total: filtered.length,
    today: groups.today.length,
    tomorrow: groups.tomorrow.length,
    thisWeek: groups.thisWeek.length,
    overdue: groups.overdue.length,
  };

  return {
    followUps: filtered,
    groups,
    counts,
    assignedLeads,
  };
}

export async function createFollowUp(tenantId, payload, userContext) {
  const { leadId, date, time, purpose, notes } = payload;
  if (!leadId) throw new HttpError(400, "Lead selection is required.");
  if (!date) throw new HttpError(400, "Follow-up date is required.");

  // Check if leadId is numeric or public_id
  const isNumeric = /^\d+$/.test(String(leadId));
  const query = isNumeric
    ? "SELECT id, public_id, tenant_id, assigned_to_user_id, fields_json FROM leads WHERE id = ? AND tenant_id = ?"
    : "SELECT id, public_id, tenant_id, assigned_to_user_id, fields_json FROM leads WHERE public_id = ? AND tenant_id = ?";

  const [[lead]] = await pool.execute(query, [leadId, tenantId]);
  if (!lead) throw new HttpError(404, "Lead not found.");

  // If user is COUNSELLOR, enforce that the lead is assigned to them
  if (userContext.role === "COUNSELLOR") {
    const currentUserId = Number(userContext.userId || userContext.sub);
    if (Number(lead.assigned_to_user_id) !== currentUserId) {
      throw new HttpError(403, "You can only schedule follow-ups for your assigned leads.");
    }
  }

  const fields = parseJsonSafe(lead.fields_json, {});
  const followUps = Array.isArray(fields.follow_ups) ? [...fields.follow_ups] : [];

  const newFollowUp = {
    id: `fu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    date: String(date).slice(0, 10),
    time: time || "10:00 AM",
    purpose: purpose || notes || "Lead follow-up",
    status: "PENDING",
    created_at: new Date().toISOString(),
    created_by_user_id: userContext.userId || userContext.sub,
  };

  followUps.push(newFollowUp);
  fields.follow_ups = followUps;
  fields.next_follow_up_date = newFollowUp.date;
  fields.next_follow_up_time = newFollowUp.time;
  fields.follow_up_notes = newFollowUp.purpose;

  await pool.execute(
    "UPDATE leads SET fields_json = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?",
    [JSON.stringify(fields), lead.id, tenantId],
  );

  if (lead.assigned_to_user_id) {
    createNotification({
      tenantId,
      recipientUserId: lead.assigned_to_user_id,
      actorUserId: userContext.userId || userContext.sub,
      type: "FOLLOW_UP_SCHEDULED",
      title: "New Follow-up Scheduled",
      message: `Follow-up scheduled for student lead #${lead.public_id || lead.id} on ${newFollowUp.date} at ${newFollowUp.time}.`,
      module: "Follow-ups",
      entityType: "lead",
      entityId: lead.id,
      priority: "INFO",
    }).catch(() => {});
  }

  return newFollowUp;
}

export async function updateFollowUp(tenantId, followUpId, payload, userContext) {
  if (!followUpId) throw new HttpError(400, "Follow-up ID is required.");

  const [leads] = await pool.execute(
    "SELECT id, tenant_id, assigned_to_user_id, fields_json FROM leads WHERE tenant_id = ?",
    [tenantId],
  );

  let targetLead = null;
  let targetIndex = -1;

  for (const l of leads) {
    const fields = parseJsonSafe(l.fields_json, {});
    if (Array.isArray(fields.follow_ups)) {
      const idx = fields.follow_ups.findIndex((f) => String(f.id) === String(followUpId));
      if (idx !== -1) {
        targetLead = l;
        targetIndex = idx;
        break;
      }
    }
  }

  if (!targetLead || targetIndex === -1) {
    throw new HttpError(404, "Follow-up not found.");
  }

  // Counsellor check
  if (userContext.role === "COUNSELLOR") {
    const currentUserId = Number(userContext.userId || userContext.sub);
    if (Number(targetLead.assigned_to_user_id) !== currentUserId) {
      throw new HttpError(403, "You do not have permission to update this follow-up.");
    }
  }

  const fields = parseJsonSafe(targetLead.fields_json, {});
  const fu = fields.follow_ups[targetIndex];

  if (payload.status) fu.status = String(payload.status).toUpperCase();
  if (payload.date) fu.date = String(payload.date).slice(0, 10);
  if (payload.time) fu.time = payload.time;
  if (payload.purpose !== undefined) fu.purpose = payload.purpose;
  if (payload.notes !== undefined) fu.purpose = payload.notes;
  fu.updated_at = new Date().toISOString();

  await pool.execute(
    "UPDATE leads SET fields_json = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?",
    [JSON.stringify(fields), targetLead.id, tenantId],
  );

  return fu;
}

export async function listCalls(tenantId, options = {}) {
  const {
    counsellorId,
    search = "",
    status = "ALL",
  } = options;

  const where = ["c.tenant_id = ?", "c.deleted_at IS NULL", "l.deleted_at IS NULL"];
  const params = [tenantId];

  if (counsellorId && counsellorId !== "all") {
    where.push("c.counsellor_id = ?");
    params.push(Number(counsellorId));
  }

  const query = `
    SELECT 
      c.id,
      c.public_id,
      c.tenant_id,
      c.lead_id,
      c.counsellor_id,
      c.direction,
      DATE_FORMAT(c.call_date, '%Y-%m-%d') AS call_date,
      c.call_time,
      c.duration_seconds,
      c.status,
      c.outcome,
      c.notes,
      l.public_id AS lead_public_id,
      l.fields_json AS lead_fields_json,
      l.status AS lead_status,
      COALESCE(u.name, 'AI Voice Bot') AS counsellor_name,
      COALESCE(u.email, 'ai@solmento.internal') AS counsellor_email
    FROM calls c
    INNER JOIN leads l ON l.id = c.lead_id AND l.tenant_id = c.tenant_id
    LEFT JOIN users u ON u.id = c.counsellor_id
    WHERE ${where.join(" AND ")}
    ORDER BY c.call_date DESC, c.created_at DESC
  `;

  const [rows] = await pool.execute(query, params);

  // Fetch assigned leads for the counsellor to enable logging calls
  const leadWhere = ["leads.tenant_id = ?", "leads.deleted_at IS NULL"];
  const leadParams = [tenantId];
  if (counsellorId && counsellorId !== "all") {
    leadWhere.push("leads.assigned_to_user_id = ?");
    leadParams.push(Number(counsellorId));
  }
  const [assignedLeadRows] = await pool.execute(
    `SELECT id, public_id, fields_json, status, source FROM leads WHERE ${leadWhere.join(" AND ")} ORDER BY updated_at DESC`,
    leadParams,
  );

  const assignedLeads = assignedLeadRows.map((r) => {
    const fields = parseJsonSafe(r.fields_json, {});
    return {
      id: r.id,
      publicId: r.public_id,
      name: fields.name || fields.fullName || `Lead #${r.id}`,
      phone: fields.phone || "",
      course: Array.isArray(fields.coursesInterested)
        ? fields.coursesInterested.join(", ")
        : fields.coursesInterested || "-",
      status: r.status,
    };
  });

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  function formatDuration(sec) {
    const s = Number(sec || 0);
    if (s <= 0) return "0s";
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m === 0) return `${rem}s`;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }

  const allCalls = rows.map((r) => {
    const fields = parseJsonSafe(r.lead_fields_json, {});
    const leadName = fields.name || fields.fullName || fields.student_name || `Lead #${r.lead_id}`;
    const leadCourse = Array.isArray(fields.coursesInterested)
      ? fields.coursesInterested.join(", ")
      : fields.coursesInterested || fields.course || "-";

    const isToday = r.call_date === todayStr;
    const isScheduled = r.status === "SCHEDULED" || r.call_date > todayStr;
    const isRecent = !isScheduled;

    let group = "recent";
    if (isToday) {
      group = "today";
    } else if (isScheduled) {
      group = "upcoming";
    }

    return {
      id: r.public_id || String(r.id),
      databaseId: r.id,
      leadId: r.lead_id,
      leadPublicId: r.lead_public_id,
      leadName,
      leadPhone: fields.phone || "",
      leadCourse,
      leadStatus: r.lead_status,
      counsellorId: r.counsellor_id,
      counsellorName: r.counsellor_name,
      direction: r.direction || "OUTBOUND",
      callDate: r.call_date,
      callTime: r.call_time,
      durationSeconds: r.duration_seconds,
      durationFormatted: formatDuration(r.duration_seconds),
      status: r.status,
      outcome: r.outcome,
      notes: r.notes || "",
      createdAt: r.created_at,
      group,
      isToday,
      isUpcoming: isScheduled,
    };
  });

  let filtered = allCalls;
  if (search && search.trim()) {
    const s = search.trim().toLowerCase();
    filtered = filtered.filter(
      (c) =>
        c.leadName.toLowerCase().includes(s) ||
        c.outcome.toLowerCase().includes(s) ||
        c.notes.toLowerCase().includes(s) ||
        c.counsellorName.toLowerCase().includes(s) ||
        c.leadPhone.includes(s),
    );
  }

  if (status && status !== "ALL") {
    filtered = filtered.filter((c) => c.status === status);
  }

  const groups = {
    today: filtered.filter((c) => c.isToday),
    upcoming: filtered.filter((c) => c.isUpcoming),
    recent: filtered.filter((c) => !c.isUpcoming),
  };

  const counts = {
    total: filtered.length,
    today: groups.today.length,
    upcoming: groups.upcoming.length,
    recent: groups.recent.length,
  };

  return {
    calls: filtered,
    groups,
    counts,
    assignedLeads,
  };
}

export async function createCall(tenantId, payload, userContext) {
  const {
    leadId,
    direction = "OUTBOUND",
    callDate,
    callTime,
    durationSeconds = 0,
    status = "COMPLETED",
    outcome = "Interested",
    notes = "",
  } = payload;

  if (!leadId) throw new HttpError(400, "Student lead selection is required.");

  const isNumeric = /^\d+$/.test(String(leadId));
  const query = isNumeric
    ? "SELECT id, public_id, tenant_id, assigned_to_user_id, fields_json FROM leads WHERE id = ? AND tenant_id = ?"
    : "SELECT id, public_id, tenant_id, assigned_to_user_id, fields_json FROM leads WHERE public_id = ? AND tenant_id = ?";

  const [[lead]] = await pool.execute(query, [leadId, tenantId]);
  if (!lead) throw new HttpError(404, "Lead not found.");

  // Enforce counsellor scoping
  if (userContext.role === "COUNSELLOR") {
    const currentUserId = Number(userContext.userId || userContext.sub);
    if (Number(lead.assigned_to_user_id) !== currentUserId) {
      throw new HttpError(403, "You can only log calls for your assigned leads.");
    }
  }

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const finalDate = callDate ? String(callDate).slice(0, 10) : todayStr;
  const finalTime = callTime || "10:00 AM";
  const finalStatus = ["COMPLETED", "MISSED", "SCHEDULED", "BUSY", "FAILED"].includes(
    String(status).toUpperCase(),
  )
    ? String(status).toUpperCase()
    : "COMPLETED";
  const finalDirection = String(direction).toUpperCase() === "INBOUND" ? "INBOUND" : "OUTBOUND";
  const finalDuration = Math.max(0, parseInt(durationSeconds, 10) || 0);

  const publicId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const counsellorId = Number(userContext.userId || userContext.sub);

  const [insertResult] = await pool.execute(
    `INSERT INTO calls (public_id, tenant_id, lead_id, counsellor_id, direction, call_date, call_time, duration_seconds, status, outcome, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      publicId,
      tenantId,
      lead.id,
      counsellorId,
      finalDirection,
      finalDate,
      finalTime,
      finalDuration,
      finalStatus,
      outcome || "Interested",
      notes || "",
    ],
  );

  // Also update last_contacted_at on the lead
  await pool.execute(
    "UPDATE leads SET last_contacted_at = NOW(), updated_at = NOW() WHERE id = ? AND tenant_id = ?",
    [lead.id, tenantId],
  );

  if (finalStatus === "SCHEDULED" && counsellorId) {
    createNotification({
      tenantId,
      recipientUserId: counsellorId,
      actorUserId: userContext.userId || userContext.sub,
      type: "CALL_SCHEDULED",
      title: "Call Scheduled",
      message: `Call scheduled with student for ${finalDate} at ${finalTime}.`,
      module: "Calls",
      entityType: "call",
      entityId: publicId,
      priority: "INFO",
    }).catch(() => {});
  } else if (finalStatus === "MISSED" && counsellorId) {
    createNotification({
      tenantId,
      recipientUserId: counsellorId,
      actorUserId: userContext.userId || userContext.sub,
      type: "CALL_MISSED",
      title: "Missed Call Alert",
      message: `Inbound call from student lead #${lead.public_id || lead.id} was missed.`,
      module: "Calls",
      entityType: "call",
      entityId: publicId,
      priority: "WARNING",
    }).catch(() => {});
  }

  return {
    id: publicId,
    databaseId: insertResult.insertId,
    leadId: lead.id,
    leadPublicId: lead.public_id,
    counsellorId,
    direction: finalDirection,
    callDate: finalDate,
    callTime: finalTime,
    durationSeconds: finalDuration,
    status: finalStatus,
    outcome: outcome || "Interested",
    notes: notes || "",
  };
}

export async function getCounsellorPerformanceData(
  tenantId,
  counsellorUserId,
  options = {},
) {
  const cid = Number(counsellorUserId);
  const { startDate, endDate } = options;

  let dateFilter = "";
  const params = [tenantId, cid];
  if (startDate && endDate) {
    dateFilter = " AND DATE(created_at) >= ? AND DATE(created_at) <= ?";
    params.push(startDate, endDate);
  }

  // 1. Counsellor details
  const [[counsellor]] = await pool.execute(
    "SELECT id, name, email, designation, department, status FROM users WHERE id = ? AND tenant_id = ?",
    [cid, tenantId],
  );

  // 2. Leads metrics
  const [[leadStats]] = await pool.execute(
    `SELECT 
       COUNT(*) AS total_leads,
       SUM(CASE WHEN UPPER(status) = 'NEW' THEN 1 ELSE 0 END) AS new_leads,
       SUM(CASE WHEN UPPER(status) = 'CONTACTED' THEN 1 ELSE 0 END) AS contacted_leads,
       SUM(CASE WHEN UPPER(status) = 'QUALIFIED' THEN 1 ELSE 0 END) AS qualified_leads,
       SUM(CASE WHEN UPPER(status) = 'CONVERTED' THEN 1 ELSE 0 END) AS converted_leads,
       SUM(CASE WHEN UPPER(status) = 'LOST' THEN 1 ELSE 0 END) AS lost_leads
     FROM leads
     WHERE tenant_id = ? AND assigned_to_user_id = ? ${dateFilter}`,
    params,
  );

  const totalLeads = Number(leadStats?.total_leads || 0);
  const contactedLeads = Number(leadStats?.contacted_leads || 0);
  const qualifiedLeads = Number(leadStats?.qualified_leads || 0);
  const convertedLeads = Number(leadStats?.converted_leads || 0);
  const newLeads = Number(leadStats?.new_leads || 0);
  const lostLeads = Number(leadStats?.lost_leads || 0);

  const conversionRate =
    totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;
  const contactRate =
    totalLeads > 0
      ? Math.round(
          ((contactedLeads + qualifiedLeads + convertedLeads) / totalLeads) *
            100,
        )
      : 0;

  // 3. Calls metrics
  let callDateFilter = "";
  const callParams = [tenantId, cid];
  if (startDate && endDate) {
    callDateFilter = " AND call_date >= ? AND call_date <= ?";
    callParams.push(startDate, endDate);
  }

  const [[callStats]] = await pool.execute(
    `SELECT 
       COUNT(*) AS total_calls,
       SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_calls,
       SUM(CASE WHEN status = 'SCHEDULED' THEN 1 ELSE 0 END) AS scheduled_calls,
       SUM(CASE WHEN status = 'MISSED' THEN 1 ELSE 0 END) AS missed_calls,
       COALESCE(SUM(duration_seconds), 0) AS total_duration_seconds,
       COALESCE(AVG(CASE WHEN duration_seconds > 0 THEN duration_seconds ELSE NULL END), 0) AS avg_duration_seconds
     FROM calls
     WHERE tenant_id = ? AND counsellor_id = ? ${callDateFilter}`,
    callParams,
  );

  const totalCalls = Number(callStats?.total_calls || 0);
  const completedCalls = Number(callStats?.completed_calls || 0);
  const scheduledCalls = Number(callStats?.scheduled_calls || 0);
  const missedCalls = Number(callStats?.missed_calls || 0);
  const totalDurationSeconds = Number(callStats?.total_duration_seconds || 0);
  const avgDurationSeconds = Math.round(
    Number(callStats?.avg_duration_seconds || 0),
  );

  // 4. Conversations metrics
  const [[convStats]] = await pool.execute(
    `SELECT COUNT(DISTINCT c.id) AS total_convs,
            SUM(CASE WHEN UPPER(COALESCE(c.status, 'OPEN')) = 'OPEN' THEN 1 ELSE 0 END) AS open_convs,
            SUM(CASE WHEN UPPER(c.status) = 'CLOSED' THEN 1 ELSE 0 END) AS closed_convs
     FROM conversations c
     INNER JOIN leads l ON l.tenant_id = c.tenant_id AND l.visitor_id = c.visitor_id
     WHERE l.tenant_id = ? AND l.assigned_to_user_id = ? ${
       dateFilter
         ? " AND DATE(l.created_at) >= ? AND DATE(l.created_at) <= ?"
         : ""
     }`,
    params,
  );

  const totalConversations = Number(convStats?.total_convs || 0);
  const openConversations = Number(convStats?.open_convs || 0);

  // 5. Follow-ups metrics
  const [assignedLeadRows] = await pool.execute(
    "SELECT id, fields_json FROM leads WHERE tenant_id = ? AND assigned_to_user_id = ?",
    [tenantId, cid],
  );
  let totalFollowUps = 0;
  let completedFollowUps = 0;
  let pendingFollowUps = 0;

  for (const row of assignedLeadRows) {
    const fields = parseJsonSafe(row.fields_json, {});
    const fus = Array.isArray(fields.follow_ups) ? fields.follow_ups : [];
    for (const f of fus) {
      totalFollowUps++;
      if (f.status === "COMPLETED") completedFollowUps++;
      else pendingFollowUps++;
    }
  }

  // 6. 7-Day Activity Trend
  const [dailyLeads] = await pool.execute(
    `SELECT DATE(created_at) AS day_date, COUNT(*) AS count 
     FROM leads 
     WHERE tenant_id = ? AND assigned_to_user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
     GROUP BY DATE(created_at)`,
    [tenantId, cid],
  );
  const [dailyCalls] = await pool.execute(
    `SELECT call_date AS day_date, COUNT(*) AS count 
     FROM calls 
     WHERE tenant_id = ? AND counsellor_id = ? AND call_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
     GROUP BY call_date`,
    [tenantId, cid],
  );

  const now = new Date();
  const MONTH_SHORT = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const activityTrend = [];
  const leadsByDate = {};
  for (const r of dailyLeads) {
    const dStr =
      r.day_date instanceof Date
        ? r.day_date.toISOString().slice(0, 10)
        : String(r.day_date).slice(0, 10);
    leadsByDate[dStr] = Number(r.count || 0);
  }
  const callsByDate = {};
  for (const r of dailyCalls) {
    const dStr =
      r.day_date instanceof Date
        ? r.day_date.toISOString().slice(0, 10)
        : String(r.day_date).slice(0, 10);
    callsByDate[dStr] = Number(r.count || 0);
  }

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    activityTrend.push({
      date: `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`,
      isoDate: iso,
      leads: leadsByDate[iso] || 0,
      calls: callsByDate[iso] || 0,
    });
  }

  // 7. Funnel stages
  const funnelStages = [
    { label: "Assigned Leads", count: totalLeads, color: "#3b82f6" },
    {
      label: "Contacted",
      count: contactedLeads + qualifiedLeads + convertedLeads,
      color: "#10b981",
    },
    {
      label: "Qualified",
      count: qualifiedLeads + convertedLeads,
      color: "#8b5cf6",
    },
    { label: "Converted", count: convertedLeads, color: "#0ea5e9" },
  ];

  return {
    counsellor: counsellor || { name: "Counsellor", email: "" },
    summary: {
      totalLeads,
      contactedLeads,
      qualifiedLeads,
      convertedLeads,
      lostLeads,
      newLeads,
      conversionRate,
      contactRate,
      totalConversations,
      openConversations,
      totalCalls,
      completedCalls,
      scheduledCalls,
      missedCalls,
      totalDurationSeconds,
      avgDurationSeconds,
      totalFollowUps,
      completedFollowUps,
      pendingFollowUps,
    },
    funnelStages,
    activityTrend,
    statusBreakdown: [
      { status: "New", key: "NEW", count: newLeads, color: "#3b82f6" },
      {
        status: "Contacted",
        key: "CONTACTED",
        count: contactedLeads,
        color: "#10b981",
      },
      {
        status: "Qualified",
        key: "QUALIFIED",
        count: qualifiedLeads,
        color: "#8b5cf6",
      },
      {
        status: "Converted",
        key: "CONVERTED",
        count: convertedLeads,
        color: "#0ea5e9",
      },
      { status: "Lost", key: "LOST", count: lostLeads, color: "#ef4444" },
    ],
  };
}

const DEFAULT_WEEKLY_SCHEDULE = [
  { day: "Monday", enabled: true, startTime: "09:00", endTime: "18:00" },
  { day: "Tuesday", enabled: true, startTime: "09:00", endTime: "18:00" },
  { day: "Wednesday", enabled: true, startTime: "09:00", endTime: "18:00" },
  { day: "Thursday", enabled: true, startTime: "09:00", endTime: "18:00" },
  { day: "Friday", enabled: true, startTime: "09:00", endTime: "18:00" },
  { day: "Saturday", enabled: true, startTime: "10:00", endTime: "15:00" },
  { day: "Sunday", enabled: false, startTime: "09:00", endTime: "18:00" },
];

export async function getCounsellorAvailability(tenantId, counsellorUserId) {
  const [[user]] = await pool.execute(
    "SELECT id, name, email, designation, role FROM users WHERE id = ? AND tenant_id = ? LIMIT 1",
    [counsellorUserId, tenantId],
  );
  if (!user) throw new HttpError(404, "Counsellor not found.");

  const [[record]] = await pool.execute(
    "SELECT id, tenant_id, user_id, live_status, schedule_json, leaves_json, updated_at FROM counsellor_availability WHERE tenant_id = ? AND user_id = ? LIMIT 1",
    [tenantId, counsellorUserId],
  );

  let liveStatus = "ONLINE";
  let schedule = DEFAULT_WEEKLY_SCHEDULE;
  let leaves = [];

  if (record) {
    liveStatus = record.live_status || "ONLINE";
    schedule = parseJsonSafe(record.schedule_json, DEFAULT_WEEKLY_SCHEDULE);
    leaves = parseJsonSafe(record.leaves_json, []);
  }

  return {
    counsellor: {
      id: user.id,
      name: user.name,
      email: user.email,
      designation: user.designation,
      role: user.role,
    },
    liveStatus,
    schedule,
    leaves,
    updatedAt: record?.updated_at || null,
  };
}

export async function updateCounsellorLiveStatus(tenantId, counsellorUserId, newStatus) {
  const normalized = String(newStatus).toUpperCase();
  if (!["ONLINE", "AWAY", "OFFLINE"].includes(normalized)) {
    throw new HttpError(400, "Invalid status. Must be ONLINE, AWAY, or OFFLINE.");
  }

  const [[user]] = await pool.execute(
    "SELECT id FROM users WHERE id = ? AND tenant_id = ? LIMIT 1",
    [counsellorUserId, tenantId],
  );
  if (!user) throw new HttpError(404, "Counsellor not found.");

  await pool.execute(
    `INSERT INTO counsellor_availability (tenant_id, user_id, live_status, schedule_json, leaves_json)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE live_status = VALUES(live_status), updated_at = NOW()`,
    [
      tenantId,
      counsellorUserId,
      normalized,
      JSON.stringify(DEFAULT_WEEKLY_SCHEDULE),
      JSON.stringify([]),
    ],
  );

  return getCounsellorAvailability(tenantId, counsellorUserId);
}

export async function updateCounsellorSchedule(tenantId, counsellorUserId, schedulePayload) {
  if (!Array.isArray(schedulePayload)) {
    throw new HttpError(400, "Schedule must be an array of daily schedules.");
  }

  const [[user]] = await pool.execute(
    "SELECT id FROM users WHERE id = ? AND tenant_id = ? LIMIT 1",
    [counsellorUserId, tenantId],
  );
  if (!user) throw new HttpError(404, "Counsellor not found.");

  const sanitized = schedulePayload.map((item) => ({
    day: String(item.day || ""),
    enabled: Boolean(item.enabled),
    startTime: item.startTime || "09:00",
    endTime: item.endTime || "18:00",
  }));

  await pool.execute(
    `INSERT INTO counsellor_availability (tenant_id, user_id, live_status, schedule_json, leaves_json)
     VALUES (?, ?, 'ONLINE', ?, ?)
     ON DUPLICATE KEY UPDATE schedule_json = VALUES(schedule_json), updated_at = NOW()`,
    [tenantId, counsellorUserId, JSON.stringify(sanitized), JSON.stringify([])],
  );

  return getCounsellorAvailability(tenantId, counsellorUserId);
}

export async function addCounsellorLeave(tenantId, counsellorUserId, leavePayload) {
  const { title, startDate, endDate, type = "HOLIDAY", note = "" } = leavePayload || {};

  if (!title || !title.trim()) throw new HttpError(400, "Leave / Holiday title is required.");
  if (!startDate) throw new HttpError(400, "Start date is required.");

  const [[user]] = await pool.execute(
    "SELECT id FROM users WHERE id = ? AND tenant_id = ? LIMIT 1",
    [counsellorUserId, tenantId],
  );
  if (!user) throw new HttpError(404, "Counsellor not found.");

  const [[record]] = await pool.execute(
    "SELECT leaves_json FROM counsellor_availability WHERE tenant_id = ? AND user_id = ? LIMIT 1",
    [tenantId, counsellorUserId],
  );

  const leaves = record ? parseJsonSafe(record.leaves_json, []) : [];
  const newLeave = {
    id: `leave_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: title.trim(),
    startDate: String(startDate).slice(0, 10),
    endDate: endDate ? String(endDate).slice(0, 10) : String(startDate).slice(0, 10),
    type: ["HOLIDAY", "LEAVE", "VACATION", "SICK"].includes(String(type).toUpperCase())
      ? String(type).toUpperCase()
      : "HOLIDAY",
    note: note ? note.trim() : "",
    createdAt: new Date().toISOString(),
  };

  leaves.unshift(newLeave);

  await pool.execute(
    `INSERT INTO counsellor_availability (tenant_id, user_id, live_status, schedule_json, leaves_json)
     VALUES (?, ?, 'ONLINE', ?, ?)
     ON DUPLICATE KEY UPDATE leaves_json = VALUES(leaves_json), updated_at = NOW()`,
    [
      tenantId,
      counsellorUserId,
      JSON.stringify(DEFAULT_WEEKLY_SCHEDULE),
      JSON.stringify(leaves),
    ],
  );

  return getCounsellorAvailability(tenantId, counsellorUserId);
}

export async function deleteCounsellorLeave(tenantId, counsellorUserId, leaveId) {
  if (!leaveId) throw new HttpError(400, "Leave ID is required.");

  const [[user]] = await pool.execute(
    "SELECT id FROM users WHERE id = ? AND tenant_id = ? LIMIT 1",
    [counsellorUserId, tenantId],
  );
  if (!user) throw new HttpError(404, "Counsellor not found.");

  const [[record]] = await pool.execute(
    "SELECT leaves_json FROM counsellor_availability WHERE tenant_id = ? AND user_id = ? LIMIT 1",
    [tenantId, counsellorUserId],
  );

  if (!record) return getCounsellorAvailability(tenantId, counsellorUserId);

  let leaves = parseJsonSafe(record.leaves_json, []);
  leaves = leaves.filter((l) => String(l.id) !== String(leaveId));

  await pool.execute(
    "UPDATE counsellor_availability SET leaves_json = ?, updated_at = NOW() WHERE tenant_id = ? AND user_id = ?",
    [JSON.stringify(leaves), tenantId, counsellorUserId],
  );

  return getCounsellorAvailability(tenantId, counsellorUserId);
}

function formatAdminRelativeTime(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return "";
  const diffSec = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${dt.getDate()} ${monthNames[dt.getMonth()]}`;
}

export async function getAdminDashboardData(tenantId, options = {}) {
  const now = new Date();
  const formatYmd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayStr = formatYmd(now);

  let startStr = "";
  let endStr = "";

  if (options.startDate && options.endDate) {
    startStr = String(options.startDate).slice(0, 10);
    endStr = String(options.endDate).slice(0, 10);
  } else if (options.fromDate && options.toDate) {
    startStr = String(options.fromDate).slice(0, 10);
    endStr = String(options.toDate).slice(0, 10);
  } else if (options.period === "30d" || options.period === "Last 30 days") {
    const dStart = new Date(now);
    dStart.setDate(dStart.getDate() - 29);
    startStr = formatYmd(dStart);
    endStr = todayStr;
  } else if (options.period === "month" || options.period === "This month") {
    startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    endStr = todayStr;
  } else {
    // Default: Last 7 days
    const dStart = new Date(now);
    dStart.setDate(dStart.getDate() - 6);
    startStr = formatYmd(dStart);
    endStr = todayStr;
  }

  const startEpoch = new Date(`${startStr}T00:00:00Z`).getTime();
  const endEpoch = new Date(`${endStr}T00:00:00Z`).getTime();
  const spanDays = Math.max(1, Math.round((endEpoch - startEpoch) / (1000 * 60 * 60 * 24)) + 1);

  const priorEndEpoch = startEpoch - 24 * 60 * 60 * 1000;
  const priorStartEpoch = priorEndEpoch - (spanDays - 1) * 24 * 60 * 60 * 1000;
  const priorStartStr = formatYmd(new Date(priorStartEpoch));
  const priorEndStr = formatYmd(new Date(priorEndEpoch));

  const compLabel =
    spanDays === 1 ? "vs yesterday" : spanDays === 7 ? "vs last week" : "vs previous period";

  function computeDelta(current, previous) {
    const curr = Number(current) || 0;
    const prev = Number(previous) || 0;
    if (prev === 0) {
      return {
        change: curr === 0 ? "+0.0%" : "+100%",
        deltaType: "up",
        prefix: curr >= 0 ? "+" : "-",
      };
    }
    const diff = curr - prev;
    const pct = Number(((diff / prev) * 100).toFixed(1));
    return {
      change: `${diff >= 0 ? "+" : ""}${pct}%`,
      deltaType: diff >= 0 ? "up" : "down",
      prefix: diff >= 0 ? "+" : "-",
    };
  }

  // 1. KPI: New Leads Today
  const [[todayLeadsRow]] = await pool.execute(
    "SELECT COUNT(*) AS cnt FROM leads WHERE tenant_id = ? AND DATE(created_at) = CURDATE()",
    [tenantId],
  );
  const todayLeads = Number(todayLeadsRow?.cnt || 0);

  const [[yestLeadsRow]] = await pool.execute(
    "SELECT COUNT(*) AS cnt FROM leads WHERE tenant_id = ? AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)",
    [tenantId],
  );
  const yestLeads = Number(yestLeadsRow?.cnt || 0);
  const todayLeadsDelta = computeDelta(todayLeads, yestLeads);

  // Sparkline last 7 days for leads
  const [dailyLeadRows] = await pool.execute(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as dStr, COUNT(*) as cnt
     FROM leads
     WHERE tenant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
     GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')`,
    [tenantId],
  );
  const leadDailyMap = {};
  for (const r of dailyLeadRows) leadDailyMap[r.dStr] = Number(r.cnt || 0);
  const last7DaysLeads = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    last7DaysLeads.push(leadDailyMap[formatYmd(d)] || 0);
  }

  // 2. KPI: Active Conversations
  const [[activeConvsRow]] = await pool.execute(
    "SELECT COUNT(*) AS cnt FROM conversations WHERE tenant_id = ? AND status = 'OPEN'",
    [tenantId],
  );
  const activeConvs = Number(activeConvsRow?.cnt || 0);

  const [[priorActiveRow]] = await pool.execute(
    "SELECT COUNT(*) AS cnt FROM conversations WHERE tenant_id = ? AND status = 'OPEN' AND DATE(created_at) <= DATE_SUB(CURDATE(), INTERVAL 1 DAY)",
    [tenantId],
  );
  const priorActive = Number(priorActiveRow?.cnt || 0);
  const activeDelta = computeDelta(activeConvs, priorActive);

  // Sparkline for conversations
  const [dailyConvRows] = await pool.execute(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as dStr, COUNT(*) as cnt
     FROM conversations
     WHERE tenant_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
     GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')`,
    [tenantId],
  );
  const convDailyMap = {};
  for (const r of dailyConvRows) convDailyMap[r.dStr] = Number(r.cnt || 0);
  const last7DaysConvs = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    last7DaysConvs.push(convDailyMap[formatYmd(d)] || 0);
  }

  // 3. KPI: AI Resolution Rate
  const [[aiResRow]] = await pool.execute(
    `SELECT COUNT(c.id) AS total_convs,
            SUM(CASE WHEN l.assigned_to_user_id IS NULL OR l.assigned_to_user_id = 0 THEN 1 ELSE 0 END) AS ai_resolved
     FROM conversations c
     LEFT JOIN leads l ON l.visitor_id = c.visitor_id AND l.tenant_id = c.tenant_id
     WHERE c.tenant_id = ? AND DATE(c.created_at) >= ? AND DATE(c.created_at) <= ?`,
    [tenantId, startStr, endStr],
  );
  const totalConvsPeriod = Number(aiResRow?.total_convs || 0);
  const aiResolvedPeriod = Number(aiResRow?.ai_resolved || 0);
  const aiResolutionRate = totalConvsPeriod > 0 ? Math.round((aiResolvedPeriod / totalConvsPeriod) * 100) : 0;

  const [[priorAiRow]] = await pool.execute(
    `SELECT COUNT(c.id) AS total_convs,
            SUM(CASE WHEN l.assigned_to_user_id IS NULL OR l.assigned_to_user_id = 0 THEN 1 ELSE 0 END) AS ai_resolved
     FROM conversations c
     LEFT JOIN leads l ON l.visitor_id = c.visitor_id AND l.tenant_id = c.tenant_id
     WHERE c.tenant_id = ? AND DATE(c.created_at) >= ? AND DATE(c.created_at) <= ?`,
    [tenantId, priorStartStr, priorEndStr],
  );
  const priorTotalConvs = Number(priorAiRow?.total_convs || 0);
  const priorAiResolved = Number(priorAiRow?.ai_resolved || 0);
  const priorAiRate = priorTotalConvs > 0 ? Math.round((priorAiResolved / priorTotalConvs) * 100) : 0;
  const aiResolutionDelta = computeDelta(aiResolutionRate, priorAiRate);

  const aiSparkline = [
    Math.max(aiResolutionRate - 5, 0),
    Math.max(aiResolutionRate - 3, 0),
    Math.max(aiResolutionRate - 4, 0),
    Math.max(aiResolutionRate - 2, 0),
    Math.max(aiResolutionRate - 1, 0),
    aiResolutionRate,
    aiResolutionRate,
  ];

  // 4. KPI: Total Leads in Period
  const [[totLeadsRow]] = await pool.execute(
    "SELECT COUNT(*) AS cnt FROM leads WHERE tenant_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
    [tenantId, startStr, endStr],
  );
  const totalLeads = Number(totLeadsRow?.cnt || 0);

  const [[priorTotLeadsRow]] = await pool.execute(
    "SELECT COUNT(*) AS cnt FROM leads WHERE tenant_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
    [tenantId, priorStartStr, priorEndStr],
  );
  const priorTotalLeads = Number(priorTotLeadsRow?.cnt || 0);
  const totalLeadsDelta = computeDelta(totalLeads, priorTotalLeads);

  // 5. KPI: Calls Today
  let callsToday = 0;
  let callsYest = 0;
  const last7DaysCalls = [0, 0, 0, 0, 0, 0, 0];
  try {
    const [[callTodayRow]] = await pool.execute(
      "SELECT COUNT(*) AS cnt FROM calls WHERE tenant_id = ? AND DATE(call_date) = CURDATE()",
      [tenantId],
    );
    callsToday = Number(callTodayRow?.cnt || 0);

    const [[callYestRow]] = await pool.execute(
      "SELECT COUNT(*) AS cnt FROM calls WHERE tenant_id = ? AND DATE(call_date) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)",
      [tenantId],
    );
    callsYest = Number(callYestRow?.cnt || 0);

    const [dailyCallRows] = await pool.execute(
      `SELECT DATE_FORMAT(call_date, '%Y-%m-%d') as dStr, COUNT(*) as cnt
       FROM calls
       WHERE tenant_id = ? AND call_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE_FORMAT(call_date, '%Y-%m-%d')`,
      [tenantId],
    );
    const callDailyMap = {};
    for (const r of dailyCallRows) callDailyMap[r.dStr] = Number(r.cnt || 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      last7DaysCalls[6 - i] = callDailyMap[formatYmd(d)] || 0;
    }
  } catch (err) {
    // fallback if calls table empty
  }
  const callsDelta = computeDelta(callsToday, callsYest);

  // 6. KPI: Conversion Rate in Period
  const [[convertedRow]] = await pool.execute(
    "SELECT COUNT(*) AS cnt FROM leads WHERE tenant_id = ? AND status = 'CONVERTED' AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
    [tenantId, startStr, endStr],
  );
  const convertedLeads = Number(convertedRow?.cnt || 0);
  const conversionRate = totalLeads > 0 ? Number(((convertedLeads / totalLeads) * 100).toFixed(1)) : 0;

  const [[priorConvRow]] = await pool.execute(
    "SELECT COUNT(*) AS cnt FROM leads WHERE tenant_id = ? AND status = 'CONVERTED' AND DATE(created_at) >= ? AND DATE(created_at) <= ?",
    [tenantId, priorStartStr, priorEndStr],
  );
  const priorConverted = Number(priorConvRow?.cnt || 0);
  const priorConvRate = priorTotalLeads > 0 ? Number(((priorConverted / priorTotalLeads) * 100).toFixed(1)) : 0;
  const conversionDelta = computeDelta(conversionRate, priorConvRate);

  const kpis = [
    {
      id: "newLeadsToday",
      title: "New Leads Today",
      value: String(todayLeads),
      change: todayLeadsDelta.change,
      deltaType: todayLeadsDelta.deltaType,
      comparison: "vs yesterday",
      icon: "UsersRound",
      bg: "bg-blue-50",
      color: "text-blue-600",
      border: "border-t-blue-500",
      line: "#3b82f6",
      data: last7DaysLeads,
    },
    {
      id: "activeConversations",
      title: "Active Conversations",
      value: String(activeConvs),
      change: activeDelta.change,
      deltaType: activeDelta.deltaType,
      comparison: "vs yesterday",
      icon: "MessagesSquare",
      bg: "bg-sky-50",
      color: "text-sky-600",
      border: "border-t-sky-500",
      line: "#0ea5e9",
      data: last7DaysConvs,
    },
    {
      id: "aiResolutionRate",
      title: "AI Resolution Rate",
      value: `${aiResolutionRate}%`,
      change: aiResolutionDelta.change,
      deltaType: aiResolutionDelta.deltaType,
      comparison: "vs yesterday",
      icon: "Sparkles",
      bg: "bg-violet-50",
      color: "text-violet-600",
      border: "border-t-violet-500",
      line: "#8b5cf6",
      data: aiSparkline,
    },
    {
      id: "totalLeads",
      title: "Total Leads",
      value: totalLeads.toLocaleString(),
      change: totalLeadsDelta.change,
      deltaType: totalLeadsDelta.deltaType,
      comparison: compLabel,
      icon: "Database",
      bg: "bg-emerald-50",
      color: "text-emerald-600",
      border: "border-t-emerald-500",
      line: "#10b981",
      data: last7DaysLeads,
    },
    {
      id: "callsToday",
      title: "Calls Today",
      value: String(callsToday),
      change: callsDelta.change,
      deltaType: callsDelta.deltaType,
      comparison: "vs yesterday",
      icon: "Phone",
      bg: "bg-blue-50",
      color: "text-blue-600",
      border: "border-t-blue-500",
      line: "#2563eb",
      data: last7DaysCalls,
    },
    {
      id: "conversionRate",
      title: "Conversion Rate",
      value: `${conversionRate}%`,
      change: conversionDelta.change,
      deltaType: conversionDelta.deltaType,
      comparison: compLabel,
      icon: "BarChart3",
      bg: "bg-purple-50",
      color: "text-purple-600",
      border: "border-t-purple-500",
      line: "#a855f7",
      data: [0, 0, 0, 0, 0, conversionRate, conversionRate],
    },
  ];

  // 7. Leads Over Time for period
  const [periodLeadRows] = await pool.execute(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as dStr, COUNT(*) as cnt
     FROM leads
     WHERE tenant_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?
     GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
     ORDER BY dStr ASC`,
    [tenantId, startStr, endStr],
  );
  const periodLeadMap = {};
  for (const r of periodLeadRows) periodLeadMap[r.dStr] = Number(r.cnt || 0);

  const leadsOverTimeLabels = [];
  const leadsOverTimeData = [];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const curDateCursor = new Date(startStr);
  const endDateCursor = new Date(endStr);
  while (curDateCursor <= endDateCursor) {
    const dYmd = formatYmd(curDateCursor);
    leadsOverTimeLabels.push(`${curDateCursor.getDate()} ${monthNames[curDateCursor.getMonth()]}`);
    leadsOverTimeData.push(periodLeadMap[dYmd] || 0);
    curDateCursor.setDate(curDateCursor.getDate() + 1);
  }

  // 8. Conversations by Channel
  const [channelRows] = await pool.execute(
    `SELECT channel, COUNT(*) as cnt
     FROM conversations
     WHERE tenant_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?
     GROUP BY channel`,
    [tenantId, startStr, endStr],
  );
  const totalConvs = channelRows.reduce((acc, r) => acc + Number(r.cnt || 0), 0);

  const CHANNEL_DISPLAY = {
    website: { name: "Website Widget", color: "bg-blue-500", hex: "#3b82f6" },
    website_widget: { name: "Website Widget", color: "bg-blue-500", hex: "#3b82f6" },
    chatbot: { name: "Chatbot", color: "bg-emerald-500", hex: "#10b981" },
    whatsapp: { name: "WhatsApp", color: "bg-emerald-500", hex: "#25D366" },
    call: { name: "Calls", color: "bg-violet-500", hex: "#8b5cf6" },
    phone: { name: "Calls", color: "bg-violet-500", hex: "#8b5cf6" },
    direct: { name: "Direct / Manual", color: "bg-amber-500", hex: "#f59e0b" },
    manual: { name: "Direct / Manual", color: "bg-amber-500", hex: "#f59e0b" },
  };

  const channelList = [];
  for (const r of channelRows) {
    const chKey = String(r.channel || "website").toLowerCase();
    const meta = CHANNEL_DISPLAY[chKey] || { name: r.channel || "Other", color: "bg-slate-400", hex: "#94a3b8" };
    const cnt = Number(r.cnt || 0);
    const pct = totalConvs > 0 ? Math.round((cnt / totalConvs) * 100) : 0;
    channelList.push({
      name: meta.name,
      value: `${pct}%`,
      percentage: pct,
      count: cnt,
      color: meta.color,
      hex: meta.hex,
    });
  }
  if (channelList.length === 0) {
    channelList.push({
      name: "Website Widget",
      value: "100%",
      percentage: 100,
      count: 0,
      color: "bg-blue-500",
      hex: "#3b82f6",
    });
  }

  // 9. Conversion Funnel
  const [funnelRows] = await pool.execute(
    `SELECT UPPER(COALESCE(status, 'NEW')) AS status, COUNT(*) AS cnt
     FROM leads
     WHERE tenant_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?
     GROUP BY UPPER(COALESCE(status, 'NEW'))`,
    [tenantId, startStr, endStr],
  );
  const statusMap = { NEW: 0, CONTACTED: 0, QUALIFIED: 0, CONVERTED: 0, LOST: 0 };
  for (const r of funnelRows) {
    statusMap[r.status] = Number(r.cnt || 0);
  }
  const fTotal = totalLeads;
  const fContacted = statusMap.CONTACTED + statusMap.QUALIFIED + statusMap.CONVERTED;
  const fQualified = statusMap.QUALIFIED + statusMap.CONVERTED;
  const fConverted = statusMap.CONVERTED;

  const conversionFunnel = [
    {
      label: "Total Leads",
      count: fTotal,
      width: "100%",
      color: "bg-blue-500",
    },
    {
      label: "Contacted / Engaged",
      count: fContacted,
      width: fTotal > 0 ? `${Math.round((fContacted / fTotal) * 100)}%` : "0%",
      color: "bg-emerald-500",
    },
    {
      label: "Qualified",
      count: fQualified,
      width: fTotal > 0 ? `${Math.round((fQualified / fTotal) * 100)}%` : "0%",
      color: "bg-violet-500",
    },
    {
      label: "Converted (Enrolled)",
      count: fConverted,
      width: fTotal > 0 ? `${Math.round((fConverted / fTotal) * 100)}%` : "0%",
      color: "bg-amber-500",
    },
  ];

  // 10. Needs Attention: Unassigned Leads + Overdue Follow-ups
  const [unassignedRows] = await pool.execute(
    `SELECT id, public_id, source, fields_json, created_at
     FROM leads
     WHERE tenant_id = ? AND (assigned_to_user_id IS NULL OR assigned_to_user_id = 0)
     ORDER BY created_at DESC LIMIT 10`,
    [tenantId],
  );
  const unassignedList = unassignedRows.map((r) => {
    const fields = parseJsonSafe(r.fields_json, {});
    const name = fields.name || `Lead #${r.id}`;
    let text = "New inquiry from admissions chatbot";
    if (fields.coursesInterested) {
      const c = Array.isArray(fields.coursesInterested) ? fields.coursesInterested.join(", ") : fields.coursesInterested;
      text = `Interested in ${c} program`;
    } else if (fields.feesQuery && fields.feesQuery !== "—") {
      text = "Asked about fee structure";
    }
    return {
      id: r.id,
      publicId: r.public_id,
      title: `Inquiry from ${name}`,
      name,
      text,
      time: formatAdminRelativeTime(r.created_at),
      channel: r.source === "call" ? "Call" : "Website",
      status: "Unassigned",
    };
  });

  let overdueList = [];
  try {
    const fuData = await listFollowUps(tenantId);
    overdueList = (fuData?.followUps || [])
      .filter((f) => f.isOverdue)
      .slice(0, 10)
      .map((fu) => ({
        id: fu.id,
        leadId: fu.leadId,
        publicId: fu.leadPublicId,
        title: `Follow-up pending - ${fu.leadName}`,
        name: fu.leadName,
        text: fu.purpose || "Follow-up discussion pending",
        time: `Overdue (${fu.date})`,
        channel: "Call",
        status: "Overdue",
      }));
  } catch (err) {
    // fallback
  }

  // 11. Team Activity (real calls & feedbacks)
  const teamActivity = [];
  try {
    const [callActRows] = await pool.execute(
      `SELECT c.id, c.call_date, c.call_time, c.outcome, c.notes, c.created_at,
              u.name as counsellor_name, l.fields_json
       FROM calls c
       INNER JOIN users u ON u.id = c.counsellor_id
       INNER JOIN leads l ON l.id = c.lead_id
       WHERE c.tenant_id = ?
       ORDER BY c.created_at DESC LIMIT 8`,
      [tenantId],
    );
    for (const r of callActRows) {
      const f = parseJsonSafe(r.fields_json, {});
      const studentName = f.name || "Student";
      const cName = r.counsellor_name || "Counsellor";
      const inits = cName
        .split(" ")
        .filter(Boolean)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      teamActivity.push({
        id: `call_${r.id}`,
        initials: inits || "C",
        name: cName,
        text: r.outcome ? `Call with ${studentName} (${r.outcome})` : `Logged call with ${studentName}`,
        time: formatAdminRelativeTime(r.created_at),
        timestamp: new Date(r.created_at).getTime(),
        tone: "bg-emerald-100 text-emerald-700",
      });
    }
  } catch (err) {
    // fallback
  }

  // 12. Active Counsellors list for assignment
  const [counsellorRows] = await pool.execute(
    "SELECT id, name, email, designation FROM users WHERE tenant_id = ? AND role = 'COUNSELLOR' AND status = 'ACTIVE'",
    [tenantId],
  );
  const counsellors = counsellorRows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    designation: u.designation || "Admissions Counsellor",
  }));

  return {
    period: {
      startDate: startStr,
      endDate: endStr,
      spanDays,
      comparisonLabel: compLabel,
    },
    kpis,
    leadsOverTime: {
      labels: leadsOverTimeLabels,
      data: leadsOverTimeData,
    },
    conversationsByChannel: {
      total: totalConvs,
      channels: channelList,
    },
    conversionFunnel,
    needsAttention: {
      unassigned: unassignedList,
      overdue: overdueList,
      unassignedCount: unassignedList.length,
      overdueCount: overdueList.length,
    },
    teamActivity,
    counsellors,
  };
}

