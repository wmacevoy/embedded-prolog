"""y8-core: Canonical interval projection and comparison via libbf.

One C implementation (libbf directed rounding), callable from Python.
Bit-identical to the C and JS implementations.

Usage:
    from y8_core import project, cmp, decimal_cmp

    lo, hi = project("67432.50")   # → (67432.5, 67432.5) exact
    lo, hi = project("0.1")        # → (0.0999..., 0.1) 1-ULP bracket

    cmp(42.0, 42.0, None, 43.0, 43.0, None)  # → -1 (42 < 43)
"""

import ctypes
import ctypes.util
import os
import struct

_lib = None
_lib_path = None


def _find_lib():
    """Find the y8_core shared library."""
    # Check next to this file
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ("liby8_core.so", "liby8_core.dylib", "liby8_core.dll"):
        path = os.path.join(here, name)
        if os.path.exists(path):
            return path
    # Check in the build directory
    root = os.path.dirname(os.path.dirname(here))
    for name in ("liby8_core.so", "liby8_core.dylib"):
        path = os.path.join(root, "build", name)
        if os.path.exists(path):
            return path
    return None


def _load():
    global _lib, _lib_path
    if _lib is not None:
        return _lib

    _lib_path = _find_lib()
    if _lib_path is None:
        raise ImportError(
            "y8_core shared library not found. "
            "Build with: make -C packages/y8-core"
        )

    _lib = ctypes.CDLL(_lib_path)

    _lib.y8_project.argtypes = [
        ctypes.c_char_p, ctypes.c_int,
        ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double)
    ]
    _lib.y8_project.restype = None

    _lib.y8_cmp.argtypes = [
        ctypes.c_double, ctypes.c_double, ctypes.c_char_p, ctypes.c_int,
        ctypes.c_double, ctypes.c_double, ctypes.c_char_p, ctypes.c_int,
    ]
    _lib.y8_cmp.restype = ctypes.c_int

    _lib.y8_decimal_cmp.argtypes = [
        ctypes.c_char_p, ctypes.c_int,
        ctypes.c_char_p, ctypes.c_int,
    ]
    _lib.y8_decimal_cmp.restype = ctypes.c_int

    return _lib


def project(raw):
    """Project decimal string → (lo, hi) IEEE double interval.

    lo = largest double ≤ exact value (round_down)
    hi = smallest double ≥ exact value (round_up)

    Exact doubles: lo == hi.
    Non-exact: nextafter(lo, +inf) == hi (1-ULP bracket).
    """
    lib = _load()
    lo = ctypes.c_double()
    hi = ctypes.c_double()
    raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else raw
    lib.y8_project(raw_bytes, len(raw_bytes),
                   ctypes.byref(lo), ctypes.byref(hi))
    return lo.value, hi.value


def cmp(a_lo, a_hi, a_str, b_lo, b_hi, b_str):
    """Compare two projected values.  Returns -1, 0, or 1.

    Uses intervals for fast accept/reject, falls through to
    libbf exact comparison in the overlap zone.
    """
    lib = _load()
    a_bytes = a_str.encode("utf-8") if isinstance(a_str, str) else a_str
    b_bytes = b_str.encode("utf-8") if isinstance(b_str, str) else b_str
    a_len = len(a_bytes) if a_bytes else 0
    b_len = len(b_bytes) if b_bytes else 0
    return lib.y8_cmp(
        ctypes.c_double(a_lo), ctypes.c_double(a_hi),
        a_bytes, a_len,
        ctypes.c_double(b_lo), ctypes.c_double(b_hi),
        b_bytes, b_len
    )


def decimal_cmp(a, b):
    """Compare two decimal strings numerically via libbf.

    Returns -1 (a < b), 0 (a == b), 1 (a > b).
    Arbitrary precision — no floating point.
    """
    lib = _load()
    a_bytes = a.encode("utf-8") if isinstance(a, str) else a
    b_bytes = b.encode("utf-8") if isinstance(b, str) else b
    return lib.y8_decimal_cmp(a_bytes, len(a_bytes), b_bytes, len(b_bytes))
