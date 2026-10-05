import { pool } from "../src/config/database.js";
import { createRole, listRoles, updateRole, deleteRole, getRoleById } from "../src/services/roleService.js";
import { createCounsellor, updateCounsellor, listCounsellors } from "../src/services/counsellorService.js";
import { authenticateUser } from "../src/services/authService.js";
import { getUserPermissions } from "../src/middleware/rbac.js";

async function runCoexistenceTest() {
  console.log("=================================================================");
  console.log("TESTING CUSTOM ROLE COEXISTENCE WITH SYSTEM ROLES & TENANT SCOPE");
  console.log("=================================================================");

  const tenantId = 7; // BrightMind University / Barun Technology

  // Cleanup existing custom roles for tenant 7 before starting test
  await pool.query("DELETE FROM roles WHERE tenant_id = ? AND type = 'CUSTOM'", [tenantId]);

  // 1. Create custom role "Counsellor" for Tenant 7
  console.log("--- 1. Creating Custom Role 'Counsellor' ---");
  const customCounsellor = await createRole({
    tenantId,
    name: "Counsellor",
    description: "Custom Counsellor permissions for Admissions",
    iconKey: "support",
    permissionKeys: ["dashboard.view", "inbox.view", "my_leads.view", "my_leads.create", "my_leads.update"],
  });
  console.log(`✓ Created Custom Role 'Counsellor' (ID: ${customCounsellor.id}, type: ${customCounsellor.type})`);

  // 2. Create custom role "Head Counsellor" for Tenant 7
  console.log("--- 2. Creating Custom Role 'Head Counsellor' ---");
  const customHeadCounsellor = await createRole({
    tenantId,
    name: "Head Counsellor",
    description: "Custom Head Counsellor permissions",
    iconKey: "crown",
    permissionKeys: [
      "dashboard.view",
      "inbox.view", "inbox.create", "inbox.update", "inbox.delete",
      "my_leads.view", "my_leads.create", "my_leads.update",
      "follow_ups.view", "follow_ups.create",
      "calls.view", "calls.create",
    ],
  });
  console.log(`✓ Created Custom Role 'Head Counsellor' (ID: ${customHeadCounsellor.id}, type: ${customHeadCounsellor.type})`);

  // 3. Verify duplicate name check for SAME tenant throws 409
  console.log("--- 3. Testing Duplicate Name Guard within Tenant ---");
  try {
    await createRole({
      tenantId,
      name: "Counsellor",
      description: "Duplicate",
      permissionKeys: ["dashboard.view"],
    });
    throw new Error("Should have thrown 409 duplicate error!");
  } catch (err) {
    if (err.status === 409 || err.statusCode === 409) {
      console.log("✓ Duplicate custom role name correctly blocked with 409 Conflict:", err.message);
    } else {
      throw err;
    }
  }

  // 4. Verify listRoles returns both System and Custom roles
  console.log("--- 4. Verifying listRoles API ---");
  const roles = await listRoles(tenantId);
  const sysRoles = roles.filter((r) => r.isSystem || r.type === "SYSTEM");
  const custRoles = roles.filter((r) => !r.isSystem && r.type !== "SYSTEM");

  console.log("System Roles:", sysRoles.map((r) => `${r.name} (${r.type})`));
  console.log("Custom Roles for Tenant 7:", custRoles.map((r) => `${r.name} (${r.type}, ID: ${r.id})`));

  if (sysRoles.length !== 3) throw new Error("Expected 3 system roles (Admin, Head Counsellor, Counsellor)");
  if (!custRoles.some((r) => r.name === "Counsellor")) throw new Error("Custom role 'Counsellor' missing");
  if (!custRoles.some((r) => r.name === "Head Counsellor")) throw new Error("Custom role 'Head Counsellor' missing");

  // 5. Verify Counsellor creation / update links to custom role
  console.log("--- 5. Testing Counsellor Assignment to Custom Roles ---");
  // Update User 48 (Rishav Kumar) to custom role "Head Counsellor"
  const updatedRishav = await updateCounsellor({
    id: 48,
    tenantId,
    fullName: "Rishav Kumar",
    employeeId: "Rishav21",
    email: "rishav1@gmail.com",
    phone: "7217890491",
    department: "Team Lead",
    designation: "Head Counsellor",
    password: "Password123!",
  });
  console.log(`✓ User 48 updated with designation: '${updatedRishav.designation}', customRoleId: ${updatedRishav.customRoleId}`);
  if (Number(updatedRishav.customRoleId) !== Number(customHeadCounsellor.id)) {
    throw new Error(`Expected customRoleId ${customHeadCounsellor.id}, got ${updatedRishav.customRoleId}`);
  }

  // 6. Verify User Permissions Resolution
  console.log("--- 6. Verifying Effective Permissions for User 48 ---");
  const perms = await getUserPermissions(48);
  console.log("Effective permissions count:", perms.length, perms);
  if (!perms.includes("inbox.delete")) {
    throw new Error("Expected inbox.delete permission in custom Head Counsellor");
  }

  // 7. Verify Admin and Counsellor Login
  console.log("--- 7. Verifying Authentication / Login ---");
  const adminLogin = await authenticateUser("suraj@gmail.com", "Suraj@123");
  console.log(`✓ Admin login successful: ${adminLogin.name} (${adminLogin.role}, permissions: ${adminLogin.permissions.length})`);

  const counsellorLogin = await authenticateUser("rishav1@gmail.com", "Password123!");
  console.log(`✓ Counsellor login successful: ${counsellorLogin.name} (Role: ${counsellorLogin.role}, RoleName: ${counsellorLogin.roleName}, CustomRoleId: ${counsellorLogin.customRoleId}, permissions: ${counsellorLogin.permissions.length})`);

  console.log("=================================================================");
  console.log("ALL CUSTOM ROLE COEXISTENCE TESTS COMPLETED AND PASSED 100%!");
  console.log("=================================================================");
  await pool.end();
}

runCoexistenceTest().catch((err) => {
  console.error("Test error:", err);
  pool.end();
  process.exit(1);
});
