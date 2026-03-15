/* ============================================================
 * y8_demo.c — y8 native API: parse sensor config, roundtrip
 *
 * No dependencies beyond y8.c.  Arena-allocated, zero malloc.
 *
 * Build:
 *   gcc -O2 -o y8_demo y8_demo.c ../../native/y8.c \
 *       -I../../native
 * ============================================================ */

#include <stdio.h>
#include <string.h>
#include "y8.h"

int main(void) {
    /* 8KB arena — reused across all parses */
    char arena_buf[8192];
    y8_arena arena;
    y8_arena_init(&arena, arena_buf, sizeof(arena_buf));

    /* Parse a QJSON sensor config (human-authored) */
    const char *config =
        "{\n"
        "  // Greenhouse sensor calibration\n"
        "  name: \"thermocouple-7\",\n"
        "  offset: 0.003M,             /* BigDecimal — precise */\n"
        "  sample_rate: 1000N,          /* BigInt */\n"
        "  gain: 1.00045L,              /* BigFloat — high precision */\n"
        "  channels: [1, 2, 3,],        /* trailing comma OK */\n"
        "}";

    printf("=== Parse QJSON config ===\n");
    y8_val *v = y8_parse(&arena, config, strlen(config));
    if (!v) { printf("Parse failed!\n"); return 1; }

    /* Read values */
    y8_val *name = y8_obj_get(v, "name");
    y8_val *offset = y8_obj_get(v, "offset");
    y8_val *rate = y8_obj_get(v, "sample_rate");
    y8_val *gain = y8_obj_get(v, "gain");
    y8_val *channels = y8_obj_get(v, "channels");

    printf("  name:        %s\n", y8_str(name));
    printf("  offset:      %s (BigDecimal)\n", offset->str.s);
    printf("  sample_rate: %s (BigInt)\n", rate->str.s);
    printf("  gain:        %s (BigFloat)\n", gain->str.s);
    printf("  channels:    %d items\n", y8_arr_len(channels));

    /* Stringify — machine-format output (quoted keys, no comments) */
    char out[512];
    int n = y8_stringify(v, out, sizeof(out));
    printf("\n=== Stringify (machine format) ===\n");
    printf("  %d bytes: %s\n", n, out);

    /* Round-trip: parse the stringified output */
    y8_arena_reset(&arena);
    y8_val *v2 = y8_parse(&arena, out, n);
    printf("\n=== Round-trip ===\n");
    printf("  offset type: %s\n",
        v2 && y8_obj_get(v2, "offset")->type == Y8_BIGDEC ? "BigDecimal (preserved)" : "LOST");
    printf("  rate type:   %s\n",
        v2 && y8_obj_get(v2, "sample_rate")->type == Y8_BIGINT ? "BigInt (preserved)" : "LOST");
    printf("  gain type:   %s\n",
        v2 && y8_obj_get(v2, "gain")->type == Y8_BIGFLOAT ? "BigFloat (preserved)" : "LOST");

    printf("\n  Arena used: %zu / %zu bytes (%.0f%%)\n",
        arena.used, sizeof(arena_buf),
        (double)arena.used / sizeof(arena_buf) * 100);

    return 0;
}
