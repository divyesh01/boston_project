/**
 * Autonomous Engineering Orchestrator
 * -----------------------------------
 * Upgraded with Universal Multi-Provider Model Router & 5-Agent Adversarial Debate Tribunal.
 *
 * Automatically analyzes arbitrary user requests, detects intent and domain,
 * dynamically forms multi-agent squads, dispatches 5-Agent Adversarial Debate Tribunals
 * for critical domains, and executes targeted verification workflows.
 */

import { universalRouter } from './universalModelRouter.js';
import { dualPillarSolver } from './dualPillarSolver.js';
import { debateTribunal } from './adversarialDebateTribunal.js';
import { productionSentinel } from './productionSentinel.js';
import { generateForensicReport } from './sessionForensicReport.js';

export const DOMAINS = {
  FINANCIAL_TRUTH: 'FINANCIAL_TRUTH',
  PROPERTY_ISOLATION: 'PROPERTY_ISOLATION',
  DATA_INGESTION_IMPORT: 'DATA_INGESTION_IMPORT',
  SECURITY_ACCESS: 'SECURITY_ACCESS',
  UI_UX_ACCESSIBILITY: 'UI_UX_ACCESSIBILITY',
  PERFORMANCE_SCALE: 'PERFORMANCE_SCALE',
  VAGUE_AUTODETECT: 'VAGUE_AUTODETECT',
  UNKNOWN_FAILSAFE: 'UNKNOWN_FAILSAFE',
};

export const CONFIDENCE_THRESHOLD = 0.70;

const DOMAIN_RULES = [
  {
    domain: DOMAINS.FINANCIAL_TRUTH,
    keywords: ['revenue', 'adr', 'revpar', 'cents', 'dollar', 'money', 'profit', 'tax', 'payroll', 'expense', 'accounting', 'billing', 'financial', 'ledger', 'balance', 'inaccurate calculation'],
    weight: 1.0,
    riskLevel: 'CRITICAL',
  },
  {
    domain: DOMAINS.PROPERTY_ISOLATION,
    keywords: ['property b', 'property a', 'cross-property', 'tenant', 'multi-tenant', 'room board', 'room 101', 'singlepropertyid', 'property leak', 'leakage across hotels', 'other property', 'wrong hotel'],
    weight: 1.2,
    riskLevel: 'CRITICAL',
  },
  {
    domain: DOMAINS.DATA_INGESTION_IMPORT,
    keywords: ['import', 'csv', 'excel', 'rows', 'missed', 'upload data', 'spreadsheet', 'parse', 'parsing', 'dropped records', 'data loss on import', 'file upload'],
    weight: 1.0,
    riskLevel: 'HIGH',
  },
  {
    domain: DOMAINS.SECURITY_ACCESS,
    keywords: ['security', 'exe', 'malicious', 'magic byte', 'binary', 'upload guard', 'csrf', 'auth', 'injection', 'xss', 'permission', 'unauthorized', 'token', 'exploit'],
    weight: 1.2,
    riskLevel: 'CRITICAL',
  },
  {
    domain: DOMAINS.UI_UX_ACCESSIBILITY,
    keywords: ['confusing', 'ui', 'ux', 'accessibility', 'contrast', 'layout', 'mobile', 'responsive', 'screen reader', 'empty state', 'toast', 'button alignment', 'font', 'visual hierarchy'],
    weight: 1.0,
    riskLevel: 'MEDIUM',
  },
  {
    domain: DOMAINS.PERFORMANCE_SCALE,
    keywords: ['slow', 'paging', 'lag', 'benchmark', 'scale', 'memory', 'render', 'debounce', '5000', '2000 rooms', 'freeze', 'latency', 'optimization', 'fps'],
    weight: 1.0,
    riskLevel: 'MEDIUM',
  },
];

const VAGUE_PHRASES = [
  'fix this',
  'fix this.',
  'something broke',
  'check everything',
  'investigate',
  'audit system',
  'help',
  'not working',
  'broken',
];

/**
 * Classifies prompt into domain, risk level, and intent summary.
 */
