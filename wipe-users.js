export default async function run(base44) {
  try {
    const allUsers = await base44.asServiceRole.entities.User.filter({}, null, 1000, 0);
    console.log(`Found ${allUsers.length} users to delete.`);
    
    let deletedCount = 0;
    for (const user of allUsers) {
      await base44.asServiceRole.entities.User.delete(user.id);
      console.log(`Deleted user ${user.id}`);
      deletedCount++;
    }
    
    console.log(`Successfully deleted ${deletedCount} user(s). You can now register a new account.`);
  } catch (err) {
    console.error('Failed to wipe users:', err.message);
  } finally {
    process.exit(0);
  }
}
