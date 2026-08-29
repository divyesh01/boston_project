#!/usr/bin/env python3
"""
OpenRouter Support Provider (OPENROUTER_PRIMARY)
-----------------------------------------------
Support-provider for Gemini and Opus engineering workflows.
- Secure key storage via Windows DPAPI (Data Protection API)
- Uses ONLY free OpenRouter models (:free or openrouter/free)
- Automatic fallback chain with limited retries (crisp 8s timeout)
- Support workflows: research, logs, edge cases, test ideas, diff review, dependency notes
- Main engineering remains with Gemini and Opus
"""

import sys
import os
import json
import time
import getpass
import urllib.request
import urllib.error
import ctypes
import re
from ctypes import wintypes
from typing import Dict, List, Optional, Any, Tuple

DPAPI_DIR = os.path.expanduser("~/.openrouter")
DPAPI_FILE = os.path.join(DPAPI_DIR, "openrouter_primary.dpapi")

# Priority model lists by task profile (ONLY free models, responsive models first)
TASK_MODEL_PROFILES: Dict[str, List[str]] = {
    "fast": [
        "google/gemma-4-26b-a4b-it:free",
        "poolside/laguna-xs-2.1:free",
        "liquid/lfm-2.5-2.6b:free",
        "google/gemma-4-31b-it:free",
        "openrouter/free",
    ],
    "coding": [
        "poolside/laguna-s-2.1:free",
        "poolside/laguna-xs-2.1:free",
        "cohere/north-mini-code:free",
        "google/gemma-4-26b-a4b-it:free",
        "z-ai/glm-5.2:free",
    ],
    "reasoning": [
        "google/gemma-4-31b-it:free",
        "google/gemma-4-26b-a4b-it:free",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "thinkingmachines/inkling:free",
        "openrouter/free",
    ],
    "review": [
        "google/gemma-4-31b-it:free",
        "minimax/minimax-m3:free",
        "z-ai/glm-5.2:free",
        "nvidia/nemotron-3.5-content-safety:free",
        "openrouter/free",
    ],
    "support": [
        # Fast & capable support for research, logs, edge cases, test ideas, notes
        "google/gemma-4-26b-a4b-it:free",
        "poolside/laguna-xs-2.1:free",
        "google/gemma-4-31b-it:free",
        "poolside/laguna-s-2.1:free",
        "openrouter/free",
    ],
}


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _encrypt_dpapi(data_bytes: bytes) -> bytes:
    """Encrypts bytes using Windows DPAPI under CurrentUser scope."""
    blob_in = DATA_BLOB(
        len(data_bytes),
        ctypes.cast(ctypes.create_string_buffer(data_bytes), ctypes.POINTER(ctypes.c_char)),
    )
    blob_out = DATA_BLOB()
    if ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in),
        "OPENROUTER_PRIMARY",
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    ):
        out = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
        return out
    raise RuntimeError("DPAPI encryption failed")


def _decrypt_dpapi(cipher_bytes: bytes) -> bytes:
    """Decrypts bytes using Windows DPAPI under CurrentUser scope."""
    blob_in = DATA_BLOB(
        len(cipher_bytes),
        ctypes.cast(ctypes.create_string_buffer(cipher_bytes), ctypes.POINTER(ctypes.c_char)),
    )
    blob_out = DATA_BLOB()
    if ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    ):
        out = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
        return out
    raise RuntimeError("DPAPI decryption failed")


def store_key_securely(key: Optional[str] = None) -> bool:
    """Prompts securely for an OpenRouter API key and stores it via Windows DPAPI."""
    if not key:
        print("[PROMPT] Enter OpenRouter API Key (input will not be displayed):", flush=True)
        key = getpass.getpass("API Key: ").strip()

    if not key:
        print("[ERROR] No key entered. Aborted.", file=sys.stderr, flush=True)
        return False

    os.makedirs(DPAPI_DIR, exist_ok=True)
    enc = _encrypt_dpapi(key.encode("utf-8"))
    with open(DPAPI_FILE, "wb") as f:
        f.write(enc)

    print(f"[SUCCESS] OpenRouter key securely encrypted and stored with Windows DPAPI at: {DPAPI_FILE}", flush=True)
    print("[SECURITY] Key is protected under Windows CurrentUser scope. Never logged or printed.", flush=True)
    return True


def get_stored_key() -> Optional[str]:
    """Retrieves and decrypts the OpenRouter key in memory using Windows DPAPI."""
    if not os.path.exists(DPAPI_FILE):
        return None
    try:
        with open(DPAPI_FILE, "rb") as f:
            cipher_bytes = f.read()
        return _decrypt_dpapi(cipher_bytes).decode("utf-8").strip()
    except Exception as e:
        print(f"[ERROR] Failed to decrypt DPAPI key: {e}", file=sys.stderr, flush=True)
        return None


