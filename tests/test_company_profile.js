import { signAccessToken } from "../src/middleware/auth.js";
import { pool } from "../src/config/database.js";
import { getCompanyProfile, upsertCompanyProfile } from "../src/services/tenantService.js";

async function runCompanyProfileTests() {
  console.log("=================================================================");
  console.log("STARTING TEST SUITE: COMPANY PROFILE BACKEND & TENANT ISOLATION");
  console.log("=================================================================");

  const tenantA = 101;
  const tenantB = 202;

  try {
    // Cleanup test data
    await pool.execute("DELETE FROM company_profiles WHERE tenant_id IN (?, ?)", [tenantA, tenantB]);
    await pool.execute("DELETE FROM audit_logs WHERE tenant_id IN (?, ?)", [tenantA, tenantB]);
    await pool.execute("DELETE FROM tenants WHERE id IN (?, ?)", [tenantA, tenantB]);

    // Insert dummy tenants
    await pool.execute(
      "INSERT INTO tenants (id, name, company_name, slug, status) VALUES (?, 'Tenant A', 'Company A', 'tenant-a-slug', 'ACTIVE')",
      [tenantA]
    );
    await pool.execute(
      "INSERT INTO tenants (id, name, company_name, slug, status) VALUES (?, 'Tenant B', 'Company B', 'tenant-b-slug', 'ACTIVE')",
      [tenantB]
    );

    // TEST 1: GET initial company profile fallback for Tenant A
    console.log("\n--- TEST 1: GET initial company profile fallback ---");
    const profileA1 = await getCompanyProfile(tenantA);
    console.log("Tenant A initial profile:", profileA1.companyName, profileA1.email);
    if (profileA1.companyName !== "Company A") {
      throw new Error("Initial profile fallback failed to return tenant company name!");
    }
    console.log("✓ TEST 1 PASSED: Initial fallback profile returned correctly.");

    // TEST 2: Save / Upsert company profile for Tenant A
    console.log("\n--- TEST 2 & 3: Save Company Profile & Verify Persistence ---");
    const payloadA = {
      companyName: "Acme Education Pvt Ltd",
      industry: "Education",
      timezone: "(GMT+05:30) Asia/Kolkata",
      logoUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      email: "contact@acme-edu.com",
      phone: "+91 9988776655",
      website: "https://acme-edu.com",
      supportEmail: "support@acme-edu.com",
      addressLine1: "Tower B, Tech Park",
      addressLine2: "Sector 142",
      city: "Noida",
      state: "Uttar Pradesh",
      pinCode: "201305",
      country: "India",
    };

    const savedA = await upsertCompanyProfile(tenantA, payloadA, 1, "127.0.0.1");
    if (savedA.companyName !== "Acme Education Pvt Ltd" || savedA.phone !== "+91 9988776655") {
      throw new Error("Save company profile returned incorrect data!");
    }

    // Verify persistence in DB
    const fetchedA = await getCompanyProfile(tenantA);
    if (fetchedA.companyName !== "Acme Education Pvt Ltd" || fetchedA.city !== "Noida" || fetchedA.pinCode !== "201305") {
      throw new Error("Database persistence verification failed!");
    }
    console.log("✓ TEST 2 & 3 PASSED: Profile saved and persisted in MySQL.");

    // TEST 5, 6, 7: Update details
    console.log("\n--- TEST 5, 6, 7: Update Name, Contact Details & Address ---");
    payloadA.companyName = "Acme Global Academy";
    payloadA.phone = "+91 1122334455";
    payloadA.addressLine1 = "Suite 500, Cyber Hub";
    const updatedA = await upsertCompanyProfile(tenantA, payloadA, 1, "127.0.0.1");
    if (updatedA.companyName !== "Acme Global Academy" || updatedA.phone !== "+91 1122334455" || updatedA.addressLine1 !== "Suite 500, Cyber Hub") {
      throw new Error("Update verification failed!");
    }
    console.log("✓ TEST 5, 6, 7 PASSED: Updated company details successfully.");

    // TEST 8: Verify Audit Log created
    console.log("\n--- TEST 8: Audit Log Verification ---");
    const [auditRows] = await pool.execute(
      "SELECT action, target_type, metadata_json FROM audit_logs WHERE tenant_id = ? AND target_type = 'Company Profile'",
      [tenantA]
    );
    if (!auditRows.length) {
      throw new Error("Audit Log entry for Company Profile update was not created!");
    }
    const rawMeta = auditRows[0].metadata_json;
    const auditMeta = typeof rawMeta === "string" ? JSON.parse(rawMeta) : (rawMeta || {});
    if (auditRows[0].action !== "Updated" || auditMeta.module !== "Company Profile") {
      throw new Error("Audit Log action/module metadata mismatch!");
    }
    console.log("✓ TEST 8 PASSED: Audit Log entry 'Updated' 'Company Profile' generated.");

    // TEST 9: Tenant Isolation (Tenant A vs Tenant B)
    console.log("\n--- TEST 9: Tenant Isolation Verification ---");
    const profileB = await getCompanyProfile(tenantB);
    if (profileB.companyName === "Acme Global Academy" || profileB.email === "contact@acme-edu.com") {
      throw new Error("TENANT ISOLATION FAILED: Tenant B accessed Tenant A profile data!");
    }
    console.log("Tenant B isolated profile:", profileB.companyName);
    console.log("✓ TEST 9 PASSED: Tenant A & Tenant B profiles are strictly isolated.");

    // HTTP Endpoint Integration Test
    console.log("\n--- HTTP ENDPOINT INTEGRATION TESTS ---");
    const adminToken = signAccessToken({ id: 1, role: "ADMIN", tenantId: tenantA });
    const baseUrl = "http://localhost:5000/api/admin/company-profile";

    // HTTP GET
    const getRes = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    console.log("HTTP GET status:", getRes.status);
    if (getRes.status !== 200) throw new Error("HTTP GET /admin/company-profile failed");
    const getBody = await getRes.json();
    if (getBody.data.profile.companyName !== "Acme Global Academy") {
      throw new Error("HTTP GET returned unexpected profile companyName");
    }
    console.log("✓ HTTP GET /api/admin/company-profile verified.");

    // HTTP PUT
    const putRes = await fetch(baseUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(payloadA),
    });
    console.log("HTTP PUT status:", putRes.status);
    if (putRes.status !== 200) throw new Error("HTTP PUT /admin/company-profile failed");
    const putBody = await putRes.json();
    console.log("✓ HTTP PUT /api/admin/company-profile verified.");

    // HTTP PUT Validation Error Test (missing required field)
    const invalidPayload = { ...payloadA, companyName: "" };
    const invalidRes = await fetch(baseUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(invalidPayload),
    });
    console.log("HTTP Validation Error status:", invalidRes.status);
    if (invalidRes.status !== 422) {
      throw new Error("Validation failure: Expected 422 for missing companyName");
    }
    console.log("✓ HTTP Validation Error (422) verified.");

    // Cleanup test data
    await pool.execute("DELETE FROM company_profiles WHERE tenant_id IN (?, ?)", [tenantA, tenantB]);
    await pool.execute("DELETE FROM audit_logs WHERE tenant_id IN (?, ?)", [tenantA, tenantB]);
    await pool.execute("DELETE FROM tenants WHERE id IN (?, ?)", [tenantA, tenantB]);

    console.log("\n=================================================================");
    console.log("ALL COMPANY PROFILE TESTS PASSED 100%!");
    console.log("=================================================================");
  } catch (error) {
    console.error("❌ Test execution failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runCompanyProfileTests();
