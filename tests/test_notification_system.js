import { pool } from '../src/config/database.js';
import {
  createNotification,
  listUserNotifications,
  getUnreadNotificationCount,
  markAsRead,
  markAllAsRead,
  createNotificationIfNotExistsRecent,
  notifyAdminsOfTenant
} from '../src/services/notificationService.js';

async function runTests() {
  console.log('--- STARTING NOTIFICATION SYSTEM TEST SUITE ---');

  const tenantA = 991;
  const tenantB = 992;
  const adminAId = 99901;
  const counsellorA1Id = 99902;
  const counsellorA2Id = 99903;
  const counsellorB1Id = 99904;

  try {
    // Setup test tenants and users in pool
    await pool.query(`
      INSERT IGNORE INTO tenants (id, name, company_name, slug)
      VALUES 
        (?, 'Tenant 991', 'Company 991', 'tenant-991'),
        (?, 'Tenant 992', 'Company 992', 'tenant-992')
    `, [tenantA, tenantB]);

    await pool.query(`
      INSERT IGNORE INTO users (id, tenant_id, email, password_hash, name, role, status)
      VALUES 
        (?, ?, 'admin.a@test.com', 'hash', 'Admin A', 'ADMIN', 'ACTIVE'),
        (?, ?, 'counsellor.a1@test.com', 'hash', 'Counsellor A1', 'COUNSELLOR', 'ACTIVE'),
        (?, ?, 'counsellor.a2@test.com', 'hash', 'Counsellor A2', 'COUNSELLOR', 'ACTIVE'),
        (?, ?, 'counsellor.b1@test.com', 'hash', 'Counsellor B1', 'COUNSELLOR', 'ACTIVE')
    `, [adminAId, tenantA, counsellorA1Id, tenantA, counsellorA2Id, tenantA, counsellorB1Id, tenantB]);

    await pool.query(`
      UPDATE users SET status = 'ACTIVE', role = CASE 
        WHEN id = ? THEN 'ADMIN' 
        ELSE 'COUNSELLOR' 
      END WHERE id IN (?, ?, ?, ?)
    `, [adminAId, adminAId, counsellorA1Id, counsellorA2Id, counsellorB1Id]);

    console.log('✓ Test users inserted successfully');

    // 1. Create Notifications
    const notif1 = await createNotification({
      tenantId: tenantA,
      recipientUserId: counsellorA1Id,
      actorUserId: adminAId,
      type: 'INFO',
      title: 'New Lead Assigned',
      message: 'Lead John Doe assigned to you',
      module: 'LEADS',
      entityType: 'LEAD',
      entityId: 101,
      priority: 'INFO'
    });
    console.log('✓ Created Notification 1 (Counsellor A1):', notif1.id);

    const notif2 = await createNotification({
      tenantId: tenantA,
      recipientUserId: counsellorA1Id,
      actorUserId: adminAId,
      type: 'WARNING',
      title: 'Follow-up Due Soon',
      message: 'Follow-up with Jane Smith due in 15 mins',
      module: 'FOLLOWUPS',
      entityType: 'FOLLOWUP',
      entityId: 202,
      priority: 'WARNING'
    });
    console.log('✓ Created Notification 2 (Counsellor A1):', notif2.id);

    // 2. Tenant & Recipient Isolation Check
    const a1Notifs = await listUserNotifications({ tenantId: tenantA, recipientUserId: counsellorA1Id });
    if (a1Notifs.notifications.length < 2) throw new Error('Counsellor A1 should have at least 2 notifications');
    console.log(`✓ Counsellor A1 retrieved ${a1Notifs.notifications.length} notifications`);

    const a2Notifs = await listUserNotifications({ tenantId: tenantA, recipientUserId: counsellorA2Id });
    if (a2Notifs.notifications.some(n => n.id === notif1.id)) throw new Error('Counsellor A2 should NOT see Counsellor A1 notification');
    console.log('✓ Verified recipient isolation: Counsellor A2 cannot see Counsellor A1 notification');

    const b1Notifs = await listUserNotifications({ tenantId: tenantB, recipientUserId: counsellorB1Id });
    if (b1Notifs.notifications.some(n => n.id === notif1.id)) throw new Error('Tenant B user should NOT see Tenant A notification');
    console.log('✓ Verified tenant isolation: Tenant B user cannot see Tenant A notification');

    // 3. Unread Count Check
    let unreadCountA1 = await getUnreadNotificationCount({ tenantId: tenantA, recipientUserId: counsellorA1Id });
    if (unreadCountA1 < 2) throw new Error('Unread count for A1 should be at least 2');
    console.log(`✓ Unread count for Counsellor A1: ${unreadCountA1}`);

    // 4. Mark As Read
    const updatedNotif1 = await markAsRead({ tenantId: tenantA, recipientUserId: counsellorA1Id, notificationId: notif1.id });
    if (!updatedNotif1.isRead) throw new Error('Notification 1 should be marked as read');
    console.log('✓ Mark as read verified for Notification 1');

    unreadCountA1 = await getUnreadNotificationCount({ tenantId: tenantA, recipientUserId: counsellorA1Id });
    console.log(`✓ Updated unread count for Counsellor A1: ${unreadCountA1}`);

    // 5. Mark All As Read
    await markAllAsRead({ tenantId: tenantA, recipientUserId: counsellorA1Id });
    unreadCountA1 = await getUnreadNotificationCount({ tenantId: tenantA, recipientUserId: counsellorA1Id });
    if (unreadCountA1 !== 0) throw new Error(`Unread count should be 0 after markAllAsRead, got ${unreadCountA1}`);
    console.log('✓ Mark all as read verified (Unread count is 0)');

    // 6. Deduplication Test for Overdue Follow-ups
    const testEntityId = 30000 + Math.floor(Math.random() * 10000);
    const notifDedup1 = await createNotificationIfNotExistsRecent({
      tenantId: tenantA,
      recipientUserId: counsellorA1Id,
      actorUserId: null,
      type: 'URGENT',
      title: 'Follow-up Overdue',
      message: `Follow-up for Lead #${testEntityId} is overdue`,
      module: 'FOLLOWUPS',
      entityType: 'FOLLOWUP',
      entityId: testEntityId,
      priority: 'URGENT',
      cooldownHours: 24
    });
    console.log('✓ Created initial overdue notification:', notifDedup1.id);

    const notifDedup2 = await createNotificationIfNotExistsRecent({
      tenantId: tenantA,
      recipientUserId: counsellorA1Id,
      actorUserId: null,
      type: 'URGENT',
      title: 'Follow-up Overdue',
      message: `Follow-up for Lead #${testEntityId} is overdue`,
      module: 'FOLLOWUPS',
      entityType: 'FOLLOWUP',
      entityId: testEntityId,
      priority: 'URGENT',
      cooldownHours: 24
    });
    if (notifDedup2 !== null) throw new Error('Deduplication failed: duplicate notification was created within cooldown window!');
    console.log('✓ Verified deduplication: Second overdue trigger within 24 hours returned null (no duplicate created)');

    // 7. Notify Admins Test
    const adminNotifs = await notifyAdminsOfTenant({
      tenantId: tenantA,
      actorUserId: counsellorA1Id,
      type: 'INFO',
      title: 'New Student Lead Captured',
      message: 'New lead from Website Widget',
      module: 'LEADS',
      entityType: 'LEAD',
      entityId: 404,
      priority: 'INFO'
    });
    console.log(`✓ Admin notification broadcast created ${adminNotifs.length} notifications`);
    const adminFetch = await listUserNotifications({ tenantId: tenantA, userId: adminAId });
    if (!adminFetch.notifications.some(n => n.entityId === '404')) throw new Error('Admin A did not receive broadcast notification');
    console.log('✓ Verified Admin broadcast delivery');

    // Cleanup test records
    await pool.query('DELETE FROM notifications WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
    await pool.query('DELETE FROM users WHERE id IN (?, ?, ?, ?)', [adminAId, counsellorA1Id, counsellorA2Id, counsellorB1Id]);
    await pool.query('DELETE FROM tenants WHERE id IN (?, ?)', [tenantA, tenantB]);
    console.log('✓ Cleanup completed successfully');

    console.log('\n--- ALL NOTIFICATION SYSTEM TESTS PASSED SUCCESSFULLY! ---');
    process.exit(0);
  } catch (error) {
    console.error('❌ NOTIFICATION TEST FAILED:', error);
    process.exit(1);
  }
}

runTests();
