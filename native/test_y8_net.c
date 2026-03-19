/* ============================================================
 * test_y8_net.c — Stress tests for y8 wire framing + pipe
 *
 * y8 model: fork, not threads. Each engine is a single-threaded
 * process. Tests use fork + socketpair for isolation.
 *
 * gcc -O2 -Wall -std=c11 -o test_y8_net test_y8_net.c y8_net.c
 *   && ./test_y8_net
 * ============================================================ */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <signal.h>
#include "y8_net.h"

#ifdef __has_include
#if __has_include(<openssl/ssl.h>)
#define Y8_HAS_TLS 1
#include <openssl/ssl.h>
#endif
#endif

static int pass = 0, fail = 0;

#define TEST(name, cond) do { \
    if (cond) { pass++; printf("  ok  %s\n", name); } \
    else { fail++; printf("  FAIL %s  [line %d]\n", name, __LINE__); } \
} while(0)

static void make_pair(int fds[2]) {
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) < 0) {
        perror("socketpair");
        exit(1);
    }
}

/* ── Basic framing tests ────────────────────────────── */

static void test_basic_framing(void) {
    printf("=== Basic framing ===\n");
    int fds[2];
    make_pair(fds);

    const char *msg = "hello";
    TEST("write succeeds", y8_frame_write(fds[1], msg, 5) == 0);

    char *buf = NULL; int len = 0;
    int r = y8_frame_read(fds[0], &buf, &len);
    TEST("read succeeds", r == 5);
    TEST("read length", len == 5);
    TEST("read content", buf && memcmp(buf, "hello", 5) == 0);
    free(buf);

    TEST("ping write", y8_frame_ping(fds[1]) == 0);
    r = y8_frame_read(fds[0], &buf, &len);
    TEST("ping read returns 0", r == 0);
    TEST("ping data is null", buf == NULL);
    TEST("ping len is 0", len == 0);

    TEST("empty write", y8_frame_write(fds[1], NULL, 0) == 0);
    r = y8_frame_read(fds[0], &buf, &len);
    TEST("empty read = ping", r == 0);

    close(fds[0]); close(fds[1]);
}

/* ── Binary safety: all 256 byte values ─────────────── */

static void test_binary_safety(void) {
    printf("\n=== Binary safety ===\n");
    int fds[2];
    make_pair(fds);

    char blob[256];
    for (int i = 0; i < 256; i++) blob[i] = (char)i;

    TEST("write 256 bytes", y8_frame_write(fds[1], blob, 256) == 0);

    char *buf = NULL; int len = 0;
    int r = y8_frame_read(fds[0], &buf, &len);
    TEST("read 256 bytes", r == 256 && len == 256);

    int match = 1;
    for (int i = 0; i < 256; i++) {
        if ((unsigned char)buf[i] != (unsigned char)i) { match = 0; break; }
    }
    TEST("all 256 byte values preserved", match);
    free(buf);

    close(fds[0]); close(fds[1]);
}

/* ── Multiple messages (fork: writer child, reader parent) ── */

static void test_multiple_messages(int count) {
    char label[64];
    snprintf(label, sizeof(label), "\n=== %d messages ===", count);
    printf("%s\n", label);
    int fds[2];
    make_pair(fds);

    pid_t pid = fork();
    if (pid == 0) {
        /* Child: write */
        close(fds[0]);
        for (int i = 0; i < count; i++) {
            char msg[32];
            int n = snprintf(msg, sizeof(msg), "msg-%d", i);
            if (y8_frame_write(fds[1], msg, n) < 0) _exit(1);
        }
        close(fds[1]);
        _exit(0);
    }

    /* Parent: read */
    close(fds[1]);
    int ok = 1;
    for (int i = 0; i < count; i++) {
        char *buf = NULL; int len = 0;
        int r = y8_frame_read(fds[0], &buf, &len);
        char expected[32];
        int elen = snprintf(expected, sizeof(expected), "msg-%d", i);
        if (r != elen || len != elen || !buf || memcmp(buf, expected, elen) != 0) {
            ok = 0;
        }
        free(buf);
    }
    int status;
    waitpid(pid, &status, 0);

    char tname[64];
    snprintf(tname, sizeof(tname), "%d messages round-trip", count);
    TEST(tname, ok && WIFEXITED(status) && WEXITSTATUS(status) == 0);

    close(fds[0]);
}

