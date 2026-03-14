/* ============================================================
 * qjson_demo.c — Native QJSON: parse sensor config, roundtrip
 *
 * No dependencies beyond qjson.c.  Arena-allocated, zero malloc.
 *
 * Build:
 *   gcc -O2 -o qjson_demo qjson_demo.c ../../native/qjson.c \
 *       -I../../native
 * ============================================================ */

#include <stdio.h>
#include <string.h>
#include "qjson.h"

int main(void) {
    /* 8KB arena — reused across all parses */
    char arena_buf[8192];
    qj_arena arena;
    qj_arena_init(&arena, arena_buf, sizeof(arena_buf));

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
    qj_val *v = qj_parse(&arena, config, strlen(config));
    if (!v) { printf("Parse failed!\n"); return 1; }

    /* Read values */
    qj_val *name = qj_obj_get(v, "name");
    qj_val *offset = qj_obj_get(v, "offset");
    qj_val *rate = qj_obj_get(v, "sample_rate");
    qj_val *gain = qj_obj_get(v, "gain");
    qj_val *channels = qj_obj_get(v, "channels");

    printf("  name:        %s\n", qj_str(name));
    printf("  offset:      %s (BigDecimal)\n", offset->str.s);
    printf("  sample_rate: %s (BigInt)\n", rate->str.s);
    printf("  gain:        %s (BigFloat)\n", gain->str.s);
    printf("  channels:    %d items\n", qj_arr_len(channels));

    /* Stringify — machine-format output (quoted keys, no comments) */
    char out[512];
    int n = qj_stringify(v, out, sizeof(out));
    printf("\n=== Stringify (machine format) ===\n");
    printf("  %d bytes: %s\n", n, out);

    /* Round-trip: parse the stringified output */
    qj_arena_reset(&arena);
    qj_val *v2 = qj_parse(&arena, out, n);
    printf("\n=== Round-trip ===\n");
    printf("  offset type: %s\n",
        v2 && qj_obj_get(v2, "offset")->type == QJ_BIGDEC ? "BigDecimal (preserved)" : "LOST");
    printf("  rate type:   %s\n",
        v2 && qj_obj_get(v2, "sample_rate")->type == QJ_BIGINT ? "BigInt (preserved)" : "LOST");
    printf("  gain type:   %s\n",
        v2 && qj_obj_get(v2, "gain")->type == QJ_BIGFLOAT ? "BigFloat (preserved)" : "LOST");

    printf("\n  Arena used: %zu / %zu bytes (%.0f%%)\n",
        arena.used, sizeof(arena_buf),
        (double)arena.used / sizeof(arena_buf) * 100);

    return 0;
}