export function classifyPrompt(prompt, systemContext = {}) {
  if (!prompt || typeof prompt !== 'string') {
    return {
      primaryDomain: DOMAINS.UNKNOWN_FAILSAFE,
      matchedDomains: [DOMAINS.UNKNOWN_FAILSAFE],
      confidence: 0.0,
      riskLevel: 'HIGH',
      intentSummary: 'Empty or non-string prompt received; routing to UNKNOWN_FAILSAFE general inspection squad.',
      detectedKeywords: [],
      reclassificationRequired: true,
    };
  }

  const normalized = prompt.trim().toLowerCase();

  const isVague = VAGUE_PHRASES.some((v) => normalized === v || normalized.startsWith(v + ' '));
  if (isVague) {
    let inferredDomain = DOMAINS.PROPERTY_ISOLATION;
    if (systemContext?.recentTopic) {
      const match = DOMAIN_RULES.find((r) => r.keywords.some((k) => systemContext.recentTopic.toLowerCase().includes(k)));
      if (match) inferredDomain = match.domain;
    }
    return {
      primaryDomain: DOMAINS.VAGUE_AUTODETECT,
      inferredContextDomain: inferredDomain,
      matchedDomains: [DOMAINS.VAGUE_AUTODETECT, inferredDomain],
      confidence: 0.85,
      riskLevel: 'HIGH',
      intentSummary: `Vague prompt detected ("${prompt}"). Autonomous Orchestrator reconstructed context from system state and active inspection logs.`,
      detectedKeywords: ['[vague_intent_reconstruction]'],
      reclassificationRequired: false,
    };
  }

  const scores = {};
  const matchedKeywords = {};

  for (const rule of DOMAIN_RULES) {
    scores[rule.domain] = 0;
    matchedKeywords[rule.domain] = [];

    for (const kw of rule.keywords) {
      if (normalized.includes(kw)) {
        scores[rule.domain] += rule.weight;
        matchedKeywords[rule.domain].push(kw);
      }
    }
  }

  const sortedDomains = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sortedDomains.length === 0) {
    return {
      primaryDomain: DOMAINS.UNKNOWN_FAILSAFE,
      matchedDomains: [DOMAINS.UNKNOWN_FAILSAFE],
      confidence: 0.2,
      riskLevel: 'HIGH',
      intentSummary: `Novel or unmatched inquiry ("${prompt}"). Routing to UNKNOWN_FAILSAFE general inspection squad rather than guessing.`,
      detectedKeywords: [],
      reclassificationRequired: true,
    };
  }

  const topScore = sortedDomains[0][1];
  const candidateDomain = sortedDomains[0][0];
  const confidence = Number(Math.min(1.0, topScore * 0.4 + 0.4).toFixed(2));
  const matchedRule = DOMAIN_RULES.find((r) => r.domain === candidateDomain);
  const riskLevel = matchedRule?.riskLevel || 'MEDIUM';

  if (confidence < CONFIDENCE_THRESHOLD) {
    return {
      primaryDomain: DOMAINS.UNKNOWN_FAILSAFE,
      candidateDomain,
      matchedDomains: [DOMAINS.UNKNOWN_FAILSAFE, candidateDomain],
      confidence,
      riskLevel: 'HIGH',
      intentSummary: `Low confidence (${confidence} < ${CONFIDENCE_THRESHOLD}) for candidate "${candidateDomain}". Routing to UNKNOWN_FAILSAFE for safe preliminary inspection.`,
      detectedKeywords: matchedKeywords[candidateDomain],
      reclassificationRequired: true,
    };
  }

  return {
    primaryDomain: candidateDomain,
    matchedDomains: sortedDomains.map(([dom]) => dom),
    confidence,
    riskLevel,
    intentSummary: `Detected intent for domain "${candidateDomain}" based on matches: [${matchedKeywords[candidateDomain].join(', ')}].`,
    detectedKeywords: matchedKeywords[candidateDomain],
    reclassificationRequired: false,
  };
}

/**
 * Builds the complete multi-agent orchestration and debate plan.
 */
