// ============================================================
// main.c -- Greenhouse sensor node (native C)
//
// Simulates an ESP32 sensor that:
//   1. Announces itself as online to coordinator + estimator
//   2. Generates temperature and humidity readings every 2 s
//   3. Sends readings as JSON-encoded Prolog terms over UDP
//   4. Listens for calibration commands from the coordinator
//
// Uses the prolog_core.h/c term layer for term construction,
// demonstrating that the same C code used in WASM/QuickJS tests
// runs on the sensor node.
//
// Wire format (matching src/sync.js):
//   atom      -> {"t":"a","n":"name"}
//   num       -> {"t":"n","v":42}
//   compound  -> {"t":"c","f":"functor","a":[...]}
//
// Compile:
//   gcc -O2 -Wall -std=c11 -o sensor main.c native/prolog_core.c \
//       -Inative/ -lm
// ============================================================

#define _POSIX_C_SOURCE 200809L
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>

// POSIX networking
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>

#include "prolog_core.h"

// ── Configuration (from environment) ────────────────────────

#define DEFAULT_SENSOR_ID      "sensor_1"
#define DEFAULT_COORDINATOR     "127.0.0.1:9500"
#define DEFAULT_ESTIMATOR       "127.0.0.1:9501"
#define DEFAULT_LISTEN_PORT     9500
#define READING_INTERVAL_SEC    2
#define UDP_BUF_SIZE            2048

// ── Globals ─────────────────────────────────────────────────

static volatile int g_running = 1;  // cleared by SIGINT/SIGTERM

static PrologCore g_pc;             // the Prolog term engine

// Calibration offsets (updated by coordinator commands)
static double g_temp_offset  = 0.0;
static double g_humid_offset = 0.0;

// ── Signal handler ──────────────────────────────────────────

static void handle_signal(int sig) {
    (void)sig;
    g_running = 0;
}

// ── Resolve "host:port" into a sockaddr_in ──────────────────

