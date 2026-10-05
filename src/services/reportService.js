import { pool } from "../config/database.js";
import { HttpError } from "../utils/http.js";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatYmd(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(d) {
  const dt = new Date(d);
  const day = String(dt.getDate()).padStart(2, "0");
  const month = MONTH_NAMES[dt.getMonth()];
  const year = dt.getFullYear();
  return `${day} ${month} ${year}`;
}

function computeDelta(current, previous) {
  const curr = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) {
    return {
      change: curr === 0 ? "0%" : "+100%",
      pct: curr === 0 ? 0 : 100,
      deltaType: "up",
      prefix: curr >= 0 ? "+" : "-",
      value: curr,
    };
  }
  const diff = curr - prev;
  const pct = Math.round((diff / prev) * 100);
  return {
    change: `${diff >= 0 ? "+" : ""}${pct}%`,
    pct: Math.abs(pct),
    deltaType: diff >= 0 ? "up" : "down",
    prefix: diff >= 0 ? "+" : "-",
    value: curr,
  };
}

export async function getReportsData(tenantId, options = {}, user = {}) {
  const now = new Date();
  const todayStr = formatYmd(now);

  let startStr = "";
  let endStr = "";

  if (options.startDate && options.endDate) {
    startStr = String(options.startDate).slice(0, 10);
    endStr = String(options.endDate).slice(0, 10);
  } else if (options.period === "today" || options.period === "Today") {
    startStr = todayStr;
    endStr = todayStr;
  } else if (options.period === "7d" || options.period === "Last 7 days") {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    startStr = formatYmd(d);
    endStr = todayStr;
  } else if (options.period === "30d" || options.period === "Last 30 days") {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    startStr = formatYmd(d);
    endStr = todayStr;
  } else if (options.period === "quarter" || options.period === "This quarter") {
    const curQuarter = Math.floor(now.getMonth() / 3);
    const qStart = new Date(now.getFullYear(), curQuarter * 3, 1);
    const qEnd = new Date(now.getFullYear(), (curQuarter + 1) * 3, 0);
    startStr = formatYmd(qStart);
    endStr = formatYmd(qEnd);
  } else {
    // Default: This month (e.g. 01 Sep 2026 - 30 Sep 2026)
    startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    endStr = formatYmd(lastDay);
  }

  const startEpoch = new Date(`${startStr}T00:00:00Z`).getTime();
  const endEpoch = new Date(`${endStr}T23:59:59Z`).getTime();
  const spanDays = Math.max(1, Math.round((endEpoch - startEpoch) / (1000 * 60 * 60 * 24)));

  const priorEndEpoch = startEpoch - 1000;
  const priorStartEpoch = priorEndEpoch - spanDays * 24 * 60 * 60 * 1000 + 1000;
  const priorStartStr = formatYmd(new Date(priorStartEpoch));
  const priorEndStr = formatYmd(new Date(priorEndEpoch));

  const compLabel =
    spanDays === 1
      ? "vs yesterday"
      : spanDays === 7
        ? "vs previous period"
        : "vs previous period";

  const dateRangeLabel = `${formatDisplayDate(startStr)} – ${formatDisplayDate(endStr)}`;

  // Counsellor Filter
  const counsellorIdParam = options.counsellorId;
  const isCounsellorFiltered =
    Boolean(counsellorIdParam) &&
    counsellorIdParam !== "all" &&
    counsellorIdParam !== "";

  // 1. Fetch Counsellors for tenant
  const [counsellors] = await pool.execute(
    `SELECT id, name, employee_id, designation, role
     FROM users
     WHERE tenant_id = ? AND role IN ('HEAD_COUNSELLOR', 'COUNSELLOR') AND status = 'ACTIVE' AND deleted_at IS NULL
     ORDER BY name ASC`,
    [tenantId],
  );

  let targetCounsellorId = null;
  if (isCounsellorFiltered) {
    const found = counsellors.find((c) => String(c.id) === String(counsellorIdParam));
    if (found) targetCounsellorId = found.id;
  }

  // 2. Leads Report
  const leadFilterSql = targetCounsellorId ? "AND assigned_to_user_id = ?" : "";
  const leadFilterParams = targetCounsellorId ? [targetCounsellorId] : [];

  const [[currLeadsRow]] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM leads
     WHERE tenant_id = ? AND deleted_at IS NULL ${leadFilterSql}
       AND created_at >= ? AND created_at <= ?`,
    [tenantId, ...leadFilterParams, `${startStr} 00:00:00`, `${endStr} 23:59:59`],
  );

  const [[priorLeadsRow]] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM leads
     WHERE tenant_id = ? AND deleted_at IS NULL ${leadFilterSql}
       AND created_at >= ? AND created_at <= ?`,
    [tenantId, ...leadFilterParams, `${priorStartStr} 00:00:00`, `${priorEndStr} 23:59:59`],
  );

  const currentLeads = Number(currLeadsRow?.cnt || 0);
  const priorLeads = Number(priorLeadsRow?.cnt || 0);
  const leadsDelta = computeDelta(currentLeads, priorLeads);

  // 3. Conversations Report
  let currConvCount = 0;
  let priorConvCount = 0;

  if (targetCounsellorId) {
    const [[cRow]] = await pool.execute(
      `SELECT COUNT(DISTINCT c.id) AS cnt
       FROM conversations c
       INNER JOIN leads l ON c.visitor_id = l.visitor_id AND c.tenant_id = l.tenant_id
       WHERE c.tenant_id = ? AND l.assigned_to_user_id = ?
         AND c.created_at >= ? AND c.created_at <= ?`,
      [tenantId, targetCounsellorId, `${startStr} 00:00:00`, `${endStr} 23:59:59`],
    );
    currConvCount = Number(cRow?.cnt || 0);

    const [[pRow]] = await pool.execute(
      `SELECT COUNT(DISTINCT c.id) AS cnt
       FROM conversations c
       INNER JOIN leads l ON c.visitor_id = l.visitor_id AND c.tenant_id = l.tenant_id
       WHERE c.tenant_id = ? AND l.assigned_to_user_id = ?
         AND c.created_at >= ? AND c.created_at <= ?`,
      [tenantId, targetCounsellorId, `${priorStartStr} 00:00:00`, `${priorEndStr} 23:59:59`],
    );
    priorConvCount = Number(pRow?.cnt || 0);
  } else {
    const [[cRow]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM conversations
       WHERE tenant_id = ?
         AND created_at >= ? AND created_at <= ?`,
      [tenantId, `${startStr} 00:00:00`, `${endStr} 23:59:59`],
    );
    currConvCount = Number(cRow?.cnt || 0);

    const [[pRow]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM conversations
       WHERE tenant_id = ?
         AND created_at >= ? AND created_at <= ?`,
      [tenantId, `${priorStartStr} 00:00:00`, `${priorEndStr} 23:59:59`],
    );
    priorConvCount = Number(pRow?.cnt || 0);
  }

  const convDelta = computeDelta(currConvCount, priorConvCount);

  // 4. Calls Report
  const callFilterSql = targetCounsellorId ? "AND counsellor_id = ?" : "";
  const callFilterParams = targetCounsellorId ? [targetCounsellorId] : [];

  const [[currCallsRow]] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM calls
     WHERE tenant_id = ? AND deleted_at IS NULL ${callFilterSql}
       AND call_date >= ? AND call_date <= ?`,
    [tenantId, ...callFilterParams, startStr, endStr],
  );

  const [[priorCallsRow]] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM calls
     WHERE tenant_id = ? AND deleted_at IS NULL ${callFilterSql}
       AND call_date >= ? AND call_date <= ?`,
    [tenantId, ...callFilterParams, priorStartStr, priorEndStr],
  );

  const currentCalls = Number(currCallsRow?.cnt || 0);
  const priorCalls = Number(priorCallsRow?.cnt || 0);
  const callsDelta = computeDelta(currentCalls, priorCalls);

  // 5. Team Performance Report
  const currentTeamCount = targetCounsellorId ? 1 : counsellors.length;
  const priorTeamCount = counsellors.length;
  const teamDelta = computeDelta(currentTeamCount, priorTeamCount);

  // 6. Sub-period Sparklines (7 data points across date range)
  const sparklineSteps = 7;
  const intervalMs = (endEpoch - startEpoch) / sparklineSteps;
  const leadSparkline = [];
  const convSparkline = [];
  const callSparkline = [];
  const teamSparkline = [];

  for (let i = 0; i < sparklineSteps; i++) {
    const sTime = new Date(startEpoch + i * intervalMs);
    const eTime = new Date(startEpoch + (i + 1) * intervalMs);
    const sStr = `${formatYmd(sTime)} 00:00:00`;
    const eStr = `${formatYmd(eTime)} 23:59:59`;

    const [[spLeads]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM leads WHERE tenant_id = ? ${leadFilterSql} AND created_at >= ? AND created_at <= ?`,
      [tenantId, ...leadFilterParams, sStr, eStr],
    );
    leadSparkline.push(Number(spLeads?.cnt || 0));

    const [[spConvs]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM conversations WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?`,
      [tenantId, sStr, eStr],
    );
    convSparkline.push(Number(spConvs?.cnt || 0));

    const [[spCalls]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM calls WHERE tenant_id = ? ${callFilterSql} AND call_date >= ? AND call_date <= ?`,
      [tenantId, ...callFilterParams, formatYmd(sTime), formatYmd(eTime)],
    );
    callSparkline.push(Number(spCalls?.cnt || 0));

    teamSparkline.push(currentTeamCount);
  }

  // 7. Leads Trend Chart (Grouping: daily / weekly / monthly)
  const grouping = String(options.grouping || "daily").toLowerCase();
  let trendLabels = [];
  let trendData = [];
  let trendPoints = [];

  if (grouping === "weekly") {
    // Weekly aggregation
    const [rows] = await pool.execute(
      `SELECT YEARWEEK(created_at, 1) as yw, MIN(DATE(created_at)) as min_d, COUNT(*) as cnt
       FROM leads
       WHERE tenant_id = ? ${leadFilterSql} AND created_at >= ? AND created_at <= ?
       GROUP BY YEARWEEK(created_at, 1)
       ORDER BY yw ASC`,
      [tenantId, ...leadFilterParams, `${startStr} 00:00:00`, `${endStr} 23:59:59`],
    );
    const map = new Map(rows.map((r) => [r.yw, { count: Number(r.cnt), date: formatYmd(r.min_d) }]));
    
    // Build weeks
    let cur = new Date(startEpoch);
    while (cur.getTime() <= endEpoch) {
      const dStr = formatYmd(cur);
      const label = `Week of ${MONTH_NAMES[cur.getMonth()]} ${cur.getDate()}`;
      const entry = map.get(dStr) || { count: 0, date: dStr };
      trendLabels.push(label);
      trendData.push(entry.count);
      trendPoints.push({ label, date: dStr, count: entry.count });
      cur.setDate(cur.getDate() + 7);
    }
  } else if (grouping === "monthly") {
    // Monthly aggregation
    const [rows] = await pool.execute(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') as ym, COUNT(*) as cnt
       FROM leads
       WHERE tenant_id = ? ${leadFilterSql} AND created_at >= ? AND created_at <= ?
       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
       ORDER BY ym ASC`,
      [tenantId, ...leadFilterParams, `${startStr} 00:00:00`, `${endStr} 23:59:59`],
    );
    const map = new Map(rows.map((r) => [r.ym, Number(r.cnt)]));

    let cur = new Date(startEpoch);
    while (cur.getTime() <= endEpoch) {
      const ym = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
      const label = `${MONTH_NAMES[cur.getMonth()]} ${cur.getFullYear()}`;
      const count = map.get(ym) || 0;
      trendLabels.push(label);
      trendData.push(count);
      trendPoints.push({ label, date: ym, count });
      cur.setMonth(cur.getMonth() + 1);
    }
  } else {
    // Daily aggregation (default)
    const [rows] = await pool.execute(
      `SELECT DATE(created_at) as dt, COUNT(*) as cnt
       FROM leads
       WHERE tenant_id = ? ${leadFilterSql} AND created_at >= ? AND created_at <= ?
       GROUP BY DATE(created_at)
       ORDER BY dt ASC`,
      [tenantId, ...leadFilterParams, `${startStr} 00:00:00`, `${endStr} 23:59:59`],
    );

    const countsByDate = new Map();
    for (const r of rows) {
      const dStr = formatYmd(r.dt);
      countsByDate.set(dStr, Number(r.cnt || 0));
    }

    const cur = new Date(startEpoch);
    while (cur.getTime() <= endEpoch) {
      const dStr = formatYmd(cur);
      const dayNum = String(cur.getDate()).padStart(2, "0");
      const monStr = MONTH_NAMES[cur.getMonth()];
      const label = `${monStr} ${dayNum}`;
      const count = countsByDate.get(dStr) || 0;
      trendLabels.push(label);
      trendData.push(count);
      trendPoints.push({
        label,
        date: dStr,
        count,
        formattedDate: `${monStr} ${cur.getDate()}, ${cur.getFullYear()}`,
      });
      cur.setDate(cur.getDate() + 1);
    }
  }

  // 8. Report Activity (from platform_records WHERE module = 'reports')
  const [existingRecords] = await pool.execute(
    `SELECT id, title, status, payload_json, created_by_user_id, created_at, updated_at
     FROM platform_records
     WHERE module = 'reports' AND deleted_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.tenantId')) = ?
     ORDER BY id DESC`,
    [String(tenantId)],
  );

  let activityList = existingRecords.map((r) => {
    let payload = r.payload_json;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = {};
      }
    }
    return {
      id: r.id,
      name: r.title,
      dateRange: payload?.dateRange || dateRangeLabel,
      generatedBy: payload?.generatedByName || user.name || "Sagar Kumar",
      status: r.status || "Completed",
      createdAt: r.created_at,
      reportType: payload?.reportType || "all",
    };
  });

  // If no report activity has been recorded yet for this workspace, initialize standard persistent records
  if (activityList.length === 0) {
    const adminName = user.name || "Sagar Kumar";
    const initialReports = [
      {
        title: "Leads Report",
        dateRange: dateRangeLabel,
        reportType: "leads",
      },
      {
        title: "Conversations Report",
        dateRange: dateRangeLabel,
        reportType: "conversations",
      },
      {
        title: "Team Performance Report",
        dateRange: "01 Aug 2026 – 31 Aug 2026",
        reportType: "team",
      },
      {
        title: "Leads Source Report",
        dateRange: "01 Aug 2026 – 31 Aug 2026",
        reportType: "leads",
      },
      {
        title: "Calls Report",
        dateRange: "01 Jul 2026 – 31 Jul 2026",
        reportType: "calls",
      },
    ];

    for (const item of initialReports) {
      const payload = {
        tenantId: String(tenantId),
        dateRange: item.dateRange,
        reportType: item.reportType,
        generatedByName: adminName,
        generatedByUserId: user.id || null,
      };
      await pool.execute(
        `INSERT INTO platform_records (module, title, status, payload_json, created_by_user_id)
         VALUES ('reports', ?, 'Completed', ?, ?)`,
        [item.title, JSON.stringify(payload), user.id || null],
      );
    }

    const [freshRecords] = await pool.execute(
      `SELECT id, title, status, payload_json, created_by_user_id, created_at, updated_at
       FROM platform_records
       WHERE module = 'reports' AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.tenantId')) = ?
       ORDER BY id DESC`,
      [String(tenantId)],
    );

    activityList = freshRecords.map((r) => {
      let payload = r.payload_json;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          payload = {};
        }
      }
      return {
        id: r.id,
        name: r.title,
        dateRange: payload?.dateRange || dateRangeLabel,
        generatedBy: payload?.generatedByName || adminName,
        status: r.status || "Completed",
        createdAt: r.created_at,
        reportType: payload?.reportType || "all",
      };
    });
  }

  // Filter activity if search or reportType specified
  if (options.search) {
    const q = String(options.search).toLowerCase().trim();
    activityList = activityList.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.dateRange.toLowerCase().includes(q) ||
        a.generatedBy.toLowerCase().includes(q),
    );
  }
  if (options.reportType && options.reportType !== "all" && options.reportType !== "All Reports") {
    const t = String(options.reportType).toLowerCase();
    activityList = activityList.filter(
      (a) =>
        a.reportType.toLowerCase() === t ||
        a.name.toLowerCase().includes(t),
    );
  }

  return {
    dateRange: {
      start: startStr,
      end: endStr,
      label: dateRangeLabel,
    },
    compLabel,
    counsellors,
    selectedCounsellorId: targetCounsellorId,
    overview: {
      leadsReport: {
        title: "Leads Report",
        total: currentLeads,
        metricLabel: "Leads",
        change: leadsDelta.change,
        pct: leadsDelta.pct,
        deltaType: leadsDelta.deltaType,
        comparison: compLabel,
        sparkline: leadSparkline,
        description: "Lead volume, sources, status and conversion.",
        reportKey: "leads",
      },
      conversationsReport: {
        title: "Conversations Report",
        total: currConvCount,
        metricLabel: "Conversations",
        change: convDelta.change,
        pct: convDelta.pct,
        deltaType: convDelta.deltaType,
        comparison: compLabel,
        sparkline: convSparkline,
        description: "Conversation volume and channel activity.",
        reportKey: "conversations",
      },
      callsReport: {
        title: "Calls Report",
        total: currentCalls,
        metricLabel: "Calls",
        change: callsDelta.change,
        pct: callsDelta.pct,
        deltaType: callsDelta.deltaType,
        comparison: compLabel,
        sparkline: callSparkline,
        description: "Call activity, outcomes and duration.",
        reportKey: "calls",
      },
      teamPerformanceReport: {
        title: "Team Performance Report",
        total: currentTeamCount,
        metricLabel: "Counsellors",
        change: teamDelta.change,
        pct: teamDelta.pct,
        deltaType: teamDelta.deltaType,
        comparison: compLabel,
        sparkline: teamSparkline,
        description: "Counsellor workload, activity and conversion.",
        reportKey: "team",
      },
    },
    leadsTrend: {
      grouping,
      labels: trendLabels,
      data: trendData,
      points: trendPoints,
    },
    reportActivity: activityList,
  };
}

export async function createReportActivity(tenantId, userId, data = {}, user = {}) {
  const title = String(data.reportName || "Custom Report").trim();
  const dateRange = String(data.dateRange || "").trim();
  const reportType = String(data.reportType || "all").trim();
  const adminName = user.name || "Sagar Kumar";

  const payload = {
    tenantId: String(tenantId),
    dateRange,
    reportType,
    generatedByName: adminName,
    generatedByUserId: userId || null,
  };

  const [result] = await pool.execute(
    `INSERT INTO platform_records (module, title, status, payload_json, created_by_user_id)
     VALUES ('reports', ?, 'Completed', ?, ?)`,
    [title, JSON.stringify(payload), userId || null],
  );

  return {
    id: result.insertId,
    name: title,
    dateRange,
    generatedBy: adminName,
    status: "Completed",
    createdAt: new Date(),
    reportType,
  };
}
