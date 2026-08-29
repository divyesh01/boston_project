#!/usr/bin/env python3
"""
Nara Support & Security Storage (NARA-A / NARA-B)
-----------------------------------------------
Secure key storage via Windows DPAPI (Data Protection API) and environment.
- Never prints, logs, commits, or exposes raw API keys.
- Manages independent account states for NARA-A and NARA-B.
"""

import sys
import os
import ctypes
from ctypes import wintypes
from typing import Optional

DPAPI_DIR = os.path.expanduser("~/.nara")
DPAPI_FILE_A = os.path.join(DPAPI_DIR, "nara_account_a.dpapi")
DPAPI_FILE_B = os.path.join(DPAPI_DIR, "nara_account_b.dpapi")


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _encrypt_dpapi(data_bytes: bytes, description: str = "NARA_KEY") -> bytes:
    """Encrypts bytes using Windows DPAPI under CurrentUser scope."""
    blob_in = DATA_BLOB(
        len(data_bytes),
        ctypes.cast(ctypes.create_string_buffer(data_bytes), ctypes.POINTER(ctypes.c_char)),
    )
    blob_out = DATA_BLOB()
    if ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in),
        description,
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


def store_key_securely(alias: str, key: str) -> bool:
    """Securely encrypts and stores the key for a given alias ('NARA-A' or 'NARA-B')."""
    if not key or not isinstance(key, str):
        return False
    os.makedirs(DPAPI_DIR, exist_ok=True)
    target_file = DPAPI_FILE_A if alias.upper() in ["NARA-A", "A", "1"] else DPAPI_FILE_B
    enc = _encrypt_dpapi(key.strip().encode("utf-8"), description=f"NARA_{alias}")
    with open(target_file, "wb") as f:
        f.write(enc)
    return True


def get_stored_key(alias: str) -> Optional[str]:
    """Retrieves key from environment variable or decrypted DPAPI storage."""
    alias_norm = alias.upper()
    # Check environment first
    if alias_norm in ["NARA-A", "A", "1"]:
        env_val = os.environ.get("NARA_API_KEY_1") or os.environ.get("NARA_API_KEY_A")
        if env_val:
            return env_val.strip()
        target_file = DPAPI_FILE_A
    else:
        env_val = os.environ.get("NARA_API_KEY_2") or os.environ.get("NARA_API_KEY_B")
        if env_val:
            return env_val.strip()
        target_file = DPAPI_FILE_B

    if not os.path.exists(target_file):
        return None

    try:
        with open(target_file, "rb") as f:
            cipher_bytes = f.read()
        return _decrypt_dpapi(cipher_bytes).decode("utf-8").strip()
    except Exception:
        return None


if __name__ == "__main__":
    if len(sys.argv) >= 2:
        cmd = sys.argv[1]
        if cmd == "--get" and len(sys.argv) >= 3:
            alias = sys.argv[2]
            key = get_stored_key(alias)
            if key:
                print(key)
            else:
                sys.exit(1)
        elif cmd == "--status":
            key_a = get_stored_key("NARA-A")
            key_b = get_stored_key("NARA-B")
            print(f"NARA-A: {'AVAILABLE' if key_a else 'UNAVAILABLE'}")
            print(f"NARA-B: {'AVAILABLE' if key_b else 'UNAVAILABLE'}")
        elif cmd == "--init-keys" and len(sys.argv) >= 4:
            k1 = sys.argv[2]
            k2 = sys.argv[3]
            store_key_securely("NARA-A", k1)
            store_key_securely("NARA-B", k2)
            print("Nara DPAPI keys stored successfully.")
