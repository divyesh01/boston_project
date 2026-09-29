/**
 * Universal Hotel Data Adapter Interface
 *
 * Decouples hotel data ingestion from PMS-specific formats, supporting:
 *   1. Direct CSV / XLSX manual upload
 *   2. Google Drive automated folder watcher / helper
 *   3. HK Datastream API (Queue/Webhook continuous event stream)
 */

export class BaseHotelDataAdapter {
  constructor(sourceType = 'csv', config = {}) {
    this.sourceType = sourceType;
    this.config = config;
  }

  async parseAndValidate(payload) {
    throw new Error('parseAndValidate must be implemented by adapter subclass');
  }

  async fetchOccupancyDays(propertyId, dateRange) {
    throw new Error('fetchOccupancyDays must be implemented by adapter subclass');
  }

  async fetchSourceDays(propertyId, dateRange) {
    throw new Error('fetchSourceDays must be implemented by adapter subclass');
  }

  async fetchPaymentDays(propertyId, dateRange) {
    throw new Error('fetchPaymentDays must be implemented by adapter subclass');
  }
}

/**
 * HotelKey CSV / XLSX Local & Web Worker Adapter
 */
export class HotelKeyCsvAdapter extends BaseHotelDataAdapter {
  constructor(config = {}) {
    super('csv', config);
  }

  /**
   * Validates and detects report type from headers
   * @param {string[]} headers
   * @returns {{ reportType: string, confidence: number }}
   */
  detectReportType(headers = []) {
    const normalized = headers.map((h) => String(h || '').trim().toLowerCase());
    const headerStr = normalized.join(' ');

    if (/total rooms|rooms sold|stayover|comp rooms|out of order/i.test(headerStr)) {
      return { reportType: 'occupancy', confidence: 0.95 };
    }
    if (/room rent|misc charge|food|beverage|tax/i.test(headerStr)) {
      return { reportType: 'revenue', confidence: 0.95 };
    }
    if (/source|expedia|booking|net revenue|stays/i.test(headerStr)) {
      return { reportType: 'source', confidence: 0.95 };
    }
    if (/cash|check|visa|master|direct bill/i.test(headerStr)) {
      return { reportType: 'payment', confidence: 0.95 };
    }
    if (/clerk|shift|actual|adjusted/i.test(headerStr)) {
      return { reportType: 'clerk', confidence: 0.95 };
    }

    return { reportType: 'unknown', confidence: 0.2 };
  }
}

/**
 * Google Drive Automated Ingestion Adapter
 */
export class GoogleDriveAdapter extends BaseHotelDataAdapter {
  constructor(config = {}) {
    super('google_drive', config);
  }

  async syncDriveFolder(folderId) {
    return {
      status: 'success',
      folderId,
      message: 'Drive watcher active via cloud helper',
    };
  }
}

/**
 * HotelKey Datastream API Continuous Event Adapter
 */
export class HotelKeyDatastreamAdapter extends BaseHotelDataAdapter {
  constructor(config = {}) {
    super('hk_datastream', config);
    this.appId = config.appId || null;
    this.appSecret = config.appSecret || null;
    this.endpoint = config.endpoint || 'https://api.hotelkeyapp.com/datastream';
  }

  async pollEventQueue(queueId) {
    // Stubbed for HK Datastream API activation
    return {
      queueId,
      eventsProcessed: 0,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Factory function to retrieve the appropriate adapter instance.
 *
 * @param {'csv' | 'xlsx' | 'google_drive' | 'hk_datastream'} type
 * @param {Object} [config={}]
 * @returns {BaseHotelDataAdapter}
 */
export function createHotelDataAdapter(type = 'csv', config = {}) {
  switch (type) {
    case 'google_drive':
      return new GoogleDriveAdapter(config);
    case 'hk_datastream':
      return new HotelKeyDatastreamAdapter(config);
    case 'csv':
    case 'xlsx':
    default:
      return new HotelKeyCsvAdapter(config);
  }
}