/* ── Large message (1 MB, fork) ─────────────────────── */

static void test_large_message(void) {
    printf("\n=== Large message ===\n");
    int fds[2];
    make_pair(fds);

    int size = 1024 * 1024;

    pid_t pid = fork();
    if (pid == 0) {
        close(fds[0]);
        char *big = (char *)malloc(size);
        for (int i = 0; i < size; i++) big[i] = (char)(i & 0xFF);
        int rc = y8_frame_write(fds[1], big, size);
        free(big);
        close(fds[1]);
        _exit(rc == 0 ? 0 : 1);
    }

    close(fds[1]);
    char *buf = NULL; int len = 0;
    int r = y8_frame_read(fds[0], &buf, &len);
    int status;
    waitpid(pid, &status, 0);

    TEST("1MB write+read", r == size && len == size);

    int match = 1;
    if (buf) {
        for (int i = 0; i < size; i++) {
            if ((unsigned char)buf[i] != (unsigned char)(i & 0xFF)) {
                match = 0; break;
            }
        }
    } else { match = 0; }
    TEST("1MB content intact", match);

    free(buf);
    close(fds[0]);
}

/* ── Pipe transport ─────────────────────────────────── */

static void test_pipe_transport(void) {
    printf("\n=== Pipe transport ===\n");
    int fds[2];
    make_pair(fds);

    y8_pipe sender, receiver;
    y8_pipe_init(&sender, fds[0], fds[0]);
    y8_pipe_init(&receiver, fds[1], fds[1]);

    const char *msg = "{type: signal, value: 42}";
    TEST("pipe send", y8_pipe_send(&sender, msg, (int)strlen(msg)) == 0);

    char *buf = NULL; int len = 0;
    int r = y8_pipe_recv(&receiver, &buf, &len);
    TEST("pipe recv", r == (int)strlen(msg));
    TEST("pipe content", buf && memcmp(buf, msg, strlen(msg)) == 0);
    free(buf);

    const char *reply = "{ok: true}";
    TEST("pipe send reverse", y8_pipe_send(&receiver, reply, (int)strlen(reply)) == 0);

    r = y8_pipe_recv(&sender, &buf, &len);
    TEST("pipe recv reverse", r == (int)strlen(reply));
    TEST("pipe content reverse", buf && memcmp(buf, reply, strlen(reply)) == 0);
    free(buf);

    close(fds[0]); close(fds[1]);
}

/* ── EOF detection ──────────────────────────────────── */

static void test_eof_detection(void) {
    printf("\n=== EOF detection ===\n");
    int fds[2];
    make_pair(fds);

    const char *msg = "last";
    y8_frame_write(fds[1], msg, 4);
    close(fds[1]);

    char *buf = NULL; int len = 0;
    int r = y8_frame_read(fds[0], &buf, &len);
    TEST("read before EOF", r == 4);
    free(buf);

    r = y8_frame_read(fds[0], &buf, &len);
    TEST("read after close = -1", r == -1);

    close(fds[0]);
}

/* ── Throughput benchmark (fork) ────────────────────── */

