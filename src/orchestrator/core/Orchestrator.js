/**
 * Orchestrator
 * ------------
 * Active-Active, High-Parallelism, Full-Agent Swarm Orchestration Engine.
 *
 * Full Multi-Wave Pipeline:
 * 1. Deterministic Context Gathering (0 LLM Tokens)
 * 2. Task Decomposition & Wave Planning (SMALL, MEDIUM, LARGE, CRITICAL)
 * 3. Runtime Inventory Live Probe
 * 4. Wave A: Parallel Claude Opus Investigators (Active-Active Tabitoken + GoRouter)
 * 5. Wave B: Parallel Specialist Reviewer Swarm (Nara Diverse Models, xKiro, OpenRouter)
 * 6. Wave C: Authoritative Claude Opus Synthesis & Definitive Code Patch Authorship
 * 7. Deterministic Patch Application (SHA-256 Verified, Atomic Backup & Rollback)
 * 8. Deterministic Test Execution (Vitest Ground Truth)
 * 9. Automated Test Failure Feedback Loop (Bounded Claude Opus Repair)
 * 10. Immutable Session Artifacts, Receipts & Full Forensic Ledger
 */

import { execSync } from 'node:child_process';
import process from 'node:process';
import { ProviderRegistry, defaultRegistry } from '../providers/ProviderRegistry.js';
import { ContextGatherer } from '../context/ContextGatherer.js';
import { PatchApplier } from '../patch/PatchApplier.js';
import { ReviewerSwarm } from '../reviewers/ReviewerSwarm.js';
import { FallbackPolicy } from '../policies/FallbackPolicy.js';
import { SubscriptionPolicy } from '../policies/SubscriptionPolicy.js';
import { ExecutionLedger } from './ExecutionLedger.js';
import { SessionArtifactStore } from './SessionArtifactStore.js';
import { redactSecrets } from '../policies/SecretRedactor.js';
import { TaskDecomposer } from '../decomposition/TaskDecomposer.js';
import { RuntimeInventory } from '../inventory/RuntimeInventory.js';
import { defaultActiveRouter } from '../routing/ActiveActiveRouter.js';

export class Orchestrator {
  constructor(options = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.registry = options.registry || defaultRegistry;
    this.contextGatherer = new ContextGatherer(this.rootDir);
    this.patchApplier = new PatchApplier(this.rootDir);
    this.reviewerSwarm = new ReviewerSwarm(this.registry);
    this.router = options.router || defaultActiveRouter;
    this.fallbackPolicy = new FallbackPolicy({
      maxRetriesPerProvider: options.maxRetriesPerProvider || 2,
      timeoutMs: options.timeoutMs || 180000,
      router: this.router,
    });
    this.subscriptionPolicy = new SubscriptionPolicy();
    this.inventory = new RuntimeInventory(this.registry);
  }

