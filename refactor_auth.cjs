const fs = require('fs');
let content = fs.readFileSync('c:/Users/divye/OneDrive/Desktop/boston_project/src/api/base44Client.js', 'utf8');

const authReplacement = `const auth = {
  async isAuthenticated() {
    try {
      const res = await functions.invoke('auth_me');
      return !!res.data?.user;
    } catch { return false; }
  },
  async me() {
    try {
      const res = await functions.invoke('auth_me');
      return res.data?.user;
    } catch { return null; }
  },
  async login(identifier, password, remember = false, totpToken = null) {
    try {
      const res = await functions.invoke('auth_login', { email: identifier, password, mfa_token: totpToken, remember });
      if (res.data?.require_mfa) {
        return { mfaRequired: true, userId: 'mfa_pending', username: identifier };
      }
      return { user: res.data?.user, session: { token: 'http-only' } };
    } catch (err) {
      throw new Error(err.response?.data?.error || 'Login failed');
    }
  },
  async touchSession() {
    // Handled automatically by auth_me slide expiry
  },
  async rotateSession() {
    // Session is handled via cookies
    return { token: 'http-only' };
  },
  async logout(redirect) {
    try {
      await functions.invoke('auth_logout');
    } catch {}
    if (redirect) window.location.href = redirect;
  },
  async resetPasswordRequest(identifier) {
    return functions.invoke('auth_reset_request', { identifier });
  },
  async resetPassword(token, newPassword) {
    return functions.invoke('auth_reset_password', { token, newPassword });
  },
  async registerUser(userData) {
    return functions.invoke('auth_register', { userData });
  },
  async getCurrentSession() {
    return { token: 'http-only' };
  },
  async setSessionToken(token) {
    // No-op for HttpOnly cookies
  }
};`;

const start = content.indexOf('const auth = {');
const end = content.indexOf('const integrations = {');
if (start !== -1 && end !== -1) {
  content = content.substring(0, start) + authReplacement + '\n\n' + content.substring(end);
  fs.writeFileSync('c:/Users/divye/OneDrive/Desktop/boston_project/src/api/base44Client.js', content);
  console.log('auth object replaced');
}