static void test_throughput(int count) {
    printf("\n=== Throughput (%d messages) ===\n", count);
    int fds[2];
    make_pair(fds);

    const char *msg = "{type:signal,from:sensor1,value:42}";
    int msglen = (int)strlen(msg);

    pid_t pid = fork();
    if (pid == 0) {
        close(fds[0]);
        for (int i = 0; i < count; i++) {
            if (y8_frame_write(fds[1], msg, msglen) < 0) _exit(1);
        }
        close(fds[1]);
        _exit(0);
    }

    close(fds[1]);
    struct timeval t0, t1;
    gettimeofday(&t0, NULL);

    for (int i = 0; i < count; i++) {
        char *buf = NULL; int len = 0;
        y8_frame_read(fds[0], &buf, &len);
        free(buf);
    }

    gettimeofday(&t1, NULL);
    int status;
    waitpid(pid, &status, 0);

    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_usec - t0.tv_usec) / 1000.0;
    printf("  %d messages in %.1f ms (%.1f K msg/sec)\n",
           count, ms, count / ms);

    char tname[64];
    snprintf(tname, sizeof(tname), "throughput %d", count);
    TEST(tname, WIFEXITED(status) && WEXITSTATUS(status) == 0 && ms > 0);

    close(fds[0]);
}

/* ── Oversized message rejected ─────────────────────── */

static void test_oversize(void) {
    printf("\n=== Oversize rejection ===\n");
    int fds[2];
    make_pair(fds);

    int big = Y8_NET_MAX_MSG + 1;
    TEST("oversize write rejected", y8_frame_write(fds[1], "x", big) == -1);

    close(fds[0]); close(fds[1]);
}

/* ── TCP transport (fork: client child, server parent) ── */

