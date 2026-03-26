/* libbf_shim.c — bridge libbf's cutils API to QuickJS's cutils.
 *
 * QuickJS renamed dbuf_putc → __dbuf_putc but libbf still uses
 * dbuf_putc.  This shim provides the libbf names.
 *
 * Compile libbf with QuickJS cutils only (no libbf/cutils.c).
 * This file provides the missing symbols.
 */

#include <stddef.h>
#include <stdint.h>
#include "cutils.h"

/* libbf expects dbuf_putc but QuickJS only has __dbuf_putc */
int dbuf_putc(DynBuf *s, uint8_t c) {
    return dbuf_put(s, &c, 1);
}
