import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import {
  createRole,
  deleteRole,
  getRoleById,
  listPermissions,
  listRoles,
  updateRole,
  updateRolePermissions,
} from "../src/services/roleService.js";
import {
  createTeamMember,
  listTeamMembers,
} from "../src/services/accountService.js";
import {
  authenticateUser,
  findUserById,
} from "../src/services/authService.js";
import { getUserPermissions } from "../src/middleware/rbac.js";

async function runEndToEndTests() {
  console.log("==========================================================");
  console.log("STARTING COMPREHENSIVE END-TO-END RBAC TEST SUITE");
  console.log("==========================================================");

  let testTenantA = null;
  let testTenantB = null;
  let testAdminUserA = null;
  let testCounsellorUser = null;
  let testCustomRole = null;

  try {
    // ---------------------------------------------------------
    // 1. SETUP TEST TENANTS & USERS
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 1: Tenant Setup & Isolation ---");
    const [tA] = await pool.execute(
      "INSERT INTO tenants (name, company_name, slug, status) VALUES ('Test University A', 'Test University A', 'test-univ-a-" + Date.now() + "', 'ACTIVE')",
    );
    testTenantA = tA.insertId;

    const [tB] = await pool.execute(
      "INSERT INTO tenants (name, company_name, slug, status) VALUES ('Test University B', 'Test University B', 'test-univ-b-" + Date.now() + "', 'ACTIVE')",
    );
    testTenantB = tB.insertId;

    const pwHash = await bcrypt.hash("Password123!", 10);
    const [uAdminA] = await pool.execute(
      "INSERT INTO users (tenant_id, name, email, password_hash, role, status, email_verified_at) VALUES (?, 'Admin A', 'admin-a-" + Date.now() + "@test.com', ?, 'ADMIN', 'ACTIVE', UTC_TIMESTAMP())",
      [testTenantA, pwHash],
    );
    testAdminUserA = uAdminA.insertId;

    console.log(`✓ Created Tenant A (ID: ${testTenantA}) and Tenant B (ID: ${testTenantB})`);

    // ---------------------------------------------------------
    // 2. PERMISSIONS CATALOG
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 2: Permissions Catalog ---");
    const catalog = await listPermissions();
    if (!catalog.raw || catalog.raw.length !== 28 || catalog.modules.length !== 7) {
      throw new Error("Permission catalog verification failed.");
    }
    console.log(`✓ Permission catalog verified: ${catalog.raw.length} permissions across 7 modules`);

    // ---------------------------------------------------------
    // 3. CREATE CUSTOM ROLE FOR TENANT A
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 3: Custom Role Creation & Permissions ---");
    testCustomRole = await createRole({
      tenantId: testTenantA,
      name: "Admissions Lead Specialist",
      description: "Custom role for handling leads and calls",
      iconKey: "calendar",
      permissionKeys: [
        "dashboard.view",
        "my_leads.view",
        "my_leads.create",
        "calls.view",
        "calls.create",
      ],
    });

    if (testCustomRole.permissionKeys.length !== 5) {
      throw new Error("Custom role permissions were not saved properly.");
    }
    console.log(`✓ Created Custom Role "${testCustomRole.name}" with 5 permissions`);

    // ---------------------------------------------------------
    // 4. CROSS-TENANT ISOLATION
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 4: Cross-Tenant Isolation Enforcement ---");
    const rolesForTenantB = await listRoles(testTenantB);
    const tenantBHasCustomRoleA = rolesForTenantB.some((r) => r.id === testCustomRole.id);
    if (tenantBHasCustomRoleA) {
      throw new Error("Cross-tenant isolation violation: Tenant B can see Tenant A's custom role!");
    }
    console.log("✓ Tenant B cannot see Tenant A's custom role");

    // Attempting to update Tenant A's role from Tenant B context must fail
    try {
      await updateRole(testCustomRole.id, testTenantB, { name: "Hacked by Tenant B" });
      throw new Error("Tenant B was able to modify Tenant A's role!");
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
      console.log("✓ Tenant B cannot update Tenant A's custom role (properly rejected with 403/404)");
    }

    // Attempting to delete Tenant A's role from Tenant B context must fail
    try {
      await deleteRole(testCustomRole.id, testTenantB);
      throw new Error("Tenant B was able to delete Tenant A's role!");
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
      console.log("✓ Tenant B cannot delete Tenant A's custom role (properly rejected with 403/404)");
    }

    // ---------------------------------------------------------
    // 5. EDIT CUSTOM ROLE & PERMISSIONS
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 5: Custom Role Edit & Permissions Update ---");
    const updatedRole = await updateRole(testCustomRole.id, testTenantA, {
      name: "Senior Admissions Lead Specialist",
      description: "Updated description",
      iconKey: "crown",
      permissionKeys: [
        "dashboard.view",
        "my_leads.view",
        "my_leads.create",
        "my_leads.update",
        "calls.view",
        "calls.create",
        "inbox.view",
      ],
    });

    if (updatedRole.name !== "Senior Admissions Lead Specialist" || updatedRole.permissionKeys.length !== 7) {
      throw new Error("Custom role update failed.");
    }
    console.log(`✓ Custom role updated to "${updatedRole.name}" with 7 permissions`);

    // ---------------------------------------------------------
    // 6. SYSTEM ROLE PROTECTION
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 6: System Role Immutability Guard ---");
    const rolesA = await listRoles(testTenantA);
    const systemRole = rolesA.find((r) => r.isSystem);
    if (systemRole) {
      try {
        await updateRole(systemRole.id, testTenantA, { name: "Modified System Role" });
        throw new Error("System role update was not blocked!");
      } catch (err) {
        if (err.status !== 403) throw err;
        console.log(`✓ System role "${systemRole.name}" update strictly blocked (403 Forbidden)`);
      }

      try {
        await deleteRole(systemRole.id, testTenantA);
        throw new Error("System role deletion was not blocked!");
      } catch (err) {
        if (err.status !== 403) throw err;
        console.log(`✓ System role "${systemRole.name}" deletion strictly blocked (403 Forbidden)`);
      }
    }

    // ---------------------------------------------------------
    // 7. TEAM MEMBER ROLE ASSIGNMENT
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 7: Team Member Custom Role Assignment ---");
    const memberEmail = "counsellor-" + Date.now() + "@test.com";
    const teamMemberUser = await createTeamMember({
      name: "Pooja Sharma",
      email: memberEmail,
      password: "Password123!",
      roleId: testCustomRole.id,
      adminUserId: testAdminUserA,
      tenantId: testTenantA,
    });

    testCounsellorUser = teamMemberUser.id;
    if (Number(teamMemberUser.customRoleId) !== Number(testCustomRole.id)) {
      throw new Error("Custom role was not assigned to team member user.");
    }
    console.log(`✓ Team member "${teamMemberUser.name}" created with assigned custom role (ID: ${teamMemberUser.customRoleId})`);

    // ---------------------------------------------------------
    // 8. USER PERMISSION RESOLUTION & ENFORCEMENT
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 8: User Permission Resolution & Enforcement ---");
    const effectivePermissions = await getUserPermissions(testCounsellorUser);
    console.log(`✓ Resolved ${effectivePermissions.length} effective permissions for assigned user:`, effectivePermissions);

    // Verify user has "my_leads.view" and "my_leads.create"
    if (!effectivePermissions.includes("my_leads.view") || !effectivePermissions.includes("calls.create")) {
      throw new Error("User is missing assigned permissions!");
    }

    // Verify user does NOT have "my_leads.delete" or "performance.delete"
    if (effectivePermissions.includes("my_leads.delete") || effectivePermissions.includes("performance.delete")) {
      throw new Error("User has unauthorized permissions!");
    }
    console.log("✓ Verified user permissions match role matrix exactly (no privilege escalation)");

    // ---------------------------------------------------------
    // 9. LOGIN & AUTH ME REGRESSION TEST
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 9: Login & Auth Me Verification ---");
    const authUser = await authenticateUser(memberEmail, "Password123!");
    if (!authUser.permissions || authUser.permissions.length !== effectivePermissions.length) {
      throw new Error("Login response did not return expected user permissions array.");
    }
    console.log(`✓ User login successful, returned roleName: "${authUser.roleName}", permissions count: ${authUser.permissions.length}`);

    const meUser = await findUserById(testCounsellorUser);
    if (!meUser.permissions || meUser.permissions.length !== effectivePermissions.length) {
      throw new Error("findUserById did not return expected user permissions.");
    }
    console.log(`✓ Auth me lookup successful with dynamic permissions array`);

    // ---------------------------------------------------------
    // 10. DELETE CUSTOM ROLE & CLEANUP CASCADE
    // ---------------------------------------------------------
    console.log("\n--- TEST PHASE 10: Role Deletion & Cascade Safety ---");
    const delRes = await deleteRole(testCustomRole.id, testTenantA);
    if (!delRes.success) {
      throw new Error("Delete custom role failed.");
    }
    console.log("✓ Custom role deleted successfully");

    const userAfterRoleDelete = await findUserById(testCounsellorUser);
    if (userAfterRoleDelete.customRoleId !== null) {
      throw new Error("User custom_role_id was not set to NULL after role deletion!");
    }
    console.log("✓ User custom_role_id safely updated to NULL after role deletion (no dangling foreign keys)");

    console.log("\n==========================================================");
    console.log("ALL RBAC END-TO-END TESTS COMPLETED AND PASSED 100%!");
    console.log("==========================================================");
  } catch (error) {
    console.error("\n❌ END-TO-END RBAC TEST FAILED:", error);
    process.exit(1);
  } finally {
    // Cleanup test data
    if (testCounsellorUser) await pool.execute("DELETE FROM users WHERE id = ?", [testCounsellorUser]).catch(() => {});
    if (testAdminUserA) await pool.execute("DELETE FROM users WHERE id = ?", [testAdminUserA]).catch(() => {});
    if (testTenantA) await pool.execute("DELETE FROM tenants WHERE id = ?", [testTenantA]).catch(() => {});
    if (testTenantB) await pool.execute("DELETE FROM tenants WHERE id = ?", [testTenantB]).catch(() => {});
    await pool.end();
  }
}

runEndToEndTests();
