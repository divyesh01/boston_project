import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'fs';

// Since we cannot easily mount full Vite/JSX in node without setup, 
// we'll run a textual demonstration probe mimicking the logic inside ProtectedRoute.jsx and AuthContext.jsx.
console.log("=== PROBE: Account Disabled Reason ===");

// Initial state
let user = { id: 1, is_active: true };
let accountRestricted = null;
let restrictedStatus = null;

// Simulate handleCrossTabRevocation
console.log("\n1. Admin disables user in another tab. BroadcastChannel fires with status='disabled'.");
console.log("-> AuthContext.jsx runs handleCrossTabRevocation(message)");

// Current broken logic:
let messageStatus = 'disabled';
user = null; // setUser(null) is called
accountRestricted = messageStatus;

console.log(`State after handleCrossTabRevocation:`);
console.log(`   user: ${user}`);
console.log(`   accountRestricted: '${accountRestricted}'`);

// Simulate ProtectedRoute.jsx rendering
console.log("\n2. ProtectedRoute.jsx re-renders.");

let isAccountDisabled = user?.is_active === false;
let effectiveRestriction = restrictedStatus || accountRestricted;

console.log(`   isAccountDisabled: ${isAccountDisabled}`);
console.log(`   effectiveRestriction: '${effectiveRestriction}'`);

if (effectiveRestriction) {
  let title = effectiveRestriction === 'revoked' ? 'Account Restricted' : 'Account Disabled';
  console.log(`-> RESULTS: Generic Amber Banner is shown! Title: [${title}] Message: [Your account is no longer active...]`);
}

if (isAccountDisabled) {
  console.log(`-> RESULTS: Big Red Account Disabled screen is shown!`);
}

if (!isAccountDisabled && effectiveRestriction === 'disabled') {
  console.log("\n❌ DEFECT CONFIRMED: The user was disabled, but the big red Account Disabled screen (isAccountDisabled) was skipped because `user` was null. The generic amber banner was shown instead.");
}

// Simulate validateCurrentAccountStatus
console.log("\n=== PROBE: validateCurrentAccountStatus Fallback ===");
console.log("1. User refreshes page or navigates without receiving the cross-tab message.");
accountRestricted = null; // Cleared on reload
user = { id: 1, is_active: true }; // Local state hasn't been updated

console.log("-> validateCurrentAccountStatus runs.");
let me = null; // db.auth.me() returns null for revoked sessions
let returnedStatus = 'revoked'; // Because me is null, it returns revoked

restrictedStatus = returnedStatus;
effectiveRestriction = restrictedStatus || accountRestricted;
isAccountDisabled = user?.is_active === false;

console.log(`State after validateCurrentAccountStatus:`);
console.log(`   restrictedStatus: '${restrictedStatus}'`);
console.log(`   effectiveRestriction: '${effectiveRestriction}'`);

if (effectiveRestriction) {
  let title = effectiveRestriction === 'revoked' ? 'Account Restricted' : 'Account Disabled';
  console.log(`-> RESULTS: Generic Amber Banner is shown! Title: [${title}] Message: [Your account is no longer active...]`);
}

console.log("\n❌ DEFECT CONFIRMED: The user was disabled, but the UI shows 'Account Restricted' because validateCurrentAccountStatus returned 'revoked'.");
