/**
 * Owner Channel Dictionary & Normalization Engine
 *
 * Normalizes disparate HotelKey source labels (e.g., "EXPEDIA COLLECT", "EHC",
 * "BOOKING.COM", "BHC", "WEB", "WALKIN") into canonical channel definitions,
 * channel groups, and commission profiles.
 *
 * Preserves the raw source for auditability while providing clean, multi-year
 * aggregations and owner economics.
 */

export const CHANNEL_GROUPS = {
  OTA: 'OTA',
  DIRECT: 'Direct',
  CORPORATE: 'Corporate',
  GDS: 'GDS',
  OTHER: 'Other',
};

export const CANONICAL_CHANNELS = [
  {
    name: 'Expedia',
    group: CHANNEL_GROUPS.OTA,
    patterns: [/EXPEDIA/i, /^EHC$/i, /^EAN$/i, /^EPC$/i, /^EXPE?$/i],
    defaultRate: 0.15,
    taxExempt: false,
  },
  {
    name: 'Booking.com',
    group: CHANNEL_GROUPS.OTA,
    patterns: [/BOOKING\.COM/i, /^BOOKING\b/i, /BOOKING\s*(HOTEL|COLLECT|HC)/i, /^BHC$/i, /^BDC$/i, /^BK$/i],
    defaultRate: 0.15,
    taxExempt: false,
  },
  {
    name: 'Hotels.com',
    group: CHANNEL_GROUPS.OTA,
    patterns: [/HOTELS\.COM/i, /^HDC$/i],
    defaultRate: 0.18,
    taxExempt: false,
  },
  {
    name: 'Agoda',
    group: CHANNEL_GROUPS.OTA,
    patterns: [/AGODA/i, /^AGD$/i],
    defaultRate: 0.18,
    taxExempt: false,
  },
  {
    name: 'Priceline',
    group: CHANNEL_GROUPS.OTA,
    patterns: [/PRICELINE/i, /^PLN$/i, /HOTWIRE/i, /^HW$/i],
    defaultRate: 0.16,
    taxExempt: false,
  },
  {
    name: 'Trip.com',
    group: CHANNEL_GROUPS.OTA,
    patterns: [/TRIP\.COM/i, /CTRIP/i, /^TRIP$/i],
    defaultRate: 0.15,
    taxExempt: false,
  },
  {
    name: 'Airbnb',
    group: CHANNEL_GROUPS.OTA,
    patterns: [/AIRBNB/i, /^ABNB$/i],
    defaultRate: 0.03,
    taxExempt: false,
  },
  {
    name: 'Other OTA',
    group: CHANNEL_GROUPS.OTA,
    patterns: [/OTA/i, /EXTRANET/i, /CHANNEL/i, /HOTELTONIGHT/i, /^HT$/i, /HOPPER/i],
    defaultRate: 0.15,
    taxExempt: false,
  },
  {
    name: 'Brand Website',
    group: CHANNEL_GROUPS.DIRECT,
    patterns: [/RR WEBSITE/i, /RED ROOF APP/i, /REDISTAY/i, /REDI-STAY/i, /RED ROOF/i, /^RRI(\.COM)?$/i, /^WEB$/i, /^WEBSITE$/i, /^APP$/i, /ONLINE/i],
    defaultRate: 0.0,
    taxExempt: true,
  },
  {
    name: 'Walk-In',
    group: CHANNEL_GROUPS.DIRECT,
    patterns: [/WALK/i, /^WIN$/i, /^WI$/i],
    defaultRate: 0.0,
    taxExempt: true,
  },
  {
    name: 'Property Direct',
    group: CHANNEL_GROUPS.DIRECT,
    patterns: [/PROPERTY BOOKING/i, /^PRP$/i, /CONTACT CENTER/i, /CENTRAL RESERVATIONS/i, /^CRS$/i, /^CRO$/i, /\bCRO\b/i, /VOICE/i, /PHONE/i, /^FD$/i, /FRONT DESK/i, /^DIR(ECT)?$/i],
    defaultRate: 0.0,
    taxExempt: true,
  },
  {
    name: 'Group & Corporate',
    group: CHANNEL_GROUPS.CORPORATE,
    patterns: [/GROUP/i, /CORP/i, /DIRECT BILL/i, /^DB$/i, /\bDB\b/i, /CONTRACT/i, /HOUSE ACCOUNT/i, /^CLP$/i, /CORPORATE LODGING/i, /LODGING/i],
    defaultRate: 0.0,
    taxExempt: true,
  },
  {
    name: 'GDS & Travel Agent',
    group: CHANNEL_GROUPS.GDS,
    patterns: [/SABRE/i, /AMADEUS/i, /GALILEO/i, /WORLDSPAN/i, /APOLLO/i, /PEGASUS/i, /DHISCO/i, /^IDS$/i, /TRAVEL AGENT/i, /^TA$/i],
    defaultRate: 0.10,
    taxExempt: false,
  },
];

/**
 * Normalizes a raw source label and code into its canonical channel metadata.
 *
 * @param {string} [rawSource=''] The raw PMS source name (e.g. "EXPEDIA HOTEL COLLECT")
 * @param {string} [rawCode=''] The raw PMS source code (e.g. "EHC")
 * @returns {{
 *   rawSource: string,
 *   rawCode: string,
 *   normalizedName: string,
 *   canonicalName: string,
 *   group: string,
 *   isOta: boolean,
 *   isDirect: boolean,
 *   defaultRate: number,
 *   taxExempt: boolean
 * }}
 */
