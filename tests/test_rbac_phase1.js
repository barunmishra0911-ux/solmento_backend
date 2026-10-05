import { pool } from "../src/config/database.js";
import {
  createRole,
  deleteRole,
  getRoleById,
  listPermissions,
  listRoles,
  updateRole,
} from "../src/services/roleService.js";

async function runTests() {
  console.log("=========================================");
  console.log("STARTING PHASE 1 RBAC BACKEND API TESTS");
  console.log("=========================================");

  try {
    // Get a test tenant ID from database
    const [tenants] = await pool.execute("SELECT id FROM tenants LIMIT 1");
    if (!tenants.length) {
      throw new Error("No tenant found in database to run tests against.");
    }

    const tenantId = tenants[0].id;
    console.log(`✓ Using Test Tenant ID: ${tenantId}`);

    // Test 1: Permission catalog
    const catalog = await listPermissions();
    if (!catalog.raw || catalog.raw.length !== 28) {
      throw new Error(`Expected 28 permissions in catalog, got ${catalog.raw?.length}`);
    }
    console.log(`✓ Permission Catalog retrieved successfully (${catalog.raw.length} permissions across ${catalog.modules.length} modules)`);

    // Test 2: List roles for tenant
    const initialRoles = await listRoles(tenantId);
    const systemRoles = initialRoles.filter((r) => r.isSystem);
    if (systemRoles.length < 3) {
      throw new Error(`Expected at least 3 system roles, found ${systemRoles.length}`);
    }
    console.log(`✓ List Roles retrieved ${initialRoles.length} roles (System roles: ${systemRoles.map((r) => r.name).join(", ")})`);

    // Test 3: Create Custom Role
    const newRole = await createRole({
      tenantId,
      name: "Test Admissions Specialist",
      description: "Custom role created during automated test",
      iconKey: "calendar",
      permissionKeys: ["dashboard.view", "my_leads.view", "my_leads.create"],
    });

    if (!newRole.id || newRole.type !== "CUSTOM" || newRole.permissionKeys.length !== 3) {
      throw new Error("Failed to create custom role properly.");
    }
    console.log(`✓ Created Custom Role "${newRole.name}" (ID: ${newRole.id}) with 3 permissions`);

    // Test 4: Get Role By ID
    const fetchedRole = await getRoleById(newRole.id, tenantId);
    if (fetchedRole.name !== "Test Admissions Specialist" || fetchedRole.permissionKeys.length !== 3) {
      throw new Error("Get Role By ID returned unexpected data.");
    }
    console.log(`✓ Get Role By ID verified successfully`);

    // Test 5: Update Custom Role
    const updatedRole = await updateRole(newRole.id, tenantId, {
      name: "Senior Admissions Specialist",
      description: "Updated description",
      iconKey: "crown",
      permissionKeys: ["dashboard.view", "my_leads.view", "my_leads.create", "my_leads.update", "calls.view"],
    });

    if (updatedRole.name !== "Senior Admissions Specialist" || updatedRole.permissionKeys.length !== 5) {
      throw new Error("Update custom role failed.");
    }
    console.log(`✓ Updated Custom Role successfully to "${updatedRole.name}" with 5 permissions`);

    // Test 6: Verify System Role Protection (Edit & Delete blocked)
    const adminRole = systemRoles.find((r) => r.name === "Admin");
    if (adminRole) {
      try {
        await updateRole(adminRole.id, tenantId, { name: "Hacked Admin" });
        throw new Error("System role update was NOT blocked!");
      } catch (err) {
        if (err.status !== 403) throw err;
        console.log(`✓ Verified System Role Update Protection (403 Forbidden properly returned)`);
      }

      try {
        await deleteRole(adminRole.id, tenantId);
        throw new Error("System role deletion was NOT blocked!");
      } catch (err) {
        if (err.status !== 403) throw err;
        console.log(`✓ Verified System Role Deletion Protection (403 Forbidden properly returned)`);
      }
    }

    // Test 7: Delete Custom Role
    const deleteResult = await deleteRole(newRole.id, tenantId);
    if (!deleteResult.success) {
      throw new Error("Delete custom role failed.");
    }
    console.log(`✓ Deleted Custom Role successfully`);

    // Test 8: Verify Deleted Role 404
    try {
      await getRoleById(newRole.id, tenantId);
      throw new Error("Deleted role was still found!");
    } catch (err) {
      if (err.status !== 404) throw err;
      console.log(`✓ Verified Deleted Custom Role 404 Not Found`);
    }

    console.log("=========================================");
    console.log("ALL PHASE 1 BACKEND API TESTS PASSED 100%");
    console.log("=========================================");
  } catch (error) {
    console.error("❌ RBAC PHASE 1 TEST FAILED:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runTests();
