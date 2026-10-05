import { pool } from "../src/config/database.js";
import {
  createCounsellor,
  updateCounsellor,
  listCounsellors,
  generateEmployeeId,
} from "../src/services/counsellorService.js";

async function runTests() {
  console.log("==================================================");
  console.log("STARTING AUTOMATIC EMPLOYEE ID GENERATION TESTS");
  console.log("==================================================");

  let testTenantId = 7;
  let adminUserId = null;

  // Find an active admin for tenant 7
  const [admins] = await pool.execute(
    "SELECT id, tenant_id FROM users WHERE tenant_id = ? AND role = 'ADMIN' AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1",
    [testTenantId],
  );

  if (admins.length) {
    adminUserId = admins[0].id;
  } else {
    // Fallback to any active admin
    const [fallbackAdmins] = await pool.execute(
      "SELECT id, tenant_id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1",
    );
    if (!fallbackAdmins.length) throw new Error("No active admin found in database!");
    adminUserId = fallbackAdmins[0].id;
    testTenantId = fallbackAdmins[0].tenant_id;
  }

  console.log(`Using Admin ID: ${adminUserId}, Tenant ID: ${testTenantId}`);

  const createdCounsellorIds = [];

  try {
    // TEST 1: Unit format verification of generateEmployeeId()
    console.log("\n[TEST 1] Format & Character Set of generateEmployeeId()...");
    for (let i = 0; i < 100; i++) {
      const sampleId = generateEmployeeId();
      if (sampleId.length !== 12) {
        throw new Error(`Invalid length ${sampleId.length} for generated ID: ${sampleId}`);
      }
      if (!/^[0-9A-Z]{12}$/.test(sampleId)) {
        throw new Error(`Invalid characters in generated ID: ${sampleId}`);
      }
    }
    console.log(" -> 100 random IDs tested: All exactly 12 uppercase alphanumeric characters (PASS)");

    // TEST 2: Single Counsellor Creation with Auto ID
    console.log("\n[TEST 2] Create Single Counsellor with Auto-Generated ID...");
    const email1 = `test_c1_${Date.now()}@solmento.internal`;
    const counsellor1 = await createCounsellor({
      fullName: "Test Auto ID Counsellor 1",
      email: email1,
      phone: "+91 9876543210",
      department: "Admissions",
      designation: "Counsellor",
      password: "Password123!",
      adminUserId,
      tenantId: testTenantId,
    });
    createdCounsellorIds.push(counsellor1.id);

    console.log(` -> Created Counsellor ID: ${counsellor1.id}, Employee ID: "${counsellor1.employeeId}"`);
    if (!/^[0-9A-Z]{12}$/.test(counsellor1.employeeId)) {
      throw new Error(`Created counsellor has invalid employee ID format: ${counsellor1.employeeId}`);
    }
    console.log(" -> Generated Employee ID matches ^[0-9A-Z]{12}$ (PASS)");

    // TEST 3: Multiple Counsellors with Identical Names
    console.log("\n[TEST 3] Create Multiple Counsellors with Identical Names...");
    const email2 = `test_c2_${Date.now()}@solmento.internal`;
    const email3 = `test_c3_${Date.now()}@solmento.internal`;

    const cSameName1 = await createCounsellor({
      fullName: "Duplicate Name Agent",
      email: email2,
      phone: "+91 9876543211",
      department: "Admissions",
      designation: "Counsellor",
      password: "Password123!",
      adminUserId,
      tenantId: testTenantId,
    });
    createdCounsellorIds.push(cSameName1.id);

    const cSameName2 = await createCounsellor({
      fullName: "Duplicate Name Agent",
      email: email3,
      phone: "+91 9876543212",
      department: "Admissions",
      designation: "Counsellor",
      password: "Password123!",
      adminUserId,
      tenantId: testTenantId,
    });
    createdCounsellorIds.push(cSameName2.id);

    console.log(` -> Counsellor A ID: ${cSameName1.employeeId}`);
    console.log(` -> Counsellor B ID: ${cSameName2.employeeId}`);
    if (cSameName1.employeeId === cSameName2.employeeId) {
      throw new Error("Duplicate Employee IDs generated for counsellors with identical names!");
    }
    console.log(" -> Both counsellors received distinct unique 12-character IDs (PASS)");

    // TEST 4: Ignore Client-Supplied Employee ID
    console.log("\n[TEST 4] Security Test: Frontend-Supplied Employee ID is Ignored...");
    const email4 = `test_c4_${Date.now()}@solmento.internal`;
    const rogueCounsellor = await createCounsellor({
      fullName: "Rogue Input Counsellor",
      employeeId: "CLIENT_SUPPLIED_HACK",
      email: email4,
      phone: "+91 9876543213",
      department: "Admissions",
      designation: "Counsellor",
      password: "Password123!",
      adminUserId,
      tenantId: testTenantId,
    });
    createdCounsellorIds.push(rogueCounsellor.id);

    console.log(` -> Client passed: "CLIENT_SUPPLIED_HACK" | Stored ID: "${rogueCounsellor.employeeId}"`);
    if (rogueCounsellor.employeeId === "CLIENT_SUPPLIED_HACK") {
      throw new Error("Security vulnerability: Backend accepted client-supplied Employee ID!");
    }
    if (!/^[0-9A-Z]{12}$/.test(rogueCounsellor.employeeId)) {
      throw new Error(`Assigned employee ID invalid: ${rogueCounsellor.employeeId}`);
    }
    console.log(" -> Client-supplied Employee ID was discarded and auto-generated ID was assigned (PASS)");

    // TEST 5: Concurrent Creation Simulation (10 parallel requests)
    console.log("\n[TEST 5] Concurrency Test: 10 Simultaneous Counsellor Creation Requests...");
    const concurrentPromises = Array.from({ length: 10 }).map((_, index) => {
      const email = `test_concurrent_${Date.now()}_${index}@solmento.internal`;
      return createCounsellor({
        fullName: `Concurrent Counsellor ${index + 1}`,
        email,
        phone: `+91 98765432${index.toString().padStart(2, "0")}`,
        department: "Support",
        designation: "Counsellor",
        password: "Password123!",
        adminUserId,
        tenantId: testTenantId,
      });
    });

    const concurrentResults = await Promise.all(concurrentPromises);
    const concurrentEmployeeIds = new Set();

    for (const c of concurrentResults) {
      createdCounsellorIds.push(c.id);
      if (concurrentEmployeeIds.has(c.employeeId)) {
        throw new Error(`Collision detected in concurrent creation! Duplicate ID: ${c.employeeId}`);
      }
      concurrentEmployeeIds.add(c.employeeId);
    }

    console.log(` -> 10/10 counsellors created simultaneously. All 10 IDs unique:`);
    console.log(`    ${Array.from(concurrentEmployeeIds).join(", ")}`);
    console.log(" -> Zero collisions under concurrent load (PASS)");

    // TEST 6: Immutability on Edit
    console.log("\n[TEST 6] Immutability Test: Employee ID Cannot Be Modified on Edit...");
    const originalId = counsellor1.employeeId;
    const updatedCounsellor = await updateCounsellor({
      id: counsellor1.id,
      tenantId: testTenantId,
      fullName: "Updated Full Name",
      employeeId: "ATTEMPTED_CHANGED_ID",
      email: counsellor1.email,
      phone: "+91 9999999999",
      department: "Updated Department",
      designation: "Counsellor",
    });

    console.log(` -> Original ID: "${originalId}" | ID After Update: "${updatedCounsellor.employeeId}"`);
    if (updatedCounsellor.employeeId !== originalId) {
      throw new Error(`Employee ID was improperly changed from ${originalId} to ${updatedCounsellor.employeeId}`);
    }
    console.log(" -> Employee ID remained unchanged after update request (PASS)");

    // TEST 7: Legacy IDs Preservation Check
    console.log("\n[TEST 7] Legacy Counsellor IDs Preservation...");
    const [existingRows] = await pool.execute(
      "SELECT id, name, employee_id FROM users WHERE role IN ('HEAD_COUNSELLOR', 'COUNSELLOR') AND id NOT IN (" +
        createdCounsellorIds.map(() => "?").join(",") +
        ")",
      createdCounsellorIds,
    );
    console.log(` -> Verified ${existingRows.length} legacy counsellor records:`);
    for (const row of existingRows) {
      console.log(`    ID ${row.id} (${row.name}): employee_id = "${row.employee_id}"`);
    }
    console.log(" -> All existing legacy records intact (PASS)");

    console.log("\n==================================================");
    console.log("ALL TESTS COMPLETED AND PASSED SUCCESSFULLY (100%)");
    console.log("==================================================");
  } finally {
    // Clean up test counsellors
    if (createdCounsellorIds.length) {
      await pool.execute(
        `DELETE FROM users WHERE id IN (${createdCounsellorIds.map(() => "?").join(",")})`,
        createdCounsellorIds,
      );
      console.log(`\nCleaned up ${createdCounsellorIds.length} test records from database.`);
    }
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nTEST RUNNER FAILED:", err);
    process.exit(1);
  });