export function buildOrchestrationPlan(classification, prompt) {
  const { primaryDomain, matchedDomains, riskLevel, reclassificationRequired } = classification;

  const requiresDebate = riskLevel === 'CRITICAL' || riskLevel === 'HIGH' || riskLevel === 'MEDIUM';

  const plan = {
    prompt,
    primaryDomain,
    matchedDomains,
    riskLevel,
    requiresDebate,
    reclassificationRequired: Boolean(reclassificationRequired),
    claudeCheckpoints: [],
    nvidiaNim: null,
    naraHelpers: [],
    adversarialDebate: requiresDebate ? { tribunal: 'Five-Agent Adversarial Debate Tribunal', rounds: 5 } : null,
    researchSpecialist: null,
    deterministicProbes: [],
    routingRationale: '',
  };

  switch (primaryDomain) {
    case DOMAINS.FINANCIAL_TRUTH:
      plan.claudeCheckpoints = [
        { id: 'CP4', role: 'Claude Financial & Tenant Truth Inspector', focus: 'Audit ADR, RevPAR, integer-cents math, zero leakage.' },
        { id: 'CP5', role: 'Claude Final Tribunal Release Gate', focus: 'Evaluate financial consistency and return release verdict.' },
      ];
      plan.nvidiaNim = { role: 'NVIDIA NIM (Data Integrity Pillar)', focus: 'Review transaction atomicity and rounding precision.' };
      plan.researchSpecialist = { role: 'OpenRouter Financial Research Specialist', focus: 'USALI room revenue standards' };
      plan.naraHelpers = [
        { role: 'Nara Financial Calculation Auditor', roleType: 'FINANCIAL_CALCULATION', focus: 'Audit ADR and RevPAR paths.' },
        { role: 'Nara Financial Regression Hunter', roleType: 'TEST_GENERATION', focus: 'Search for multi-currency & tax edge cases.' },
        { role: 'Nara Adversarial Money Fuzzer', roleType: 'ADVERSARIAL_TESTING', focus: 'Generate float-money fuzzing vectors.' },
      ];
      plan.deterministicProbes = [
        'scripts/probe-financial-invariant.mjs',
        'scripts/probe-cents-unit-mismatch.mjs',
        'scripts/probe-revenue-reconciliation.mjs',
        'scripts/probe-float-money.mjs',
      ];
      plan.routingRationale = 'Financial inquiry detected. Dispatched Claude Financial Inspector, 5-Agent Adversarial Debate Tribunal, Diverse Nara Helpers, and 4 deterministic financial probes.';
      break;

    case DOMAINS.PROPERTY_ISOLATION:
      plan.claudeCheckpoints = [
        { id: 'CP1', role: 'Claude Pre-Implementation Inspector', focus: 'Audit multi-property room ID collisions.' },
        { id: 'CP2', role: 'Claude Peer Engineer (Solution B)', focus: 'Architectural isolation: composite keys.' },
        { id: 'CP5', role: 'Claude Final Tribunal Release Gate', focus: 'Evaluate isolation proof.' },
      ];
      plan.nvidiaNim = { role: 'NVIDIA NIM (Multi-Tenant Concurrency)', focus: 'Evaluate concurrent property switching.' };
      plan.adversarialSwarm = { role: 'OpenRouter Adversarial Swarm', focus: 'Multi-tenant collisions' };
      plan.naraHelpers = [
        { role: 'Nara Multi-Tenant Collision Reviewer', roleType: 'DEEP_CODING', focus: 'Examine composite keys.' },
        { role: 'Nara Property Switch Stress Generator', roleType: 'ADVERSARIAL_TESTING', focus: 'Rapid switching transitions.' },
      ];
      plan.deterministicProbes = [
        'scripts/probe-property-isolation.mjs',
        'scripts/probe-roomboard.mjs',
        'scripts/probe-hotel.mjs',
      ];
      plan.routingRationale = 'Cross-property collision detected. Dispatched Claude CP1/CP2/CP5, 5-Agent Adversarial Debate Tribunal, Nara Multi-Tenant Helpers, and 3 property-isolation probes.';
      break;

    case DOMAINS.DATA_INGESTION_IMPORT:
      plan.claudeCheckpoints = [
        { id: 'CP1', role: 'Claude Ingestion Inspector', focus: 'Audit CSV/Excel parsing edge cases.' },
        { id: 'CP3', role: 'Claude Post-Implementation Diff Auditor', focus: 'Verify batch transaction atomicity.' },
      ];
      plan.nvidiaNim = { role: 'NVIDIA NIM (Data Pipeline Integrity)', focus: 'Inspect stream processing and batch buffers.' };
      plan.researchSpecialist = { role: 'OpenRouter Ingestion Specialist (RFC 4180)', focus: 'CSV dialect edge cases' };
      plan.naraHelpers = [
        { role: 'Nara Import Malformed Report Analyzer', roleType: 'PARSER_DATA_INVESTIGATION', focus: 'Analyze malformed reports & schema drift.' },
        { role: 'Nara Independent Solution Architect', roleType: 'ARCHITECTURE_REVIEW', focus: 'Formulate streaming parser design.' },
        { role: 'Nara Parser Fuzzing Generator', roleType: 'ADVERSARIAL_TESTING', focus: 'Adversarial delimiters & encodings.' },
        { role: 'Nara Batch Transaction Rollback Reviewer', roleType: 'FAST_CODE_REVIEW', focus: 'Atomic rollback paths.' },
      ];
      plan.deterministicProbes = [
        'scripts/probe-csv-data-loss.mjs',
        'scripts/probe-import-validation.mjs',
        'scripts/probe-import-rollback-id.mjs',
        'scripts/probe-manual-entry-import.mjs',
      ];
      plan.routingRationale = 'Data ingestion issue detected. Dispatched Claude Ingestion squad, 5-Agent Adversarial Debate Tribunal, Diverse Nara Helpers, and 4 import/rollback probes.';
      break;

    case DOMAINS.SECURITY_ACCESS:
      plan.claudeCheckpoints = [
        { id: 'CP3', role: 'Claude Security Diff Auditor', focus: 'Audit binary headers & RLS enforcement.' },
        { id: 'CP6', role: 'Claude Deployment Security Inspector', focus: 'Inspect CSP headers & SRI hashes.' },
      ];
      plan.nvidiaNim = { role: 'NVIDIA NIM (Security Pillar)', focus: 'Evaluate file size limits & injection vectors.' };
      plan.adversarialSwarm = { role: 'OpenRouter Security Red Team', focus: 'Payload injection vectors' };
      plan.naraHelpers = [
        { role: 'Nara Hostile Payload Generator', roleType: 'ADVERSARIAL_TESTING', focus: 'Polyglot files & magic byte bypasses.' },
        { role: 'Nara Attack Hypothesis Auditor', roleType: 'ARCHITECTURE_REVIEW', focus: 'Privilege escalation trees.' },
      ];
      plan.deterministicProbes = [
        'scripts/probe-upload-guard.mjs',
        'scripts/probe-auth-hardening.mjs',
        'scripts/probe-csrf-default-closed.mjs',
        'scripts/probe-sri-integrity.mjs',
      ];
      plan.routingRationale = 'Security vulnerability detected. Dispatched Claude Security squad, 5-Agent Adversarial Debate Tribunal, Hostile Payload Helpers, and 4 security verification probes.';
      break;

    case DOMAINS.UI_UX_ACCESSIBILITY:
      plan.claudeCheckpoints = [
        { id: 'CP1', role: 'Claude UI/UX Clarity Inspector', focus: 'Evaluate visual hierarchy & layout clarity.' },
      ];
      plan.researchSpecialist = { role: 'OpenRouter UI/UX Specialist (WCAG 2.1 AAA)', focus: 'Visual contrast and accessibility' };
      plan.naraHelpers = [
        { role: 'Nara UI Component Scanner', roleType: 'FAST_CODE_REVIEW', focus: 'Inspect accessibility & contrast.' },
      ];
      plan.deterministicProbes = [
        'scripts/probe-ui-feedback.mjs',
        'scripts/probe-toast-lifecycle.mjs',
        'scripts/probe-ui-disabled-reason.mjs',
        'scripts/probe-motion.mjs',
      ];
      plan.routingRationale = 'UI/UX & Accessibility inquiry. Dispatched Claude Clarity Inspector, 5-Agent Debate, UI Scanner, and 4 UX probes.';
      break;

    case DOMAINS.PERFORMANCE_SCALE:
      plan.claudeCheckpoints = [
        { id: 'CP2', role: 'Claude Scale & Systems Architect', focus: 'Strategies for 5000+ room rendering.' },
      ];
      plan.nvidiaNim = { role: 'NVIDIA NIM (Performance Pillar)', focus: 'Profile render latency & memory footprint.' };
      plan.adversarialSwarm = { role: 'OpenRouter Scale Load Tester', focus: 'Virtualization & memory pressure' };
      plan.naraHelpers = [
        { role: 'Nara Hotspot & Virtualization Analyzer', roleType: 'REPO_ANALYSIS', focus: 'Review 5000+ room rendering bottlenecks.' },
        { role: 'Nara Scale Stress Scenario Generator', roleType: 'TEST_GENERATION', focus: 'Generate high-cardinality room grids.' },
      ];
      plan.deterministicProbes = [
        'scripts/probe-build-chunks.mjs',
        'scripts/probe-pdf-pagination.mjs',
        'scripts/benchmark_performance.mjs',
      ];
      plan.routingRationale = 'Performance & Scale inquiry. Dispatched Claude Systems Architect, NVIDIA Compute Pillar, 5-Agent Debate, Diverse Nara Helpers, and 3 performance probes.';
      break;

    case DOMAINS.VAGUE_AUTODETECT:
      plan.claudeCheckpoints = [
        { id: 'CP1', role: 'Claude Pre-Implementation Inspector', focus: 'Broad adversarial sweep across recently touched files.' },
        { id: 'CP5', role: 'Claude Final Tribunal Release Gate', focus: 'Synthesize all findings.' },
      ];
      plan.nvidiaNim = { role: 'NVIDIA NIM (5-Pillar Review)', focus: 'Evaluate Security, Correctness, Data Integrity, Concurrency, Performance.' };
      plan.researchSpecialist = { role: 'OpenRouter Multi-Disciplinary Inspector', focus: 'Broad diagnostic sweep' };
      plan.adversarialSwarm = { role: 'OpenRouter Adversarial Swarm', focus: 'General regression hunt' };
      plan.naraHelpers = [
        { role: 'Nara Codebase Context Mapper', roleType: 'REPO_ANALYSIS', focus: 'Scan recent logs and file touchpoints.' },
      ];
      plan.deterministicProbes = [
        'scripts/audit-gate.mjs',
        'scripts/verify-all.mjs',
      ];
      plan.routingRationale = 'Vague / General command received. Activated Multi-Disciplinary Tribunal (Claude CP1/CP5, NVIDIA 5-Pillar, 5-Agent Debate, Nara Context Mapper, Master Verification Harness).';
      break;

    case DOMAINS.UNKNOWN_FAILSAFE:
    default:
      plan.claudeCheckpoints = [
        { id: 'CP1', role: 'Claude Pre-Implementation Inspector', focus: 'Inspect repository structure to identify novel intent.' },
      ];
      plan.nvidiaNim = { role: 'NVIDIA NIM Guardian', focus: 'Enforce core safety and financial invariants.' };
      plan.geminiSubagent = { role: 'Gemini Codebase Inspector', focus: 'Explore novel file structures' };
      plan.researchSpecialist = { role: 'OpenRouter Generalist Researcher', focus: 'Safe exploratory inspection' };
      plan.adversarialSwarm = { role: 'OpenRouter Adversarial Swarm', focus: 'Defensive boundary check' };
      plan.naraHelpers = [
        { role: 'Nara Repository Exploration Helper', roleType: 'REPO_ANALYSIS', focus: 'Explore novel file structures.' },
      ];
      plan.deterministicProbes = [
        'scripts/audit-gate.mjs',
        'scripts/verify-all.mjs',
      ];
      plan.reclassificationRequired = true;
      plan.routingRationale = 'Unknown / Novel intent detected. Fail-safe activated: Dispatched Claude CP1, 5-Agent Debate, NVIDIA Guardian, Nara Repo Explorer, and Master Regression Gate.';
      break;
  }

  return plan;
}

