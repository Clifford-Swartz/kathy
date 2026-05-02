// Prompt router. Imports the per-facility-type system prompts and exposes a
// single getSystemPrompt(facilityType) helper used by both server.js and
// the local test harness. Keep this file logic-free.

import { SYSTEM_PROMPT_CCRC } from './prompts-ccrc.js';
import { SYSTEM_PROMPT_AL } from './prompts-al.js';

export const FACILITY_TYPES = ['ccrc', 'senior_living', 'mixed'];

export function getSystemPrompt(facilityType) {
  switch ((facilityType || '').toLowerCase()) {
    case 'senior_living':
      return SYSTEM_PROMPT_AL;
    case 'mixed':
      // Mixed campuses (e.g. CCRC with significant AL/MC component): use
      // the CCRC prompt as the spine and append the AL playbook so the
      // model has both research paths available in one turn.
      return SYSTEM_PROMPT_CCRC + '\n\n--- ADDITIONAL CONTEXT FOR MIXED CAMPUSES ---\n\n' +
        'This facility is a mixed campus combining CCRC contract structures with rental Senior Living (IL/AL/MC) components. Apply the CCRC analysis above, AND ALSO consult the senior-living research playbook below for the rental-side care quality, deficiencies, and operator data. The dashboard you emit should populate both CCRC fields (entrance fees, contract type, Deal Quality, Entity Stability) AND senior-living fields (care_quality, regulatory_legal, operator_risk score) when the data exists.\n\n' +
        SYSTEM_PROMPT_AL;
    case 'ccrc':
    default:
      return SYSTEM_PROMPT_CCRC;
  }
}

// Back-compat: anything still importing SYSTEM_PROMPT gets the CCRC version.
export const SYSTEM_PROMPT = SYSTEM_PROMPT_CCRC;