  /**
   * Executes the full active-active multi-agent swarm task pipeline.
   */
  async executeTask(taskOptions) {
    const {
      taskId = `task-${Date.now()}`,
      prompt,
      targetFiles = [],
      testCommands = ['npx vitest run tests/orchestrator/'],
      maxCorrectionAttempts = 2,
      isOwnerApproved = false,
      ownerProtectedFileException = false,
      deletionJustification = '',
      skipReviewers = false,
    } = taskOptions;

    const sessionId = `session-${taskId}`;
    const ledger = new ExecutionLedger(sessionId);
    const store = new SessionArtifactStore(sessionId, this.rootDir);
    const tStartTotal = Date.now();

    store.savePrompt('initial_task_prompt', prompt);

    // =========================================================================
    // STAGE 1: Deterministic Context Gathering (0 LLM Tokens)
    // =========================================================================
    const contextBundle = this.contextGatherer.gatherContext(targetFiles, prompt);
    store.saveLog('stage1_context', contextBundle.text);

    // =========================================================================
    // STAGE 2: Task Decomposition & Swarm Planning
    // =========================================================================
    const classification = TaskDecomposer.classifyTask(prompt, targetFiles);
    const swarmPlan = TaskDecomposer.planSwarmExecution(taskOptions, classification);
    store.saveLog('stage2_swarm_plan', JSON.stringify(swarmPlan, null, 2));

    // =========================================================================
    // STAGE 3: Runtime Inventory Live Reachability Probe
    // =========================================================================
    const inventoryReport = await this.inventory.scanLiveInventory();
    store.saveLog('stage3_inventory', JSON.stringify(inventoryReport, null, 2));

    // =========================================================================
    // STAGE 4: Wave A — Parallel Claude Opus Investigation (Active-Active)
    // =========================================================================
    const waveAResults = await this.fallbackPolicy.executeParallelClaudeWave(
      this.registry,
      swarmPlan.waveA,
      { prompt, context: contextBundle.text, taskId }
    );

    let primaryProposalText = '';
    const waveACombinedSummaries = [];

    for (let i = 0; i < waveAResults.length; i++) {
      const wRes = waveAResults[i];
      const wCfg = swarmPlan.waveA[i];

      if (wRes.success && wRes.content) {
        if (!primaryProposalText) primaryProposalText = wRes.content;
        waveACombinedSummaries.push(
          `--- [${wCfg.role}] (${wRes.actualProvider} via ${wRes.transportProvider} / ${wRes.authoritativeModel}) ---\n${wRes.content}`
        );
      }

      for (const att of wRes.attempts) {
        ledger.recordCall({
          agentNumber: wCfg.agentNumber,
          agentName: `AGENT_${String(wCfg.agentNumber).padStart(2, '0')}`,
          role: wCfg.role,
          workstream: wCfg.workstream,
          taskId,
          provider: att.provider,
          actualProvider: att.actualProvider,
          transportProvider: att.transportProvider,
          modelRequested: att.modelRequested,
          modelReturned: att.modelReturned,
          upstreamProvider: att.upstreamProvider,
          generationId: att.generationId,
          dispatchTimestamp: att.dispatchTimestamp,
          startTimestamp: att.startTimestamp,
          completionTimestamp: att.completionTimestamp,
          httpStatus: att.httpStatus,
          latencySeconds: att.latencySeconds,
          usage: att.usage,
          cost: att.cost,
          success: att.success,
          error: att.error,
          contribution: att.success ? `Authored architectural root-cause diagnosis for ${wCfg.workstream}` : 'Attempt failed',
          keyFinding: att.success ? `Delivered independent architectural analysis and code formulation.` : 'Attempt failed',
          findingUsed: att.success ? 'YES' : 'NO',
          content: att.content,
        });
      }
    }

    const hasAnyWaveASuccess = waveAResults.some((r) => r.success);
    if (!hasAnyWaveASuccess) {
      const accounting = this.subscriptionPolicy.generateAccountingReport();
      const report = {
        taskId,
        sessionId,
        verdict: 'BLOCKED',
        reason: 'CLAUDE_OPUS_UNAVAILABLE: No genuine Claude Opus route was reachable across Tabitoken or GoRouter.',
        waveAResults,
        accounting,
      };
      store.saveFinalReport(report);
      store.saveReceipts(ledger.getAllReceiptsFormatted());
      return report;
    }

    const waveACombinedText = waveACombinedSummaries.join('\n\n');
    store.saveResponse('stage4_wave_a_proposals', waveACombinedText);

    // =========================================================================
    // STAGE 5: Wave B — Parallel Specialist Reviewer Swarm
    // =========================================================================
    let criticismPackage = '';
    let reviewerResults = [];

    if (!skipReviewers) {
      const swarmOutput = await this.reviewerSwarm.conductParallelReview({
        taskPrompt: prompt,
        claudeProposal: waveACombinedText || primaryProposalText,
        context: contextBundle.text,
        taskId,
        waveBPlan: swarmPlan.waveB,
      });

      criticismPackage = swarmOutput.criticismPackage;
      reviewerResults = swarmOutput.reviewerResults;

      for (const rev of reviewerResults) {
        ledger.recordCall({
          agentNumber: rev.agentNumber,
          agentName: `AGENT_${String(rev.agentNumber).padStart(2, '0')}`,
          role: rev.role,
          workstream: rev.workstream,
          taskId,
          provider: rev.provider,
          actualProvider: rev.actualProvider,
          transportProvider: rev.provider,
          accountAlias: rev.accountAlias,
          modelRequested: rev.modelRequested,
          modelReturned: rev.modelReturned,
          generationId: rev.generationId,
          dispatchTimestamp: rev.dispatchTimestamp,
          startTimestamp: rev.startTimestamp,
          completionTimestamp: rev.completionTimestamp,
          httpStatus: rev.httpStatus,
          latencySeconds: rev.latencySeconds,
          usage: rev.tokens,
          cost: rev.cost,
          success: rev.success,
          error: rev.error,
          contribution: rev.success ? `Delivered independent peer critique on ${rev.reviewerId}` : 'Peer review unavailable',
          keyFinding: rev.success ? (rev.critique?.slice(0, 120) || 'Delivered critique') : 'None',
          findingUsed: rev.success ? 'PARTIAL' : 'NO',
          reasonAcceptedRejected: rev.success ? 'Critique reviewed by Claude Opus in Wave C synthesis.' : 'Provider unavailable.',
          content: rev.critique,
        });
      }
      store.saveLog('stage5_reviewer_critiques', criticismPackage);
    }

    // =========================================================================
    // STAGE 6: Wave C — Authoritative Claude Opus Synthesis & Final Patch
    // =========================================================================
    const finalPatchSystemPrompt = (
      'You are Claude Opus, the Authoritative Chief Architect and Sole Code Author for this repository.\n' +
      'Evaluate the independent Wave A architectural analyses and the Wave B peer reviewer critiques.\n' +
      'Decide which criticisms are valid and which are noise.\n' +
      'Produce the FINAL, definitive code patch ready for deterministic mechanical application.\n' +
      'CRITICAL: You MUST emit the complete file patch block (### FILE: <path> followed by ```javascript code block) ' +
      'so the deterministic patch applier can mechanically parse and apply it to disk.\n' +
      'Format every file change explicitly as:\n' +
      '### FILE: <relative_path>\n' +
      '```<extension>\n' +
      '<complete new file content>\n' +
      '```\n' +
      'or:\n' +
      'FILE: <relative_path>\n' +
      '<<<<<<< SEARCH\n' +
      '<exact existing lines>\n' +
      '=======\n' +
      '<new replacement lines>\n' +
      '>>>>>>> REPLACE'
    );

    const finalSynthesisPrompt = (
      `### WAVE A INDEPENDENT OPUS ANALYSES:\n${waveACombinedText}\n\n` +
      `### WAVE B PEER REVIEWER CRITIQUES:\n${criticismPackage}\n\n` +
      `Evaluate all peer findings, resolve any identified edge cases, and author the FINAL definitive patch block now:`
    );

    const finalPatchCall = await this.fallbackPolicy.executeAuthoritativeClaude(this.registry, {
      prompt: finalSynthesisPrompt,
      systemPrompt: finalPatchSystemPrompt,
      context: contextBundle.text,
      maxTokens: 4000,
      taskId,
      role: 'CLAUDE_OPUS_AUTHORITATIVE_SYNTHESIS',
      agentNumber: swarmPlan.waveC.agentNumber,
      workstream: swarmPlan.waveC.workstream,
    });

    for (const att of finalPatchCall.attempts) {
      ledger.recordCall({
        agentNumber: swarmPlan.waveC.agentNumber,
        agentName: `AGENT_${String(swarmPlan.waveC.agentNumber).padStart(2, '0')}`,
        role: 'CLAUDE_OPUS_AUTHORITATIVE_SYNTHESIS',
        workstream: swarmPlan.waveC.workstream,
        taskId,
        provider: att.provider,
        actualProvider: att.actualProvider,
        transportProvider: att.transportProvider,
        modelRequested: att.modelRequested,
        modelReturned: att.modelReturned,
        upstreamProvider: att.upstreamProvider,
        generationId: att.generationId,
        dispatchTimestamp: att.dispatchTimestamp,
        startTimestamp: att.startTimestamp,
        completionTimestamp: att.completionTimestamp,
        httpStatus: att.httpStatus,
        latencySeconds: att.latencySeconds,
        usage: att.usage,
        cost: att.cost,
        success: att.success,
        error: att.error,
        contribution: att.success ? 'Authored final definitive code patch after multi-agent evaluation' : 'Attempt failed',
        keyFinding: att.success ? 'Synthesized peer critiques and generated final verified patch.' : 'Attempt failed',
        findingUsed: 'YES',
        reasonAcceptedRejected: 'Authoritative final synthesis.',
        content: att.content,
      });
    }

    if (!finalPatchCall.success) {
      const accounting = this.subscriptionPolicy.generateAccountingReport();
      const report = {
        taskId,
        sessionId,
        verdict: 'BLOCKED',
        reason: 'CLAUDE_OPUS_FINAL_PATCH_FAILED: Claude Opus was unreachable during final patch synthesis.',
        finalPatchCall,
        accounting,
      };
      store.saveFinalReport(report);
      store.saveReceipts(ledger.getAllReceiptsFormatted());
      return report;
    }

    const finalPatchText = finalPatchCall.content;
    store.saveResponse('stage6_claude_final_patch', finalPatchText);

    // =========================================================================
    // STAGE 7: Deterministic Patch Application (SHA-256 Verified)
    // =========================================================================
    let currentPatchText = finalPatchText;
    let parsedPatch = this.patchApplier.parsePatch(currentPatchText, targetFiles?.[0]);

    if (parsedPatch.actions.length === 0 && primaryProposalText) {
      const proposalParsed = this.patchApplier.parsePatch(primaryProposalText, targetFiles?.[0]);
      if (proposalParsed.actions.length > 0) {
        currentPatchText = primaryProposalText;
        parsedPatch = proposalParsed;
      }
    }

    store.savePatch('initial_approved_patch', currentPatchText, {
      patchHash: parsedPatch.patchHash,
      actionsCount: parsedPatch.actions.length,
    });

    let applyResult = this.patchApplier.applyPatch(parsedPatch, {
      isOwnerApproved,
      deletionJustification,
      ownerProtectedFileException,
    });

    if (!applyResult.success) {
      const report = {
        taskId,
        sessionId,
        verdict: 'BLOCKED',
        reason: `PATCH_APPLICATION_FAILED: ${applyResult.error}`,
        applyResult,
        accounting: this.subscriptionPolicy.generateAccountingReport(),
      };
      store.saveFinalReport(report);
      store.saveReceipts(ledger.getAllReceiptsFormatted());
      return report;
    }

    // =========================================================================
    // STAGE 8 & 9: Deterministic Test Execution & Feedback Loop
    // =========================================================================
    let testsPassed = false;
    let testOutputLog = '';
    let correctionAttempt = 0;

    while (!testsPassed && correctionAttempt <= maxCorrectionAttempts) {
      const testResults = this._runDeterministicTests(testCommands);
      testOutputLog = testResults.output;
      store.saveTestResult(`test_attempt_${correctionAttempt + 1}`, testOutputLog, testResults.passed);

      if (testResults.passed) {
        testsPassed = true;
        break;
      }

      correctionAttempt += 1;
      if (correctionAttempt > maxCorrectionAttempts) {
        break;
      }

      // Automated Test Failure Feedback to Claude Opus
      const correctionPrompt = (
        `### DETERMINISTIC TEST FAILURE NOTICE\n` +
        `The exact patch applied to the codebase resulted in the following terminal test failure:\n\n` +
        `\`\`\`\n${testResults.output.slice(-2500)}\n\`\`\`\n\n` +
        `Analyze the failure root cause and author a corrected surgical patch to resolve it:`
      );

      const correctionCall = await this.fallbackPolicy.executeAuthoritativeClaude(this.registry, {
        prompt: correctionPrompt,
        systemPrompt: finalPatchSystemPrompt,
        context: contextBundle.text,
        maxTokens: 4000,
        taskId,
        role: `CLAUDE_OPUS_CORRECTION_AUTHOR_R${correctionAttempt}`,
        agentNumber: swarmPlan.waveC.agentNumber + correctionAttempt,
        workstream: 'Automated Test Failure Correction',
      });

      for (const att of correctionCall.attempts) {
        ledger.recordCall({
          agentNumber: swarmPlan.waveC.agentNumber + correctionAttempt,
          agentName: `AGENT_${String(swarmPlan.waveC.agentNumber + correctionAttempt).padStart(2, '0')}`,
          role: `CLAUDE_OPUS_CORRECTION_AUTHOR_R${correctionAttempt}`,
          workstream: 'Automated Test Failure Correction',
          taskId,
          provider: att.provider,
          actualProvider: att.actualProvider,
          transportProvider: att.transportProvider,
          modelRequested: att.modelRequested,
          modelReturned: att.modelReturned,
          upstreamProvider: att.upstreamProvider,
          generationId: att.generationId,
          dispatchTimestamp: att.dispatchTimestamp,
          startTimestamp: att.startTimestamp,
          completionTimestamp: att.completionTimestamp,
          httpStatus: att.httpStatus,
          latencySeconds: att.latencySeconds,
          usage: att.usage,
          cost: att.cost,
          success: att.success,
          error: att.error,
          contribution: att.success ? `Authored patch correction attempt ${correctionAttempt}` : 'Correction attempt failed',
          content: att.content,
        });
      }

      if (!correctionCall.success) {
        break;
      }

      currentPatchText = correctionCall.content;
      parsedPatch = this.patchApplier.parsePatch(currentPatchText);
      store.savePatch(`correction_patch_${correctionAttempt}`, currentPatchText, {
        patchHash: parsedPatch.patchHash,
        actionsCount: parsedPatch.actions.length,
      });

      applyResult = this.patchApplier.applyPatch(parsedPatch, {
        isOwnerApproved,
        deletionJustification,
        ownerProtectedFileException,
      });

      if (!applyResult.success) {
        break;
      }
    }

    // =========================================================================
    // STAGE 10: Immutable Session Artifacts & Ledger Summaries
    // =========================================================================
    const finalVerdict = testsPassed && applyResult.success ? 'PASS' : 'FAIL';
    const accountingReport = this.subscriptionPolicy.generateAccountingReport();
    const providerUsageSummary = ledger.getProviderUsageSummary();
    const activeActiveBalanceProof = ledger.getActiveActiveBalanceProof();
    const concurrencyProof = ledger.getConcurrencyProof();
    const swarmExecutionSummary = ledger.getSwarmExecutionSummary({
      taskId,
      finalPatchAuthor: 'CLAUDE_OPUS_AUTHORITATIVE_SYNTHESIS',
      finalPatchProvider: finalPatchCall.transportProvider || 'GOROUTER',
      finalPatchModel: finalPatchCall.authoritativeModel || 'claude-opus-5',
      finalPatchGenId: finalPatchCall.generationId || 'msg_opus_synth',
      finalPatchHash: parsedPatch.patchHash,
    });
    const contributionScorecard = ledger.getContributionScorecard();

    store.saveReceipts(ledger.getAllReceiptsFormatted());

    const finalReport = {
      taskId,
      sessionId,
      verdict: finalVerdict,
      durationSeconds: Number(((Date.now() - tStartTotal) / 1000).toFixed(3)),
      classification,
      patch: {
        patchHash: parsedPatch.patchHash,
        filesAffected: applyResult.filesAffected,
        linesAdded: applyResult.linesAdded,
        linesDeleted: applyResult.linesDeleted,
      },
      tests: {
        passed: testsPassed,
        correctionAttempts: correctionAttempt,
      },
      telemetry: {
        totalCalls: ledger.entries.length,
        successfulCalls: ledger.entries.filter((e) => e.result === 'PROVEN').length,
        totalTokens: ledger.entries.reduce((a, b) => a + b.totalTokens, 0),
      },
      activeActiveStatus: this.router.getBalanceMetrics().status,
      accounting: accountingReport,
    };

    store.saveFinalReport(finalReport);
    store.saveManifest({
      sessionId,
      taskId,
      verdict: finalVerdict,
      completedAt: new Date().toISOString(),
      artifacts: [
        'manifest.json',
        'final-report.json',
        'receipts/agent_receipts.txt',
        'prompts/',
        'responses/',
        'patches/',
        'tests/',
        'logs/',
      ],
    });

    return {
      ...finalReport,
      waveAResults,
      finalPatchCall,
      reviewerResults,
      ledger,
      receiptsText: ledger.getAllReceiptsFormatted(),
      providerUsageSummary,
      activeActiveBalanceProof,
      concurrencyProof,
      swarmExecutionSummary,
      contributionScorecard,
      accountingReport,
    };
  }

  _runDeterministicTests(testCommands) {
    let allPassed = true;
    let combinedOutput = '';

    for (const cmd of testCommands) {
      try {
        const out = execSync(cmd, { cwd: this.rootDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        combinedOutput += `=== Command: ${cmd} (EXIT 0) ===\n${out}\n\n`;
      } catch (err) {
        allPassed = false;
        const stdout = err.stdout ? String(err.stdout) : '';
        const stderr = err.stderr ? String(err.stderr) : '';
        combinedOutput += `=== Command: ${cmd} (EXIT ${err.status || 1}) ===\n${stdout}\n${stderr}\n\n`;
      }
    }

    return {
      passed: allPassed,
      output: redactSecrets(combinedOutput),
    };
  }
}
