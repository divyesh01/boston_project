#!/usr/bin/env python3
import sys
import time
import os

sys.path.insert(0, os.path.dirname(__file__))
import openrouter_support

key = openrouter_support.get_stored_key()
if not key:
    print("[ERROR] No DPAPI key found.")
    sys.exit(1)

models_to_test = [
    "liquid/lfm-2.5-2.6b:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3.5-lightning:free",
    "poolside/laguna-xs-2.1:free",
    "z-ai/glm-5.2:free",
    "openrouter/free"
]

print("=== OPENROUTER FREE MODELS HEALTH CHECK (8s timeout) ===", flush=True)

for m in models_to_test:
    t0 = time.time()
    print(f"[*] Testing {m} ...", end=" ", flush=True)
    success, content, err = openrouter_support.call_openrouter_model(
        model=m,
        messages=[{"role": "user", "content": "Respond with: OK"}],
        api_key=key,
        timeout=8,
        max_tokens=10
    )
    dt = round(time.time() - t0, 2)
    if success:
        cleaned = content.strip().replace("\n", " ") if content else ""
        print(f"PASS ({dt}s) -> '{cleaned}'", flush=True)
    else:
        print(f"FAIL ({dt}s) -> {err}", flush=True)

print("=========================================================", flush=True)
