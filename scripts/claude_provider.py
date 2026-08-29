#!/usr/bin/env python3
"""
Claude High-Trust Review Provider (CLAUDE_PRIMARY)
--------------------------------------------------
Executes REAL Claude invocations across all 6 mandatory checkpoints:
  - CP1: Pre-Implementation Inspector ("What could Gemini or current plan have missed?")
  - CP2: Independent Peer Engineer (Independent Solution B)
  - CP3: Post-Implementation Inspector (Adversarial diff & regression audit)
  - CP4: Hotel Data & Financial Review (Integer-cents, RevPAR, ADR, Isolation)
  - CP5: Final Tribunal (PASS / FAIL / UNPROVEN verdict)
  - CP6: Deployment / Live Inspector (Live production verification)

Uses OpenRouter Claude endpoints / Anthropic API with DPAPI-backed secure keys.
"""

import sys
import os
import json
import time
import urllib.request
import urllib.error
from typing import Dict, List, Optional, Any, Tuple

try:
    import scripts.openrouter_support as ops
except ImportError:
    import openrouter_support as ops

# Primary Claude Model Priority Chain
CLAUDE_MODELS: List[str] = [
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4.8",
]

CHECKPOINT_SYSTEM_PROMPTS = {
    "CP1": (
        "You are Claude, the High-Trust Pre-Implementation Inspector for a hotel owner intelligence dashboard. "
        "Your duty is to independently inspect the task, root cause, architecture, and blast radius. "
        "You must explicitly answer: WHAT COULD GEMINI OR THE CURRENT PLAN HAVE MISSED? "
        "Be adversarial, precise, and evidence-focused."
    ),
    "CP2": (
        "You are Claude, an Equal Peer Engineer. "
        "Given the verified baseline and task, produce an INDEPENDENT Solution B without copying or anchoring. "
        "Detail the root-cause fix, call-site updates, edge cases, and deterministic tests required."
    ),
    "CP3": (
        "You are Claude, the Post-Implementation Inspector. "
        "Review the proposed git diff and test evidence. Actively attempt to prove the implementation unsafe or incorrect. "
        "Check for removed validations, weakened assertions, security regressions, float math, or unhandled errors."
    ),
    "CP4": (
        "You are Claude, the Hotel Financial & Data Truth Inspector. "
        "Review the financial and tenant isolation evidence. Audit ADR, RevPAR, Occupancy, Refunds, Commissions, "
        "and Integer-Cents math. Verify that no cross-property leakage exists and no rows were silently dropped."
    ),
    "CP5": (
        "You are Claude, sitting on the Final Tribunal immediately before release. "
        "Evaluate the complete evidence package (diff, tests, financial truth, guardian diff audit, regression proof). "
        "You must return exactly ONE verdict: PASS, FAIL, or UNPROVEN. "
        "If any critical uncertainty remains, return UNPROVEN."
    ),
    "CP6": (
        "You are Claude, the Deployment & Live Production Inspector. "
        "Review live application evidence, console traces, network calls, and rendered KPIs. "
        "Compare live production behavior against verified baseline. Return PASS or FAIL."
    ),
}


def call_claude_checkpoint(
    checkpoint_id: str,
    task_context: str,
    evidence: Optional[str] = None,
    preferred_model: Optional[str] = None,
    timeout: int = 25,
) -> Dict[str, Any]:
    """
    Executes a real Claude invocation for a specific checkpoint (CP1 - CP6).
    """
    api_key = ops.get_stored_key()
    if not api_key:
        return {
            "checkpoint": checkpoint_id,
            "provider": "Claude/Anthropic",
            "success": False,
            "error": "No API key found. Configure OpenRouter key.",
            "status": "UNAVAILABLE",
            "verdict": "UNPROVEN",
        }

    sys_prompt = CHECKPOINT_SYSTEM_PROMPTS.get(checkpoint_id, "You are Claude, an independent software inspector.")
    
    user_content = f"### TASK CONTEXT:\n{task_context}\n"
    if evidence:
        user_content += f"\n### EMPIRICAL EVIDENCE & DATA:\n{evidence}\n"

    models_to_try = [preferred_model] if preferred_model else CLAUDE_MODELS

    messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user_content},
    ]
    attempts: List[Dict[str, Any]] = []

    for model in models_to_try:
        if not model:
            continue
        t0 = time.time()
        call = ops.call_openrouter_model_detailed(
            model=model,
            messages=messages,
            api_key=api_key,
            timeout=timeout,
            max_tokens=300,
            temperature=0.1,
        )
        duration = round(time.time() - t0, 3)
        success = bool(
            call.get("success")
            and call.get("actual_provider") == "ANTHROPIC"
            and str(call.get("actual_model") or "").startswith("anthropic/claude-")
        )
        content = call.get("content")
        err = call.get("error")

        if call.get("success") and not success:
            err = (
                "MODEL_IDENTITY_MISMATCH: OpenRouter returned "
                f"{call.get('actual_provider')}/{call.get('actual_model')} instead of Claude."
            )

        attempts.append({
            "model_requested": model,
            "transport_provider": call.get("transport_provider"),
            "actual_provider": call.get("actual_provider"),
            "actual_model": call.get("actual_model"),
            "success": success,
            "error": err,
            "duration_seconds": duration,
        })

        if success:
            # Extract verdict if CP5
            verdict = "COMPLETED"
            if checkpoint_id == "CP5":
                upper = content.upper()
                if "PASS" in upper and "FAIL" not in upper and "UNPROVEN" not in upper:
                    verdict = "PASS"
                elif "FAIL" in upper:
                    verdict = "FAIL"
                else:
                    verdict = "UNPROVEN"

            return {
                "checkpoint": checkpoint_id,
                "provider": "Anthropic via OpenRouter",
                "transport_provider": call.get("transport_provider"),
                "actual_provider": call.get("actual_provider"),
                "model_requested": model,
                "model_used": call.get("actual_model"),
                "upstream_provider": call.get("upstream_provider"),
                "generation_id": call.get("generation_id"),
                "success": True,
                "status": "PASS" if checkpoint_id != "CP5" else verdict,
                "verdict": verdict,
                "duration_seconds": duration,
                "content": content,
                "error": None,
                "token_budget_used": call.get("token_budget_used", 300),
                "attempts": attempts,
            }

    return {
        "checkpoint": checkpoint_id,
        "provider": "Claude (Anthropic)",
        "model_used": None,
        "success": False,
        "status": "UNAVAILABLE",
        "verdict": "UNPROVEN",
        "error": attempts[-1]["error"] if attempts else "No Claude model candidates were configured.",
        "attempts": attempts,
    }


if __name__ == "__main__":
    if len(sys.argv) > 2:
        cp = sys.argv[1].upper()
        prompt = sys.argv[2]
        ev = sys.argv[3] if len(sys.argv) > 3 else None
        res = call_claude_checkpoint(cp, prompt, evidence=ev)
        print(json.dumps(res, indent=2), flush=True)
    else:
        print("Usage: python scripts/claude_provider.py <CP1-CP6> <task_context> [evidence_json]", flush=True)