def _provider_identity(model: Optional[str]) -> str:
    normalized = (model or "").strip().lower()
    if normalized.startswith("anthropic/claude-"):
        return "ANTHROPIC"
    if "/" in normalized:
        return normalized.split("/", 1)[0].upper()
    return "UNKNOWN"


def _affordable_token_limit(error_text: str, requested_tokens: int) -> Optional[int]:
    match = re.search(r"can only afford\s+(\d+)", error_text or "", re.IGNORECASE)
    if not match:
        return None
    limit = int(match.group(1))
    return limit if 0 < limit < requested_tokens else None


def call_openrouter_model_detailed(
    model: str,
    messages: List[Dict[str, str]],
    api_key: str,
    timeout: int = 8,
    max_tokens: int = 500,
    temperature: float = 0.2,
    _budget_retry_remaining: int = 1,
) -> Dict[str, Any]:
    """
    Executes a single chat completion against OpenRouter API with a strict timeout.
    Returns transport, actual provider/model identity, content, and error details.
    """
    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/divyesh01/boston_project",
        "X-Title": "BostonProject-Support",
        "User-Agent": "BostonProject-SupportProvider/1.0",
    }
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            choices = data.get("choices", [])
            content = choices[0].get("message", {}).get("content", "") if choices else ""
            actual_model = data.get("model") or model
            identity = {
                "transport_provider": "OPENROUTER",
                "actual_provider": _provider_identity(actual_model),
                "actual_model": actual_model,
                "upstream_provider": data.get("provider"),
            }
            if not isinstance(content, str) or not content.strip():
                return {
                    "success": False,
                    "content": None,
                    "error": "EMPTY_RESPONSE",
                    **identity,
                }
            return {
                "success": True,
                "content": content.strip(),
                "error": None,
                "generation_id": data.get("id"),
                "usage": data.get("usage"),
                **identity,
            }
    except urllib.error.HTTPError as he:
        err_body = ""
        try:
            err_body = he.read().decode("utf-8", errors="ignore")[:300]
        except Exception:
            pass
        if he.code == 402 and _budget_retry_remaining > 0:
            affordable = _affordable_token_limit(err_body, max_tokens)
            if affordable:
                retry = call_openrouter_model_detailed(
                    model=model,
                    messages=messages,
                    api_key=api_key,
                    timeout=timeout,
                    max_tokens=affordable,
                    temperature=temperature,
                    _budget_retry_remaining=_budget_retry_remaining - 1,
                )
                retry["token_budget_reduced_from"] = max_tokens
                retry["token_budget_used"] = affordable
                return retry
        return {
            "success": False,
            "content": None,
            "error": f"HTTP {he.code}: {he.reason} - {err_body}",
            "transport_provider": "OPENROUTER",
            "actual_provider": "UNKNOWN",
            "actual_model": None,
            "upstream_provider": None,
        }
    except Exception as ex:
        return {
            "success": False,
            "content": None,
            "error": str(ex),
            "transport_provider": "OPENROUTER",
            "actual_provider": "UNKNOWN",
            "actual_model": None,
            "upstream_provider": None,
        }


