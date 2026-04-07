/**
 * Insurer ID to Name mappings
 * Source: Nova Health API (https://api.health.curacel.co/nova-api/hmos)
 * Last updated: 2026-04-02
 * 
 * Usage:
 *   import { getInsurerName, getInsurerId, INSURER_MAP } from '@/lib/insurerMapping';
 *   const name = getInsurerName(1); // "Redcare Health Services Ltd"
 *   const id = getInsurerId("Redcare Health Services Ltd"); // 1
 */

// ID → Name mapping
export const INSURER_MAP = {
  1: "Redcare Health Services Ltd",
  2: "Curacel",
  3: "Rothauge Healthcare Limited",
  4: "UAP Old Mutual Uganda",
  5: "HALLMARK HEALTH SERVICES LIMITED",
  6: "Hadiel",
  7: "Wellness HMO",
  8: "HealthAssur",
  9: "TOTAL HEALTH TRUST",
  10: "HCI Healthcare Limited",
  11: "AXA",
  12: "Acacia Health Insurance Ltd",
  13: "Novo Health Africa",
  14: "Alleanza Health",
  15: "SUNU Health Private Scheme",
  16: "LifeWORTH HMO",
  17: "Gorah Healthcare Limited",
  18: "Jubilee Health Kenya",
  19: "Equity Health Insurance Limited",
  22: "ACE Medical Insurance",
  24: "SUNU HEALTH NHIS",
  25: "UAP Hospital Cash",
  26: "Mitera Health LTD",
  27: "Springtide HMO",
  28: "Lifeworth NHIS NYSC",
  36: "Mediplan Healthcare Limited",
  37: "Dot HMO",
  38: "Jubilee Health Tanzania",
  39: "Ckline Healthcare Limited",
  45: "Metro Health HMO",
  59: "PHILIPS HMO",
  60: "EDOHIS",
  64: "THT KC GAMING PLAN",
  73: "Jubilee Health Uganda",
  74: "Ultimate Health Management Service Limited",
  75: "ZENITHE INSURANCE",
  76: "First Guaranty Healthcare Limited",
  80: "Spectra Health Mutual Insurance",
  81: "Serene Healthcare Limited",
  83: "Saheh Egypt",
  84: "COSMOPOLITAN HEALTH INSURANCE LTD",
  85: "Osun State Insurance Agency",
  86: "Zenor Health Care",
  87: "GNI Healthcare Ltd",
  91: "THT Hadiel Care",
  92: "EnvoyX",
  95: "LEADWAY Health",
  118: "Sekure Platform",
  158: "Inchbay Services Limited",
  166: "Hadiel Tech",
  199: "Smart Health Medicare Limited",
  200: "Century Medicaid Services Limited",
  201: "AI WATANIYA",
  202: "SUSU",
  208: "Jubilee In-Patient",
  209: "DEFMIS",
  210: "SIfax Group",
  211: "Atlantasanad Assurance",
  212: "scandium testing",
  213: "Muyesky POC Insurer",
  214: "Juniper Insurance",
  218: "BRITAM INSURER",
  219: "Britam Outpatient",
  221: "Synergy Wellcare Medicaid Limited",
  281: "Hygeia HMO",
  283: "AXA Mansard Health Limited (formerly AXA Mansard HMO)",
  284: "Phillips Health",
  297: "Reliance HMO",
  298: "Avon HMO",
  299: "AIICO",
  300: "Clearline",
  301: "United Healthcare International Limited",
  302: "Anchor HMO",
  303: "Greenbay",
  304: "Swift HMO",
  305: "Royal Exchange Healthcare Ltd",
  306: "Well Health Network Limited",
  307: "Prepaid Medicare",
  308: "Princeton Health",
  309: "Prohealth HMO",
  310: "Regenix Healthcare",
  311: "Songhai HMO",
  312: "Venus Medicare",
  313: "Susu Assurance",
  314: "Wellxai",
  315: "GA Insurance",
  316: "Hadiel sept",
  317: "Lybia TPA",
  320: "Jubilee Uganda Inpatient"
};

// Name → ID reverse mapping (for lookups by name)
export const INSURER_NAME_TO_ID = Object.fromEntries(
  Object.entries(INSURER_MAP).map(([id, name]) => [name.toLowerCase(), parseInt(id)])
);

/**
 * Get insurer name by ID
 * @param {number|string} id - Insurer ID
 * @returns {string|null} - Insurer name or null if not found
 */
export function getInsurerName(id) {
  return INSURER_MAP[id] || null;
}

/**
 * Get insurer ID by name (case-insensitive)
 * @param {string} name - Insurer name
 * @returns {number|null} - Insurer ID or null if not found
 */
export function getInsurerId(name) {
  if (!name) return null;
  return INSURER_NAME_TO_ID[name.toLowerCase()] || null;
}

/**
 * Map an array of claims with insurer IDs to include insurer names
 * Useful when fetching from Metabase (which has IDs) to match Supabase format (which has names)
 * @param {Array} claims - Array of claim objects with hmo_id field
 * @param {string} idField - Field name containing the insurer ID (default: 'hmo_id')
 * @param {string} nameField - Field name to populate with insurer name (default: 'insurer')
 * @returns {Array} - Claims with insurer names added
 */
export function mapClaimsWithInsurerNames(claims, idField = 'hmo_id', nameField = 'insurer') {
  return claims.map(claim => ({
    ...claim,
    [nameField]: getInsurerName(claim[idField]) || `Unknown (ID: ${claim[idField]})`
  }));
}

/**
 * Get all insurers as an array of {id, name} objects
 * @returns {Array<{id: number, name: string}>}
 */
export function getAllInsurers() {
  return Object.entries(INSURER_MAP).map(([id, name]) => ({
    id: parseInt(id),
    name
  }));
}