/**
 * High-level orchestration execution entry point.
 */
export async function executeAutonomousWorkflow(prompt, context = {}) {
  const classification = classifyPrompt(prompt, context);
  const plan = buildOrchestrationPlan(classification, prompt);

  // 1. Mandatory Dual-Pillar Parallel Solver (Gemini Solution A + Claude Solution B)
  const dualPillarResults = await dualPillarSolver.executeDualPillar(prompt, context);

  // 2. 5-Agent Adversarial Debate Tribunal (with synthesized dual solution context)
  let debateResults = null;
  if (plan.requiresDebate) {
    const debateContext = `Dual-Pillar Synthesis: ${dualPillarResults.synthesis.hybridPlan.architectureSummary}`;
    debateResults = await debateTribunal.conductDebate(prompt, debateContext);
  }

  // 3. Deep Production Sentinel Verification (Live User-Flow & Bundle Audit)
  const productionAudit = await productionSentinel.runFullProductionAudit();

  const forensicReport = generateForensicReport({
    userPrompt: prompt,
    dualPillarResults,
    debateResults,
    productionAudit,
    routerLedger: universalRouter.failoverLedger,
    status: productionAudit.overallVerdict.includes('PASS') ? 'PASS' : 'FAIL',
  });

  return {
    classification,
    plan,
    dualPillarResults,
    debateResults,
    productionAudit,
    forensicReport,
  };
}