export function normalizeChannel(rawSource = '', rawCode = '') {
  const sourceStr = String(rawSource || '').trim();
  const codeStr = String(rawCode || '').trim();
  const fullText = `${sourceStr} ${codeStr}`.trim();

  if (!fullText) {
    return {
      rawSource: '',
      rawCode: '',
      normalizedName: 'Unknown',
      canonicalName: 'Unknown',
      group: CHANNEL_GROUPS.OTHER,
      isOta: false,
      isDirect: false,
      defaultRate: 0.0,
      taxExempt: false,
    };
  }

  for (const channel of CANONICAL_CHANNELS) {
    for (const pattern of channel.patterns) {
      if (pattern.test(fullText) || (sourceStr && pattern.test(sourceStr)) || (codeStr && pattern.test(codeStr))) {
        return {
          rawSource: sourceStr,
          rawCode: codeStr,
          normalizedName: channel.name,
          canonicalName: channel.name,
          group: channel.group,
          isOta: channel.group === CHANNEL_GROUPS.OTA,
          isDirect: channel.group === CHANNEL_GROUPS.DIRECT,
          defaultRate: channel.defaultRate,
          taxExempt: channel.taxExempt,
        };
      }
    }
  }

  // Fallback for unclassified sources
  const isLikelyOta = /OTA|BOOKING|EXPEDIA|TRAVEL/i.test(fullText);
  const fallbackName = sourceStr || codeStr || 'Other';
  return {
    rawSource: sourceStr,
    rawCode: codeStr,
    normalizedName: fallbackName,
    canonicalName: fallbackName,
    group: isLikelyOta ? CHANNEL_GROUPS.OTA : CHANNEL_GROUPS.OTHER,
    isOta: isLikelyOta,
    isDirect: false,
    defaultRate: isLikelyOta ? 0.15 : 0.0,
    taxExempt: !isLikelyOta,
  };
}

/**
 * Calculates the OTA Dependence Score for a portfolio or property.
 *
 * Thresholds:
 *   Low: < 25% (Healthy direct booking balance)
 *   Moderate: 25% - 40% (Typical franchise performance)
 *   High: 40% - 55% (High commission leakage)
 *   Very High: > 55% (Severe vulnerability to OTA rate controls)
 *
 * @param {number} otaRevenue Gross revenue from OTA channels ($)
 * @param {number} totalRevenue Total gross revenue ($)
 * @returns {{
 *   share: number,
 *   percentage: number,
 *   level: 'Low' | 'Moderate' | 'High' | 'Very High',
 *   color: string,
 *   description: string
 * }}
 */
export function calculateOtaDependence(otaRevenue = 0, totalRevenue = 0) {
  if (!totalRevenue || totalRevenue <= 0) {
    return {
      share: 0,
      percentage: 0,
      level: 'Low',
      color: '#00E096',
      description: 'Zero revenue recorded',
    };
  }

  const share = Math.max(0, Math.min(1, otaRevenue / totalRevenue));
  const percentage = Math.round(share * 1000) / 10;

  if (share < 0.25) {
    return {
      share,
      percentage,
      level: 'Low',
      color: '#00E096',
      description: 'Healthy direct booking balance (< 25% OTA)',
    };
  }
  if (share <= 0.40) {
    return {
      share,
      percentage,
      level: 'Moderate',
      color: '#FFB547',
      description: 'Moderate OTA reliance (25%–40% OTA)',
    };
  }
  if (share <= 0.55) {
    return {
      share,
      percentage,
      level: 'High',
      color: '#FF6B6B',
      description: 'High commission leakage risk (40%–55% OTA)',
    };
  }
  return {
    share,
    percentage,
    level: 'Very High',
    color: '#E63946',
    description: 'Severe OTA dependence (> 55% OTA)',
  };
}

/**
 * Calculates Direct Shift Opportunity.
 * Models the profit gained if a target percentage of OTA bookings shifted to direct channels.
 *
 * @param {Array<{ isOta: boolean, gross: number, commission: number, stays: number }>} channelMetrics
 * @param {number} [shiftPct=0.10] Target shift percentage (default 10%)
 * @returns {{
 *   shiftPct: number,
 *   otaGross: number,
 *   otaCommission: number,
 *   potentialSavings: number,
 *   annualizedSavings: number,
 *   roomsShifted: number
 * }}
 */
export function calculateDirectShiftOpportunity(channelMetrics = [], shiftPct = 0.10) {
  const otaChannels = channelMetrics.filter((c) => c.isOta);
  const otaGross = otaChannels.reduce((acc, c) => acc + (c.gross || 0), 0);
  const otaCommission = otaChannels.reduce((acc, c) => acc + (c.commission || 0), 0);
  const otaStays = otaChannels.reduce((acc, c) => acc + (c.stays || 0), 0);

  const potentialSavings = Math.round(otaCommission * shiftPct * 100) / 100;
  const roomsShifted = Math.round(otaStays * shiftPct);

  return {
    shiftPct,
    otaGross: Math.round(otaGross * 100) / 100,
    otaCommission: Math.round(otaCommission * 100) / 100,
    potentialSavings,
    annualizedSavings: Math.round(potentialSavings * 100) / 100,
    roomsShifted,
  };
}
