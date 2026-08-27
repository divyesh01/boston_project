import { queryClientInstance } from './query-client';

class RecalculationService {
  constructor() {
    this.listeners = new Map();
    this.isProcessing = false;
    this.pendingInvalidations = new Set();
  }

  // Register a listener for data changes
  subscribe(entityName, callback) {
    if (!this.listeners.has(entityName)) {
      this.listeners.set(entityName, new Set());
    }
    this.listeners.get(entityName).add(callback);
    return () => {
      this.listeners.get(entityName)?.delete(callback);
    };
  }

  // Notify all listeners of a data change
  notify(entityName, changeType = 'update', payload = {}) {
    const listeners = this.listeners.get(entityName);
    if (listeners) {
      listeners.forEach(cb => cb({ entity: entityName, type: changeType, payload }));
    }

    // Also invalidate related React Query caches
    this.scheduleInvalidation(entityName, changeType, payload);
  }

  // Schedule cache invalidation (batched)
  scheduleInvalidation(entityName, changeType, payload) {
    this.pendingInvalidations.add(JSON.stringify({ entityName, changeType, payload }));

    // Debounce invalidations to avoid excessive refreshes
    if (!this.invalidationTimeout) {
      this.invalidationTimeout = setTimeout(() => {
        this.processInvalidations();
        this.invalidationTimeout = null;
      }, 100);
    }
  }

  // Process all pending invalidations
  processInvalidations() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const invalidations = [...this.pendingInvalidations].map(s => JSON.parse(s));
    this.pendingInvalidations.clear();

    // Group by entity and invalidate queries
    const entityMap = new Map();
    for (const inv of invalidations) {
      if (!entityMap.has(inv.entityName)) {
        entityMap.set(inv.entityName, []);
      }
      entityMap.get(inv.entityName).push(inv);
    }

    // Invalidate React Query caches
    for (const [entity, changes] of entityMap.entries()) {
      this.invalidateEntityCache(entity, changes);
    }

    this.isProcessing = false;
  }

  // Invalidate React Query caches for an entity
  invalidateEntityCache(entityName, _changes) {
    const queryKeys = this.getQueryKeysForEntity(entityName);
    queryKeys.forEach(key => {
      queryClientInstance.invalidateQueries({ queryKey: key, exact: false });
    });
  }

  // Map entity names to React Query cache keys
  getQueryKeysForEntity(entityName) {
    const keyMap = {
      'OccupancyDay': [['occupancy'], ['gross'], ['latest-date']],
      'SourceDay': [['sources'], ['ota']],
      'GrossRevenueDay': [['gross']],
      'PaymentDay': [['payments']],
      'ClerkShiftRecord': [['clerk']],
      'Expense': [['expenses']],
      'PayrollRun': [['payroll']],
      'Staff': [['staff']],
      'Property': [['properties']],
      'User': [['users']],
    };
    return keyMap[entityName] || [[entityName.toLowerCase()]];
  }

  // Trigger a full recalculation for all dependent metrics
  async triggerFullRecalculation(propertyId, dateRange) {
    const allKeys = [
      ['occupancy'],
      ['sources'],
      ['gross'],
      ['payments'],
      ['clerk'],
      ['expenses'],
      ['payroll'],
      ['staff'],
      ['properties'],
      ['uploads'],
      ['latest-date'],
    ];

    await Promise.all(
      allKeys.map(key => queryClientInstance.invalidateQueries({ queryKey: key, exact: false }))
    );

    // Also trigger a custom event for components that need to recalculate
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent('rri:recalculate', {
        detail: { propertyId, dateRange, timestamp: Date.now() }
      }));
    }
  }

  // Get the singleton instance
  static getInstance() {
    if (!RecalculationService.instance) {
      RecalculationService.instance = new RecalculationService();
    }
    return RecalculationService.instance;
  }
}

RecalculationService.instance = null;

export const recalculationService = RecalculationService.getInstance();
export default RecalculationService;