import { describe, it, expect } from 'vitest';
import {
  isRootUser,
  resolvePropertyScope,
  isPropertyAuthorized,
  hasPermission,
  validateCsrf,
} from '../../base44/utils/auth.js';

describe('base44/utils/auth.js — authorization utilities', () => {
  describe('isRootUser', () => {
    it('returns true for owner and admin', () => {
      expect(isRootUser({ role: 'owner' })).toBe(true);
      expect(isRootUser({ role: 'admin' })).toBe(true);
    });

    it('returns false for other roles or missing user', () => {
      expect(isRootUser({ role: 'manager' })).toBe(false);
      expect(isRootUser({ role: 'front_desk' })).toBe(false);
      expect(isRootUser({ role: 'accountant' })).toBe(false);
      expect(isRootUser({ role: 'read_only' })).toBe(false);
      expect(isRootUser(null)).toBe(false);
      expect(isRootUser({})).toBe(false);
    });
  });

  describe('resolvePropertyScope — fail-closed invariant', () => {
    it('returns null (unrestricted bypass) for owner and admin', () => {
      expect(resolvePropertyScope({ role: 'owner' })).toBeNull();
      expect(resolvePropertyScope({ role: 'admin' })).toBeNull();
      expect(resolvePropertyScope({ role: 'owner', property_access: null })).toBeNull();
    });

    it('returns null for explicit property_access === "all"', () => {
      expect(resolvePropertyScope({ role: 'manager', property_access: 'all' })).toBeNull();
      expect(resolvePropertyScope({ role: 'front_desk', property_access: 'all' })).toBeNull();
    });

    it('returns string array for valid array grants', () => {
      expect(resolvePropertyScope({ role: 'manager', property_access: ['10', '20'] })).toEqual(['10', '20']);
      expect(resolvePropertyScope({ role: 'front_desk', property_access: [1, 2] })).toEqual(['1', '2']);
    });

    it('fails closed (returns []) for missing, null, empty or malformed property_access', () => {
      expect(resolvePropertyScope({ role: 'manager' })).toEqual([]);
      expect(resolvePropertyScope({ role: 'manager', property_access: null })).toEqual([]);
      expect(resolvePropertyScope({ role: 'manager', property_access: undefined })).toEqual([]);
      expect(resolvePropertyScope({ role: 'manager', property_access: 'manager' })).toEqual([]);
      expect(resolvePropertyScope({ role: 'manager', property_access: {} })).toEqual([]);
      expect(resolvePropertyScope({ role: 'manager', property_access: true })).toEqual([]);
    });
  });

  describe('isPropertyAuthorized', () => {
    it('grants access to root users for any valid property', () => {
      expect(isPropertyAuthorized({ role: 'owner' }, 'prop-1')).toBe(true);
      expect(isPropertyAuthorized({ role: 'admin' }, 42)).toBe(true);
    });

    it('grants access to property_access === "all" users for any property', () => {
      expect(isPropertyAuthorized({ role: 'manager', property_access: 'all' }, 'prop-1')).toBe(true);
    });

    it('grants access only to listed properties in array grant', () => {
      const user = { role: 'manager', property_access: ['42', '100'] };
      expect(isPropertyAuthorized(user, '42')).toBe(true);
      expect(isPropertyAuthorized(user, 42)).toBe(true);
      expect(isPropertyAuthorized(user, '100')).toBe(true);
      expect(isPropertyAuthorized(user, '999')).toBe(false);
    });

    it('denies access when propertyId is missing or empty', () => {
      expect(isPropertyAuthorized({ role: 'owner' }, '')).toBe(false);
      expect(isPropertyAuthorized({ role: 'owner' }, null)).toBe(false);
      expect(isPropertyAuthorized({ role: 'owner' }, undefined)).toBe(false);
    });

    it('fails closed when non-root user has malformed or missing property_access', () => {
      expect(isPropertyAuthorized({ role: 'manager', property_access: null }, '42')).toBe(false);
      expect(isPropertyAuthorized({ role: 'manager', property_access: undefined }, '42')).toBe(false);
      expect(isPropertyAuthorized({ role: 'manager', property_access: 'bad_string' }, '42')).toBe(false);
    });
  });

  describe('hasPermission', () => {
    it('always returns true for owner and admin', () => {
      expect(hasPermission({ role: 'owner' }, 'any_permission')).toBe(true);
      expect(hasPermission({ role: 'admin' }, 'any_permission')).toBe(true);
    });

    it('resolves default permissions based on role', () => {
      expect(hasPermission({ role: 'manager' }, 'import_reports')).toBe(true);
      expect(hasPermission({ role: 'manager' }, 'manage_settings')).toBe(false);

      expect(hasPermission({ role: 'front_desk' }, 'import_reports')).toBe(true);
      expect(hasPermission({ role: 'front_desk' }, 'manage_expenses')).toBe(false);

      expect(hasPermission({ role: 'accountant' }, 'import_reports')).toBe(false);
      expect(hasPermission({ role: 'accountant' }, 'export_reports')).toBe(true);

      expect(hasPermission({ role: 'read_only' }, 'import_reports')).toBe(false);
      expect(hasPermission({ role: 'read_only' }, 'view_dashboard')).toBe(true);
    });

    it('honors granular permission overrides on user object', () => {
      const customAccountant = {
        role: 'accountant',
        permissions: { import_reports: true },
      };
      expect(hasPermission(customAccountant, 'import_reports')).toBe(true);

      const restrictedManager = {
        role: 'manager',
        permissions: { import_reports: false },
      };
      expect(hasPermission(restrictedManager, 'import_reports')).toBe(false);
    });

    it('returns false for null or unknown roles', () => {
      expect(hasPermission(null, 'view_dashboard')).toBe(false);
      expect(hasPermission({ role: 'unknown_role' }, 'view_dashboard')).toBe(false);
    });
  });

  describe('validateCsrf', () => {
    const makeReq = (headerVal, cookieVal) => ({
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'x-csrf-token') return headerVal;
          if (name.toLowerCase() === 'cookie') return cookieVal;
          return null;
        },
      },
    });

    it('returns true when header and __Host-csrf_token cookie match', () => {
      const token = 'csrf-secret-123';
      const req = makeReq(token, `base44_session=abc; __Host-csrf_token=${token}`);
      expect(validateCsrf(req)).toBe(true);
    });

    it('returns false on token mismatch', () => {
      const req = makeReq('token-a', 'base44_session=abc; __Host-csrf_token=token-b');
      expect(validateCsrf(req)).toBe(false);
    });

    it('returns false when header or cookie is missing', () => {
      expect(validateCsrf(makeReq(null, '__Host-csrf_token=xyz'))).toBe(false);
      expect(validateCsrf(makeReq('xyz', null))).toBe(false);
      expect(validateCsrf(makeReq('xyz', 'base44_session=abc'))).toBe(false);
    });
  });
});