static void test_tcp(int count) {
    printf("\n=== TCP %d messages ===\n", count);

    /* Listen on port 0 — kernel picks an ephemeral port */
    int server_fd = y8_tcp_listen(0);
    TEST("tcp listen", server_fd >= 0);
    if (server_fd < 0) return;

    /* Get the actual port */
    struct sockaddr_in saddr;
    socklen_t slen = sizeof(saddr);
    getsockname(server_fd, (struct sockaddr *)&saddr, &slen);
    int port = ntohs(saddr.sin_port);

    pid_t pid = fork();
    if (pid == 0) {
        /* Child: client — connect and send */
        close(server_fd);
        int cfd = y8_tcp_connect("127.0.0.1", port);
        if (cfd < 0) _exit(1);
        for (int i = 0; i < count; i++) {
            char msg[32];
            int n = snprintf(msg, sizeof(msg), "tcp-%d", i);
            if (y8_frame_write(cfd, msg, n) < 0) { close(cfd); _exit(1); }
        }
        close(cfd);
        _exit(0);
    }

    /* Parent: server — accept and read */
    int conn = y8_tcp_accept(server_fd);
    TEST("tcp accept", conn >= 0);
    close(server_fd);

    int ok = 1;
    for (int i = 0; i < count; i++) {
        char *buf = NULL; int len = 0;
        int r = y8_frame_read(conn, &buf, &len);
        if (r < 0) { ok = 0; free(buf); break; }
        char expected[32];
        int elen = snprintf(expected, sizeof(expected), "tcp-%d", i);
        if (r != elen || memcmp(buf, expected, elen) != 0) ok = 0;
        free(buf);
    }
    close(conn);
    int status;
    waitpid(pid, &status, 0);

    char tname[64];
    snprintf(tname, sizeof(tname), "tcp %d round-trip", count);
    TEST(tname, ok && WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

/* ── UDP transport (fork: sender child, receiver parent) ── */

static void test_udp(int count) {
    printf("\n=== UDP %d messages ===\n", count);

    /* Receiver binds to ephemeral port */
    int recv_fd = y8_udp_open(0);
    TEST("udp open", recv_fd >= 0);
    if (recv_fd < 0) return;

    struct sockaddr_in addr;
    socklen_t alen = sizeof(addr);
    getsockname(recv_fd, (struct sockaddr *)&addr, &alen);
    int port = ntohs(addr.sin_port);

    pid_t pid = fork();
    if (pid == 0) {
        /* Child: send */
        close(recv_fd);
        int send_fd = y8_udp_open(0);
        if (send_fd < 0) _exit(1);
        for (int i = 0; i < count; i++) {
            char msg[32];
            int n = snprintf(msg, sizeof(msg), "udp-%d", i);
            if (y8_udp_send(send_fd, "127.0.0.1", port, msg, n) < 0)
                { close(send_fd); _exit(1); }
        }
        close(send_fd);
        _exit(0);
    }

    /* Parent: receive with timeout (UDP drops are OK) */
    int got = 0;
    struct timeval tv = {2, 0}; /* 2 second total timeout */
    setsockopt(recv_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    for (int i = 0; i < count; i++) {
        char *buf = NULL; int len = 0;
        int r = y8_udp_recv(recv_fd, &buf, &len);
        if (r > 0) got++;
        else { free(buf); break; } /* timeout = done */
        free(buf);
    }
    close(recv_fd);
    int status;
    waitpid(pid, &status, 0);

    /* UDP may drop — accept if we got at least 90% */
    char tname[64];
    snprintf(tname, sizeof(tname), "udp %d received %d (>=%d)", count, got, count*9/10);
    TEST(tname, got >= count * 9 / 10 && WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

/* ── TCP throughput (fork) ───────────────────────────── */

static void test_tcp_throughput(int count) {
    printf("\n=== TCP throughput (%d messages) ===\n", count);
    int server_fd = y8_tcp_listen(0);
    if (server_fd < 0) { TEST("tcp listen", 0); return; }
    struct sockaddr_in saddr;
    socklen_t slen = sizeof(saddr);
    getsockname(server_fd, (struct sockaddr *)&saddr, &slen);
    int port = ntohs(saddr.sin_port);

    const char *msg = "{type:signal,from:sensor1,value:42}";
    int msglen = (int)strlen(msg);

    pid_t pid = fork();
    if (pid == 0) {
        close(server_fd);
        int cfd = y8_tcp_connect("127.0.0.1", port);
        if (cfd < 0) _exit(1);
        for (int i = 0; i < count; i++) {
            if (y8_frame_write(cfd, msg, msglen) < 0) { close(cfd); _exit(1); }
        }
        close(cfd);
        _exit(0);
    }

    int conn = y8_tcp_accept(server_fd);
    close(server_fd);

    struct timeval t0, t1;
    gettimeofday(&t0, NULL);
    for (int i = 0; i < count; i++) {
        char *buf = NULL; int len = 0;
        y8_frame_read(conn, &buf, &len);
        free(buf);
    }
    gettimeofday(&t1, NULL);
    close(conn);

    int status;
    waitpid(pid, &status, 0);
    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_usec - t0.tv_usec) / 1000.0;
    printf("  %d messages in %.1f ms (%.1f K msg/sec)\n", count, ms, count / ms);

    char tname[64];
    snprintf(tname, sizeof(tname), "tcp throughput %d", count);
    TEST(tname, WIFEXITED(status) && WEXITSTATUS(status) == 0 && ms > 0);
}

/* ── TCP reconnect (server dies, client reconnects) ───── */

static void test_tcp_reconnect(void) {
    printf("\n=== TCP reconnect ===\n");

    int server_fd = y8_tcp_listen(0);
    TEST("reconnect listen", server_fd >= 0);
    if (server_fd < 0) return;

    struct sockaddr_in saddr;
    socklen_t slen = sizeof(saddr);
    getsockname(server_fd, (struct sockaddr *)&saddr, &slen);
    int port = ntohs(saddr.sin_port);

    pid_t pid = fork();
    if (pid == 0) {
        /* Child: client with auto-reconnect */
        close(server_fd);
        y8_tcp_conn conn;
        y8_tcp_conn_init(&conn, "127.0.0.1", port, NULL);

        /* Send 3 messages, server will die after 2 and restart */
        const char *m1 = "before";
        y8_tcp_conn_send(&conn, m1, 6);
        y8_tcp_conn_send(&conn, m1, 6);

        /* Server kills connection here — _y8_tcp_alive detects it */
        struct timeval tv = {0, 50000}; select(0,0,0,0,&tv); /* 50ms for RST */
        const char *m2 = "after";
        y8_tcp_conn_send(&conn, m2, 5);

        y8_tcp_conn_close(&conn);
        _exit(0);
    }

    /* Parent: server — accept, read 2, kill, re-accept, read 1 */
    int conn1 = y8_tcp_accept(server_fd);
    char *buf = NULL; int len = 0;

    int r1 = y8_frame_read(conn1, &buf, &len);
    TEST("reconnect msg 1", r1 == 6 && memcmp(buf, "before", 6) == 0);
    free(buf); buf = NULL;

    int r2 = y8_frame_read(conn1, &buf, &len);
    TEST("reconnect msg 2", r2 == 6);
    free(buf); buf = NULL;

    /* Kill the connection — client will get an error on next send */
    close(conn1);

    /* Accept the reconnection */
    int conn2 = y8_tcp_accept(server_fd);
    TEST("reconnect re-accept", conn2 >= 0);

    /* Read at least one "after" message on the new connection */
    int r3 = y8_frame_read(conn2, &buf, &len);
    TEST("reconnect msg after reconnect", r3 == 5 && buf && memcmp(buf, "after", 5) == 0);
    free(buf);

    close(conn2);
    close(server_fd);
    int status;
    waitpid(pid, &status, 0);
    TEST("reconnect child exit ok", WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

/* ── TLS transport ───────────────────────────────────── */

static void test_tls(void) {
    printf("\n=== TLS ===\n");

    /* Generate self-signed cert+key via openssl CLI */
    int rc = system(
        "openssl req -x509 -newkey rsa:2048 -keyout /tmp/y8test.key "
        "-out /tmp/y8test.crt -days 1 -nodes -batch -subj '/CN=localhost' "
        ">/dev/null 2>&1");
    if (rc != 0) {
        printf("  skip (openssl CLI not available)\n");
        return;
    }

    y8_tls_ctx *server_tls = y8_tls_server("/tmp/y8test.crt", "/tmp/y8test.key");
    y8_tls_ctx *client_tls = y8_tls_client(NULL); /* no verify for self-signed */
    TEST("tls server ctx", server_tls != NULL);
    TEST("tls client ctx", client_tls != NULL);
    if (!server_tls || !client_tls) return;

    int server_fd = y8_tcp_listen(0);
    struct sockaddr_in saddr;
    socklen_t slen = sizeof(saddr);
    getsockname(server_fd, (struct sockaddr *)&saddr, &slen);
    int port = ntohs(saddr.sin_port);

    pid_t pid = fork();
    if (pid == 0) {
        /* Child: TLS client via y8_tcp_conn */
        close(server_fd);
        y8_tcp_conn conn;
        y8_tcp_conn_init(&conn, "127.0.0.1", port, client_tls);
        y8_tcp_conn_send(&conn, "hello-tls", 9);
        char *rbuf = NULL; int rlen = 0;
        y8_tcp_conn_recv(&conn, &rbuf, &rlen);
        int ok = (rlen == 8 && rbuf && memcmp(rbuf, "reply-ok", 8) == 0);
        free(rbuf);
        y8_tcp_conn_close(&conn);
        y8_tls_free(client_tls);
        _exit(ok ? 0 : 1);
    }

    /* Parent: TLS server */
    void *ssl = NULL;
    int conn_fd = y8_tcp_accept_tls(server_fd, server_tls, &ssl);
    TEST("tls accept", conn_fd >= 0 && ssl != NULL);
    close(server_fd);

    if (conn_fd >= 0 && ssl) {
        char *buf = NULL; int len = 0;
        int r = y8_frame_read_ssl(ssl, &buf, &len);
        TEST("tls read", r == 9 && buf && memcmp(buf, "hello-tls", 9) == 0);
        free(buf);

        y8_frame_write_ssl(ssl, "reply-ok", 8);

#ifdef Y8_HAS_TLS
        SSL_shutdown((SSL *)ssl);
        SSL_free((SSL *)ssl);
#endif
    } else {
        TEST("tls read", 0);
    }
    close(conn_fd);

    int status;
    waitpid(pid, &status, 0);
    TEST("tls client ok", WIFEXITED(status) && WEXITSTATUS(status) == 0);

    y8_tls_free(server_tls);
}

static void test_tls_throughput(int count) {
    printf("\n=== TLS throughput (%d messages) ===\n", count);
    /* Reuse certs from test_tls or pre-generated */
    if (access("/tmp/y8test.crt", R_OK) != 0) {
        int rc = system(
            "openssl req -x509 -newkey rsa:2048 -keyout /tmp/y8test.key "
            "-out /tmp/y8test.crt -days 1 -nodes -batch -subj '/CN=localhost' "
            ">/dev/null 2>&1");
        if (rc != 0) { printf("  skip\n"); return; }
    }

    y8_tls_ctx *stls = y8_tls_server("/tmp/y8test.crt", "/tmp/y8test.key");
    y8_tls_ctx *ctls = y8_tls_client(NULL);
    if (!stls || !ctls) { TEST("tls ctx", 0); return; }

    int server_fd = y8_tcp_listen(0);
    struct sockaddr_in saddr;
    socklen_t slen = sizeof(saddr);
    getsockname(server_fd, (struct sockaddr *)&saddr, &slen);
    int port = ntohs(saddr.sin_port);

    const char *msg = "{type:signal,from:sensor1,value:42}";
    int msglen = (int)strlen(msg);

    pid_t pid = fork();
    if (pid == 0) {
        close(server_fd);
        int cfd = y8_tcp_connect("127.0.0.1", port);
        if (cfd < 0) _exit(1);
        void *cssl = y8_tls_ssl_new(ctls, cfd);
        if (!cssl) _exit(2);
#ifdef Y8_HAS_TLS
        if (SSL_connect((SSL *)cssl) <= 0) _exit(3);
        for (int i = 0; i < count; i++) {
            if (y8_frame_write_ssl(cssl, msg, msglen) < 0) _exit(1);
        }
        SSL_shutdown((SSL *)cssl); SSL_free((SSL *)cssl);
#endif
        close(cfd);
        y8_tls_free(ctls);
        _exit(0);
    }

    void *ssl = NULL;
    int conn_fd = y8_tcp_accept_tls(server_fd, stls, &ssl);
    close(server_fd);

    struct timeval t0, t1;
    gettimeofday(&t0, NULL);
    for (int i = 0; i < count; i++) {
        char *buf = NULL; int len = 0;
        y8_frame_read_ssl(ssl, &buf, &len);
        free(buf);
    }
    gettimeofday(&t1, NULL);

#ifdef Y8_HAS_TLS
    SSL_shutdown((SSL *)ssl); SSL_free((SSL *)ssl);
#endif
    close(conn_fd);

    int status;
    waitpid(pid, &status, 0);
    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_usec - t0.tv_usec) / 1000.0;
    printf("  %d messages in %.1f ms (%.1f K msg/sec)\n", count, ms, count / ms);

    char tname[64];
    snprintf(tname, sizeof(tname), "tls throughput %d", count);
    TEST(tname, WIFEXITED(status) && WEXITSTATUS(status) == 0 && ms > 0);
    y8_tls_free(stls);
}

/* ── Main ────────────────────────────────────────────── */

int main(void) {
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, NULL, _IONBF, 0);
    test_basic_framing();
    test_binary_safety();
    test_multiple_messages(10);
    test_multiple_messages(1000);
    test_multiple_messages(10000);
    test_large_message();
    test_pipe_transport();
    test_eof_detection();
    test_throughput(1000);
    test_throughput(10000);
    test_throughput(100000);
    test_oversize();
    test_tcp(10);
    test_tcp(1000);
    test_tcp(10000);
    test_udp(10);
    test_udp(1000);
    test_tcp_throughput(1000);
    test_tcp_throughput(10000);
    test_tcp_throughput(100000);
    test_tcp_reconnect();
    test_tls();
    test_tls_throughput(1000);
    test_tls_throughput(10000);

    printf("\n%d/%d tests passed\n", pass, pass + fail);
    return fail ? 1 : 0;
}