def call_openrouter_model(
    model: str,
    messages: List[Dict[str, str]],
    api_key: str,
    timeout: int = 8,
    max_tokens: int = 500,
    temperature: float = 0.2,
) -> Tuple[bool, Optional[str], Optional[str]]:
    """Backward-compatible tuple wrapper around the identity-aware call."""
    result = call_openrouter_model_detailed(
        model=model,
        messages=messages,
        api_key=api_key,
        timeout=timeout,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return result["success"], result.get("content"), result.get("error")


def execute_support_query(
    prompt: str,
    task_type: str = "support",
    system_prompt: Optional[str] = None,
    preferred_model: Optional[str] = None,
    max_retries: int = 3,
    verbose: bool = True,
) -> Dict[str, Any]:
    """
    Executes a support query with automatic fallback across free OpenRouter models.
    Stops on first success. Limits retries to max_retries.
    """
    api_key = get_stored_key()
    if not api_key:
        return {
            "provider": "OpenRouter",
            "alias": "OPENROUTER_PRIMARY",
            "success": False,
            "error": "No DPAPI key found. Run with --set-key to configure.",
            "fallback_used": False,
            "model_used": None,
        }

    # Build model candidate chain
    candidates: List[str] = []
    if preferred_model:
        if not (preferred_model.endswith(":free") or preferred_model == "openrouter/free"):
            return {
                "provider": "OpenRouter",
                "alias": "OPENROUTER_PRIMARY",
                "success": False,
                "error": f"Model {preferred_model} is not a free model. Only :free models allowed.",
            }
        candidates.append(preferred_model)

    profile_models = TASK_MODEL_PROFILES.get(task_type, TASK_MODEL_PROFILES["support"])
    for m in profile_models:
        if m not in candidates:
            candidates.append(m)

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    else:
        messages.append({
            "role": "system",
            "content": (
                "You are an expert AI support assistant for engineering workflows. "
                "Provide concise, precise, evidence-based technical support."
            ),
        })
    messages.append({"role": "user", "content": prompt})

    attempts: List[Dict[str, Any]] = []
    models_to_try = candidates[: max_retries + 1]

    for idx, model in enumerate(models_to_try):
        if verbose:
            print(f"[*] Trying {model} (attempt {idx + 1}/{len(models_to_try)})...", flush=True)

        t0 = time.time()
        success, content, err = call_openrouter_model(model, messages, api_key, timeout=8)
        duration = round(time.time() - t0, 3)

        attempts.append({
            "model": model,
            "attempt_number": idx + 1,
            "duration_seconds": duration,
            "success": success,
            "error": err if not success else None,
        })

        if success:
            if verbose:
                print(f"[+] Success with {model} in {duration}s", flush=True)
            return {
                "provider": "OpenRouter",
                "alias": "OPENROUTER_PRIMARY",
                "success": True,
                "model_requested": candidates[0],
                "model_used": model,
                "fallback_used": idx > 0,
                "total_attempts": idx + 1,
                "duration_seconds": duration,
                "attempts": attempts,
                "content": content,
            }

        if verbose:
            print(f"[-] {model} failed in {duration}s: {err}. Cascading to fallback...", flush=True)

    return {
        "provider": "OpenRouter",
        "alias": "OPENROUTER_PRIMARY",
        "success": False,
        "model_requested": candidates[0],
        "model_used": None,
        "fallback_used": True,
        "total_attempts": len(attempts),
        "attempts": attempts,
        "error": "All free model candidates exhausted without success.",
    }


def run_live_test() -> Dict[str, Any]:
    """Runs a small live test to verify the provider, DPAPI key, model, and fallback."""
    print("==================================================", flush=True)
    print("   OPENROUTER SUPPORT-PROVIDER LIVE VERIFICATION   ", flush=True)
    print("==================================================", flush=True)
    
    test_prompt = "Output in one short sentence: OpenRouter free support test passed."
    res = execute_support_query(
        prompt=test_prompt,
        task_type="fast",
        max_retries=3,
        verbose=True,
    )

    print("\n----------------- TEST SUMMARY -----------------", flush=True)
    print(f"Provider:        {res.get('provider', 'N/A')} ({res.get('alias', 'N/A')})", flush=True)
    print(f"Success:         {res.get('success')}", flush=True)
    print(f"Model Requested: {res.get('model_requested')}", flush=True)
    print(f"Model Used:      {res.get('model_used')}", flush=True)
    print(f"Fallback Used:   {res.get('fallback_used')}", flush=True)
    print(f"Total Attempts:  {res.get('total_attempts')}", flush=True)
    print(f"Duration:        {res.get('duration_seconds')}s", flush=True)

    if res.get("success"):
        print("\nResponse:", flush=True)
        print(f"\"{res.get('content', '').strip()}\"", flush=True)
    else:
        print("\nError:", flush=True)
        print(res.get("error"), flush=True)
        for att in res.get("attempts", []):
            print(f"  - Attempt {att['attempt_number']} ({att['model']}): {att['error']}", flush=True)

    print("==================================================", flush=True)
    return res


if __name__ == "__main__":
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "--set-key":
            store_key_securely()
        elif cmd == "--get":
            k = get_stored_key()
            if k:
                print(k, end="", flush=True)
            sys.exit(0 if k else 1)
        elif cmd == "--test":
            res = run_live_test()
            sys.exit(0 if res.get("success") else 1)
        elif cmd == "--query":
            prompt = sys.argv[2] if len(sys.argv) > 2 else "Hello"
            task = sys.argv[3] if len(sys.argv) > 3 else "support"
            res = execute_support_query(prompt, task_type=task, verbose=False)
            print(json.dumps(res, indent=2), flush=True)
        else:
            print("Usage: python scripts/openrouter_support.py [--set-key | --test | --query <prompt> [task]]", flush=True)
    else:
        run_live_test()
