import { pool } from "../src/config/database.js";
import { createRole, listRoles, deleteRole } from "../src/services/roleService.js";
import { createCounsellor, updateCounsellor, listCounsellors, deleteCounsellor } from "../src/services/counsellorService.js";
import { createAdmin } from "../src/services/accountService.js";

async function runDesignationTest() {
  console.log("==================================================");
  console.log("RUNNING DYNAMIC DESIGNATION & COUNSELLOR TEST");
  console.log("==================================================");

  // 1. Create a test tenant & admin
  const testEmail = `admin_desig_${Date.now()}@test.com`;
  const admin = await createAdmin({
    name: "Designation Test Admin",
    email: testEmail,
    password: "Password123!",
    companyName: `Desig Univ ${Date.now()}`,
    createdByUserId: null,
  });
  const tenantId = admin.tenantId || admin.tenant_id;
  const adminId = admin.id;
  console.log(`✓ Admin & Tenant created (Tenant ID: ${tenantId})`);

  // 2. Create custom roles in Roles & Permissions
  const role1 = await createRole({
    name: "Counsellors",
    description: "Admission Counsellor Role",
    iconKey: "users",
    permissionKeys: ["dashboard.view", "inbox.view"],
    tenantId,
  });
  const role2 = await createRole({
    name: "Head Counsellors",
    description: "Lead Counsellor Role",
    iconKey: "crown",
    permissionKeys: ["dashboard.view", "inbox.view", "inbox.create"],
    tenantId,
  });
  console.log("✓ Created custom roles: 'Counsellors' and 'Head Counsellors'");

  // 3. Verify listRoles filtered to custom roles
  let roles = await listRoles(tenantId);
  let customRoles = roles.filter((r) => !r.isSystem && r.type !== "SYSTEM");
  console.log("✓ Custom roles retrieved:", customRoles.map((r) => r.name));
  if (customRoles.length !== 2) throw new Error("Expected 2 custom roles");

  // 4. Create Counsellor with designation = "Counsellors"
  const c1 = await createCounsellor({
    fullName: "Rishav Kumar",
    employeeId: `EMP-${Date.now()}`,
    email: `rishav_${Date.now()}@test.com`,
    phone: "+919876543210",
    department: "Admissions",
    designation: "Counsellors",
    password: "Password123!",
    adminUserId: adminId,
    tenantId,
  });
  console.log(`✓ Created counsellor with designation: '${c1.designation}', customRoleId: ${c1.customRoleId}`);
  if (c1.designation !== "Counsellors" || Number(c1.customRoleId) !== Number(role1.id)) {
    throw new Error(`Counsellor designation or customRoleId mismatch: ${c1.designation}, ${c1.customRoleId}`);
  }

  // 5. Create new custom role "Manager"
  const role3 = await createRole({
    name: "Manager",
    description: "Operations Manager",
    iconKey: "shield",
    permissionKeys: ["dashboard.view", "performance.view"],
    tenantId,
  });
  console.log("✓ Created new custom role: 'Manager'");

  roles = await listRoles(tenantId);
  customRoles = roles.filter((r) => !r.isSystem && r.type !== "SYSTEM");
  console.log("✓ Custom roles after adding Manager:", customRoles.map((r) => r.name));
  if (!customRoles.some((r) => r.name === "Manager")) throw new Error("Manager not in custom roles list");

  // 6. Update counsellor to designation = "Manager"
  const updatedC1 = await updateCounsellor({
    id: c1.id,
    tenantId,
    fullName: c1.fullName,
    employeeId: c1.employeeId,
    email: c1.email,
    phone: c1.phone,
    department: c1.department,
    designation: "Manager",
  });
  console.log(`✓ Updated counsellor designation to: '${updatedC1.designation}', customRoleId: ${updatedC1.customRoleId}`);
  if (updatedC1.designation !== "Manager" || Number(updatedC1.customRoleId) !== Number(role3.id)) {
    throw new Error(`Update failed: ${updatedC1.designation}, ${updatedC1.customRoleId}`);
  }

  // 7. Delete "Manager" role
  await deleteRole(role3.id, tenantId);
  console.log("✓ Deleted custom role 'Manager'");

  roles = await listRoles(tenantId);
  customRoles = roles.filter((r) => !r.isSystem && r.type !== "SYSTEM");
  console.log("✓ Custom roles after deleting Manager:", customRoles.map((r) => r.name));
  if (customRoles.some((r) => r.name === "Manager")) throw new Error("Manager should be removed");

  // Cleanup
  await deleteCounsellor({ id: c1.id, tenantId });
  await deleteRole(role1.id, tenantId);
  await deleteRole(role2.id, tenantId);

  console.log("==================================================");
  console.log("ALL DYNAMIC DESIGNATION TESTS PASSED 100%!");
  console.log("==================================================");
  await pool.end();
}

runDesignationTest().catch((err) => {
  console.error("Test failed:", err);
  pool.end();
  process.exit(1);
});