static int resolve_addr(const char *hostport, struct sockaddr_in *out) {
    // Make a mutable copy so we can split on ':'
    char buf[256];
    strncpy(buf, hostport, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    char *colon = strrchr(buf, ':');
    if (!colon) {
        fprintf(stderr, "resolve_addr: no ':' in '%s'\n", hostport);
        return -1;
    }
    *colon = '\0';
    const char *host = buf;
    int port = atoi(colon + 1);

    memset(out, 0, sizeof(*out));
    out->sin_family = AF_INET;
    out->sin_port   = htons((uint16_t)port);

    // Try numeric first, then DNS
    if (inet_pton(AF_INET, host, &out->sin_addr) == 1) {
        return 0;
    }

    struct hostent *he = gethostbyname(host);
    if (he && he->h_length >= 4) {
        memcpy(&out->sin_addr, he->h_addr_list[0], 4);
        return 0;
    }

    fprintf(stderr, "resolve_addr: cannot resolve '%s'\n", host);
    return -1;
}

// ── JSON serialization of Prolog terms ──────────────────────
//
// We write JSON directly with snprintf.  The terms we send are
// small and predictable (reading/4, node_status/2), so a 2 KB
// buffer is more than enough.

// Serialize a single term into buf[pos..max).  Returns new pos,
// or -1 on overflow.
static int term_to_json(PrologCore *pc, Term t, char *buf, int pos, int max) {
    int tag = TERM_TAG(t);

    switch (tag) {
    case TAG_ATOM: {
        const char *name = pc_atom_name(pc, ATOM_ID(t));
        int n = snprintf(buf + pos, (size_t)(max - pos),
                         "{\"t\":\"a\",\"n\":\"%s\"}", name);
        if (n < 0 || pos + n >= max) return -1;
        return pos + n;
    }

    case TAG_NUM: {
        int32_t val = NUM_VALUE(t);
        int n = snprintf(buf + pos, (size_t)(max - pos),
                         "{\"t\":\"n\",\"v\":%d}", (int)val);
        if (n < 0 || pos + n >= max) return -1;
        return pos + n;
    }

    case TAG_COMPOUND: {
        uint32_t functor_id = pc_compound_functor(pc, t);
        uint32_t arity      = pc_compound_arity(pc, t);
        const char *fname   = pc_atom_name(pc, functor_id);

        int n = snprintf(buf + pos, (size_t)(max - pos),
                         "{\"t\":\"c\",\"f\":\"%s\",\"a\":[", fname);
        if (n < 0 || pos + n >= max) return -1;
        pos += n;

        for (uint32_t i = 0; i < arity; i++) {
            if (i > 0) {
                if (pos + 1 >= max) return -1;
                buf[pos++] = ',';
            }
            Term arg = pc_compound_arg(pc, t, i);
            pos = term_to_json(pc, arg, buf, pos, max);
            if (pos < 0) return -1;
        }

        if (pos + 2 >= max) return -1;
        buf[pos++] = ']';
        buf[pos++] = '}';
        return pos;
    }

    case TAG_VAR: {
        // Variables shouldn't appear in outgoing messages,
        // but handle gracefully
        uint32_t vid = VAR_ID(t);
        int n = snprintf(buf + pos, (size_t)(max - pos),
                         "{\"t\":\"v\",\"n\":\"V%u\"}", vid);
        if (n < 0 || pos + n >= max) return -1;
        return pos + n;
    }

    default:
        return -1;
    }
}

// Build a complete signal envelope:
// {"kind":"signal","from":"<id>","fact":<term_json>}
static int build_signal(PrologCore *pc, const char *sensor_id,
                        Term fact, char *buf, int max) {
    int pos = snprintf(buf, (size_t)max,
                       "{\"kind\":\"signal\",\"from\":\"%s\",\"fact\":",
                       sensor_id);
    if (pos < 0 || pos >= max) return -1;

    pos = term_to_json(pc, fact, buf, pos, max);
    if (pos < 0) return -1;

    if (pos + 1 >= max) return -1;
    buf[pos++] = '}';
    buf[pos]   = '\0';
    return pos;
}

// ── Send a UDP datagram ─────────────────────────────────────

static void udp_send(int sock, const struct sockaddr_in *dest,
                     const char *data, int len) {
    ssize_t sent = sendto(sock, data, (size_t)len, 0,
                          (const struct sockaddr *)dest,
                          sizeof(struct sockaddr_in));
    if (sent < 0) {
        perror("sendto");
    }
}

// ── Send a signal to a peer ─────────────────────────────────

static void send_signal(int sock, const struct sockaddr_in *dest,
                        PrologCore *pc, const char *sensor_id,
                        Term fact) {
    char buf[UDP_BUF_SIZE];
    int len = build_signal(pc, sensor_id, fact, buf, UDP_BUF_SIZE);
    if (len > 0) {
        udp_send(sock, dest, buf, len);
    }
}

// ── Parse incoming calibration command ──────────────────────
//
// We look for JSON matching:
//   {"kind":"signal","from":"coordinator","fact":
//     {"t":"c","f":"calibration","a":[
//       {"t":"a","n":"<sensor_id>"},
//       {"t":"a","n":"<type>"},
//       {"t":"n","v":<offset>}
//     ]}
//   }
//
// Signal policy: only accept signals from "coordinator" with
// functor "calibration".  Everything else is ignored.
//
// We use simple string matching -- robust enough for the
// predictable wire format, and avoids pulling in a JSON parser.

static void handle_incoming(const char *buf, int len,
                            const char *sensor_id) {
    (void)len;

    // --- Policy check: must be from coordinator ---
    if (!strstr(buf, "\"from\":\"coordinator\"")) {
        return;
    }

    // --- Must be a calibration signal ---
    if (!strstr(buf, "\"f\":\"calibration\"")) {
        return;
    }

    // --- Verify sensor ID match ---
    // Look for our sensor_id in the arguments
    char id_pat[128];
    snprintf(id_pat, sizeof(id_pat), "\"n\":\"%s\"", sensor_id);
    if (!strstr(buf, id_pat)) {
        return;  // calibration not for us
    }

    // --- Extract calibration type and offset ---
    // Find the type atom (second argument): after sensor_id atom,
    // look for the next {"t":"a","n":"<type>"}
    const char *type_str = NULL;
    const char *p = strstr(buf, "\"f\":\"calibration\"");
    if (!p) return;

    // Find "temperature" or "humidity" in the payload
    if (strstr(p, "\"n\":\"temperature\"")) {
        type_str = "temperature";
    } else if (strstr(p, "\"n\":\"humidity\"")) {
        type_str = "humidity";
    } else {
        fprintf(stderr, "[sensor] unknown calibration type\n");
        return;
    }

    // Find the offset value: {"t":"n","v":<number>}
    // The calibration/3 compound has exactly one numeric argument (the offset),
    // so the first {"t":"n","v":...} after the functor is our target.
    const char *vp = strstr(p, "\"t\":\"n\",\"v\":");
    if (!vp) {
        fprintf(stderr, "[sensor] calibration missing offset value\n");
        return;
    }
    // Advance past "t":"n","v": to reach the number
    vp = strstr(vp, "\"v\":");
    if (!vp) return;
    vp += 4;  // skip past "v":

    double offset = strtod(vp, NULL);

    if (strcmp(type_str, "temperature") == 0) {
        g_temp_offset = offset;
        printf("[sensor] calibration: temperature offset = %.1f\n",
               g_temp_offset);
    } else {
        g_humid_offset = offset;
        printf("[sensor] calibration: humidity offset = %.1f\n",
               g_humid_offset);
    }
}

// ── Simulated sensor readings ───────────────────────────────
//
// Temperature: sine wave 15-35 C (period ~120 s) + noise
// Humidity:    sine wave 40-80 % (period ~180 s) + noise

static double sim_temperature(int tick) {
    double base   = 25.0;                       // center of range (15..35)
    double amp    = 10.0;                       // amplitude
    double period = 60.0;                       // ticks (= 120 s at 2 s/tick)
    double phase  = 2.0 * M_PI * tick / period;
    // Deterministic pseudo-noise from tick
    double noise  = ((tick * 7 + 13) % 100 - 50) * 0.04;
    return base + amp * sin(phase) + noise + g_temp_offset;
}

static double sim_humidity(int tick) {
    double base   = 60.0;                       // center of range (40..80)
    double amp    = 20.0;                       // amplitude
    double period = 90.0;                       // ticks (= 180 s at 2 s/tick)
    double phase  = 2.0 * M_PI * tick / period;
    double noise  = ((tick * 11 + 37) % 100 - 50) * 0.06;
    return base + amp * sin(phase) + noise + g_humid_offset;
}

// ── Main ────────────────────────────────────────────────────

int main(void) {
    // ── Read configuration from environment ──
    const char *sensor_id = getenv("SENSOR_ID");
    if (!sensor_id) sensor_id = DEFAULT_SENSOR_ID;

    const char *coordinator_addr = getenv("COORDINATOR_ADDR");
    if (!coordinator_addr) coordinator_addr = DEFAULT_COORDINATOR;

    const char *estimator_addr = getenv("ESTIMATOR_ADDR");
    if (!estimator_addr) estimator_addr = DEFAULT_ESTIMATOR;

    const char *listen_port_str = getenv("LISTEN_PORT");
    int listen_port = listen_port_str ? atoi(listen_port_str) : DEFAULT_LISTEN_PORT;

    printf("[sensor] id=%s  coordinator=%s  estimator=%s  port=%d\n",
           sensor_id, coordinator_addr, estimator_addr, listen_port);

    // ── Resolve peer addresses ──
    struct sockaddr_in coord_sa, est_sa;
    if (resolve_addr(coordinator_addr, &coord_sa) < 0) return 1;
    if (resolve_addr(estimator_addr, &est_sa) < 0) return 1;

    // ── Create UDP socket ──
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) { perror("socket"); return 1; }

    // Bind to listen port
    struct sockaddr_in bind_addr;
    memset(&bind_addr, 0, sizeof(bind_addr));
    bind_addr.sin_family      = AF_INET;
    bind_addr.sin_addr.s_addr = INADDR_ANY;
    bind_addr.sin_port        = htons((uint16_t)listen_port);

    if (bind(sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
        perror("bind");
        close(sock);
        return 1;
    }

    // ── Install signal handlers for graceful shutdown ──
    signal(SIGINT,  handle_signal);
    signal(SIGTERM, handle_signal);

    // ── Initialize the Prolog term engine ──
    pc_init(&g_pc);

    // Pre-intern atoms we use frequently.  This is not required
    // (pc_make_atom auto-interns) but avoids repeated lookups.
    uint32_t a_reading      = pc_intern_atom(&g_pc, "reading");
    uint32_t a_node_status  = pc_intern_atom(&g_pc, "node_status");
    uint32_t a_temperature  = pc_intern_atom(&g_pc, "temperature");
    uint32_t a_humidity     = pc_intern_atom(&g_pc, "humidity");
    uint32_t a_online       = pc_intern_atom(&g_pc, "online");
    uint32_t a_offline      = pc_intern_atom(&g_pc, "offline");
    uint32_t a_sensor_id    = pc_intern_atom(&g_pc, sensor_id);

    // ── Send node_status(sensor_id, online) to peers ──
    printf("[sensor] announcing online status\n");
    {
        Term args[2] = {
            TERM_ATOM(a_sensor_id),
            TERM_ATOM(a_online)
        };
        Term status_fact = pc_make_compound(&g_pc, a_node_status, 2, args);
        send_signal(sock, &coord_sa, &g_pc, sensor_id, status_fact);
        send_signal(sock, &est_sa,   &g_pc, sensor_id, status_fact);
    }

    // ── Main loop ───────────────────────────────────────────
    int tick = 0;
    time_t last_send = 0;

    printf("[sensor] entering main loop (readings every %d s)\n",
           READING_INTERVAL_SEC);

    while (g_running) {
        // ── Check for incoming datagrams (non-blocking) ──
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(sock, &rfds);

        struct timeval tv;
        tv.tv_sec  = 0;
        tv.tv_usec = 200000;  // 200 ms poll

        int ready = select(sock + 1, &rfds, NULL, NULL, &tv);
        if (ready > 0 && FD_ISSET(sock, &rfds)) {
            char rbuf[UDP_BUF_SIZE];
            struct sockaddr_in from_addr;
            socklen_t from_len = sizeof(from_addr);

            ssize_t n = recvfrom(sock, rbuf, sizeof(rbuf) - 1, 0,
                                 (struct sockaddr *)&from_addr, &from_len);
            if (n > 0) {
                rbuf[n] = '\0';
                printf("[sensor] recv: %s\n", rbuf);
                handle_incoming(rbuf, (int)n, sensor_id);
            }
        }

        // ── Generate and send readings every READING_INTERVAL_SEC ──
        time_t now = time(NULL);
        if (now - last_send >= READING_INTERVAL_SEC) {
            last_send = now;

            // Reset compound pool so we don't leak memory
            // (atoms persist, compounds are transient)
            pc_reset_compounds(&g_pc);

            // Simulated values (clamped to integer for the wire format)
            int32_t temp_val  = (int32_t)round(sim_temperature(tick));
            int32_t humid_val = (int32_t)round(sim_humidity(tick));
            int32_t ts        = (int32_t)now;

            // Build reading(sensor_id, temperature, val, timestamp)
            {
                Term args[4] = {
                    TERM_ATOM(a_sensor_id),
                    TERM_ATOM(a_temperature),
                    pc_make_num(temp_val),
                    pc_make_num(ts)
                };
                Term fact = pc_make_compound(&g_pc, a_reading, 4, args);

                printf("[sensor] temperature=%d  humidity=%d  ts=%d\n",
                       (int)temp_val, (int)humid_val, (int)ts);

                send_signal(sock, &coord_sa, &g_pc, sensor_id, fact);
                send_signal(sock, &est_sa,   &g_pc, sensor_id, fact);
            }

            // Build reading(sensor_id, humidity, val, timestamp)
            {
                Term args[4] = {
                    TERM_ATOM(a_sensor_id),
                    TERM_ATOM(a_humidity),
                    pc_make_num(humid_val),
                    pc_make_num(ts)
                };
                Term fact = pc_make_compound(&g_pc, a_reading, 4, args);

                send_signal(sock, &coord_sa, &g_pc, sensor_id, fact);
                send_signal(sock, &est_sa,   &g_pc, sensor_id, fact);
            }

            tick++;
        }
    }

    // ── Graceful shutdown: announce offline ──
    printf("[sensor] shutting down, announcing offline\n");
    pc_reset_compounds(&g_pc);
    {
        Term args[2] = {
            TERM_ATOM(a_sensor_id),
            TERM_ATOM(a_offline)
        };
        Term status_fact = pc_make_compound(&g_pc, a_node_status, 2, args);
        send_signal(sock, &coord_sa, &g_pc, sensor_id, status_fact);
        send_signal(sock, &est_sa,   &g_pc, sensor_id, status_fact);
    }

    close(sock);
    printf("[sensor] done.\n");
    return 0;
}
