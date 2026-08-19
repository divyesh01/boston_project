import { db, base44 } from '../src/api/base44Client.js';
import crypto from 'crypto';

async function run() {
  console.log("Starting test...");
  
  // Create a user
  const email = `test_${Date.now()}@test.com`;
  const resReg = await db.auth.registerUser({ email, username: email, password: 'password123', full_name: 'Test', role: 'user' });
  const user = resReg.user;
  console.log("Registered:", user.id);
  
  // Login
  const resLogin = await db.auth.login(email, 'password123');
  console.log("Logged in:", resLogin.user.id);
  
  // Get me
  const meBefore = await db.auth.me();
  console.log("Me before:", meBefore ? 'Object' : 'null', meBefore?.is_active);
  
  // Disable user using admin endpoint
  // We don't have an admin session here. Let's just use serviceRole via test script if possible.
  // Wait, I can't easily get service role here because I'm in frontend code.
}

run().catch(console.error);
