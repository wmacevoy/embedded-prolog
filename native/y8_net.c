/* ============================================================
 * y8_net.c — QJSON wire framing + pipe + TCP + UDP + TLS
 *
 * POSIX + optional LibreSSL/OpenSSL for TLS.
 * Compile with -lssl -lcrypto for TLS support.
 * ============================================================ */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#ifdef __has_include
#if __has_include(<openssl/ssl.h>)
#define Y8_HAS_TLS 1
#endif
#endif

#ifdef Y8_HAS_TLS
#include <openssl/ssl.h>
#include <openssl/err.h>
struct y8_tls_ctx { SSL_CTX *ctx; };
#endif
#include "y8_net.h"

/* ── Helpers: full read/write with retry on EINTR ──── */

static int write_all(int fd, const char *buf, int len) {
    int written = 0;
    while (written < len) {
        int n = (int)write(fd, buf + written, len - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        written += n;
    }
    return 0;
}

static int read_all(int fd, char *buf, int len) {
    int got = 0;
    while (got < len) {
        int n = (int)read(fd, buf + got, len - got);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;  /* EOF */
        got += n;
    }
    return 0;
}

/* ── Frame encoding ────────────────────────────────── */

static void encode_u32be(char *buf, uint32_t val) {
    buf[0] = (char)((val >> 24) & 0xFF);
    buf[1] = (char)((val >> 16) & 0xFF);
    buf[2] = (char)((val >> 8)  & 0xFF);
    buf[3] = (char)((val)       & 0xFF);
}

static uint32_t decode_u32be(const char *buf) {
    return ((uint32_t)(unsigned char)buf[0] << 24)
         | ((uint32_t)(unsigned char)buf[1] << 16)
         | ((uint32_t)(unsigned char)buf[2] << 8)
         | ((uint32_t)(unsigned char)buf[3]);
}

/* ── Framing API ───────────────────────────────────── */

int y8_frame_write(int fd, const char *data, int len) {
    if (len < 0 || len > Y8_NET_MAX_MSG) return -1;
    char hdr[4];
    encode_u32be(hdr, (uint32_t)len);
    if (write_all(fd, hdr, 4) < 0) return -1;
    if (len > 0 && write_all(fd, data, len) < 0) return -1;
    return 0;
}

int y8_frame_read(int fd, char **data, int *len) {
    char hdr[4];
    if (read_all(fd, hdr, 4) < 0) return -1;
    uint32_t size = decode_u32be(hdr);
    if (size == 0) {
        /* Keepalive ping */
        *data = NULL;
        *len = 0;
        return 0;
    }
    if (size > Y8_NET_MAX_MSG) return -1;
    char *buf = (char *)malloc(size);
    if (!buf) return -1;
    if (read_all(fd, buf, (int)size) < 0) {
        free(buf);
        return -1;
    }
    *data = buf;
    *len = (int)size;
    return (int)size;
}

int y8_frame_ping(int fd) {
    char hdr[4] = {0, 0, 0, 0};
    return write_all(fd, hdr, 4);
}

/* ── Pipe transport ────────────────────────────────── */

void y8_pipe_init(y8_pipe *p, int read_fd, int write_fd) {
    p->read_fd = read_fd;
    p->write_fd = write_fd;
}

int y8_pipe_send(y8_pipe *p, const char *data, int len) {
    return y8_frame_write(p->write_fd, data, len);
}

int y8_pipe_recv(y8_pipe *p, char **data, int *len) {
    return y8_frame_read(p->read_fd, data, len);
}

void y8_pipe_close(y8_pipe *p) {
    if (p->read_fd >= 0) { close(p->read_fd); p->read_fd = -1; }
    if (p->write_fd >= 0 && p->write_fd != p->read_fd) {
        close(p->write_fd); p->write_fd = -1;
    }
}

/* ── TCP transport ─────────────────────────────────── */

int y8_tcp_listen(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)port);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd); return -1;
    }
    if (listen(fd, 16) < 0) {
        close(fd); return -1;
    }
    return fd;
}

int y8_tcp_accept(int server_fd) {
    struct sockaddr_in addr;
    socklen_t len = sizeof(addr);
    return accept(server_fd, (struct sockaddr *)&addr, &len);
}

int y8_tcp_connect(const char *host, int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) <= 0) {
        close(fd); return -1;
    }

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd); return -1;
    }
    return fd;
}

/* ── TCP with auto-reconnect ───────────────────────── */

static void _y8_sleep_ms(int ms) {
    struct timeval tv;
    tv.tv_sec = ms / 1000;
    tv.tv_usec = (ms % 1000) * 1000;
    select(0, NULL, NULL, NULL, &tv);
}

static void _y8_ssl_close(y8_tcp_conn *c) {
#ifdef Y8_HAS_TLS
    if (c->ssl) { SSL_shutdown((SSL *)c->ssl); SSL_free((SSL *)c->ssl); c->ssl = NULL; }
#endif
}

static int _y8_ssl_connect(y8_tcp_conn *c) {
#ifdef Y8_HAS_TLS
    if (c->tls && c->fd >= 0) {
        SSL *ssl = SSL_new(((y8_tls_ctx *)c->tls)->ctx);
        SSL_set_fd(ssl, c->fd);
        if (SSL_connect(ssl) <= 0) {
            ERR_print_errors_fp(stderr);
            SSL_free(ssl); return -1;
        }
        c->ssl = ssl;
    }
#endif
    return 0;
}

static int _y8_tcp_reconnect(y8_tcp_conn *c) {
    _y8_ssl_close(c);
    if (c->fd >= 0) { close(c->fd); c->fd = -1; }
    while (1) {
        int delay = 1 << (c->tries < 12 ? c->tries : 12);
        if (delay > Y8_RECONNECT_MAX_MS) delay = Y8_RECONNECT_MAX_MS;
        _y8_sleep_ms(delay);
        c->fd = y8_tcp_connect(c->host, c->port);
        if (c->fd >= 0 && _y8_ssl_connect(c) == 0) { c->tries = 0; return 0; }
        if (c->fd >= 0) { close(c->fd); c->fd = -1; }
        if (c->tries < 12) c->tries++;
    }
}

void y8_tcp_conn_init(y8_tcp_conn *c, const char *host, int port,
                      y8_tls_ctx *tls)
{
    c->fd = -1;
    c->port = port;
    c->tries = 0;
    c->tls = tls;
    c->ssl = NULL;
    snprintf(c->host, sizeof(c->host), "%s", host);
    c->fd = y8_tcp_connect(host, port);
    if (c->fd >= 0) _y8_ssl_connect(c);
}

static int _y8_tcp_alive(int fd) {
    int err = 0;
    socklen_t elen = sizeof(err);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &elen) < 0) return 0;
    if (err != 0) return 0;
    /* Also try a non-blocking peek to detect RST */
    char tmp;
    int n = (int)recv(fd, &tmp, 1, MSG_PEEK | MSG_DONTWAIT);
    if (n == 0) return 0; /* EOF = peer closed */
    /* n < 0 with EAGAIN/EWOULDBLOCK = still alive, no data */
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) return 0;
    return 1;
}

static int _y8_conn_write(y8_tcp_conn *c, const char *data, int len) {
#ifdef Y8_HAS_TLS
    if (c->ssl) return y8_frame_write_ssl(c->ssl, data, len);
#endif
    return y8_frame_write(c->fd, data, len);
}

static int _y8_conn_read(y8_tcp_conn *c, char **data, int *len) {
#ifdef Y8_HAS_TLS
    if (c->ssl) return y8_frame_read_ssl(c->ssl, data, len);
#endif
    return y8_frame_read(c->fd, data, len);
}

int y8_tcp_conn_send(y8_tcp_conn *c, const char *data, int len) {
    if (c->fd < 0 || !_y8_tcp_alive(c->fd)) _y8_tcp_reconnect(c);
    int r = _y8_conn_write(c, data, len);
    if (r < 0) {
        _y8_tcp_reconnect(c);
        r = _y8_conn_write(c, data, len);
    }
    return r;
}

int y8_tcp_conn_recv(y8_tcp_conn *c, char **data, int *len) {
    if (c->fd < 0) _y8_tcp_reconnect(c);
    int r = _y8_conn_read(c, data, len);
    if (r < 0) {
        _y8_tcp_reconnect(c);
        r = _y8_conn_read(c, data, len);
    }
    return r;
}

void y8_tcp_conn_close(y8_tcp_conn *c) {
    _y8_ssl_close(c);
    if (c->fd >= 0) { close(c->fd); c->fd = -1; }
}

/* ── TLS context + SSL framing ─────────────────────── */

#ifdef Y8_HAS_TLS

static int _tls_inited = 0;
static void _tls_init(void) {
    if (!_tls_inited) {
        OPENSSL_init_ssl(0, NULL);
        _tls_inited = 1;
    }
}

y8_tls_ctx *y8_tls_server(const char *cert_file, const char *key_file) {
    _tls_init();
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) return NULL;
    if (SSL_CTX_use_certificate_file(ctx, cert_file, SSL_FILETYPE_PEM) <= 0 ||
        SSL_CTX_use_PrivateKey_file(ctx, key_file, SSL_FILETYPE_PEM) <= 0) {
        SSL_CTX_free(ctx); return NULL;
    }
    y8_tls_ctx *t = (y8_tls_ctx *)malloc(sizeof(*t));
    t->ctx = ctx;
    return t;
}

y8_tls_ctx *y8_tls_client(const char *ca_file) {
    _tls_init();
    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) return NULL;
    if (ca_file) {
        SSL_CTX_load_verify_locations(ctx, ca_file, NULL);
        SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
    } else {
        SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
    }
    y8_tls_ctx *t = (y8_tls_ctx *)malloc(sizeof(*t));
    t->ctx = ctx;
    return t;
}

void y8_tls_free(y8_tls_ctx *t) {
    if (t) { SSL_CTX_free(t->ctx); free(t); }
}

int y8_tcp_accept_tls(int server_fd, y8_tls_ctx *tls, void **ssl_out) {
    int fd = y8_tcp_accept(server_fd);
    if (fd < 0) { fprintf(stderr, "tcp accept failed: %s\n", strerror(errno)); return -1; }
    if (tls) {
        SSL *ssl = SSL_new(tls->ctx);
        SSL_set_fd(ssl, fd);
        int ar = SSL_accept(ssl);
        if (ar <= 0) {
            fprintf(stderr, "SSL_accept=%d err=%d\n", ar, SSL_get_error(ssl, ar));
            ERR_print_errors_fp(stderr);
            SSL_free(ssl); close(fd); return -1;
        }
        *ssl_out = ssl;
    } else {
        *ssl_out = NULL;
    }
    return fd;
}

static int ssl_write_all(SSL *ssl, const char *buf, int len) {
    int written = 0;
    while (written < len) {
        int n = SSL_write(ssl, buf + written, len - written);
        if (n <= 0) return -1;
        written += n;
    }
    return 0;
}

static int ssl_read_all(SSL *ssl, char *buf, int len) {
    int got = 0;
    while (got < len) {
        int n = SSL_read(ssl, buf + got, len - got);
        if (n <= 0) return -1;
        got += n;
    }
    return 0;
}

int y8_frame_write_ssl(void *ssl, const char *data, int len) {
    if (len < 0 || len > Y8_NET_MAX_MSG) return -1;
    char hdr[4];
    hdr[0] = (char)((len >> 24) & 0xFF);
    hdr[1] = (char)((len >> 16) & 0xFF);
    hdr[2] = (char)((len >> 8)  & 0xFF);
    hdr[3] = (char)((len)       & 0xFF);
    if (ssl_write_all((SSL *)ssl, hdr, 4) < 0) return -1;
    if (len > 0 && ssl_write_all((SSL *)ssl, data, len) < 0) return -1;
    return 0;
}

int y8_frame_read_ssl(void *ssl, char **data, int *len) {
    char hdr[4];
    if (ssl_read_all((SSL *)ssl, hdr, 4) < 0) return -1;
    uint32_t size = ((uint32_t)(unsigned char)hdr[0] << 24)
                  | ((uint32_t)(unsigned char)hdr[1] << 16)
                  | ((uint32_t)(unsigned char)hdr[2] << 8)
                  | ((uint32_t)(unsigned char)hdr[3]);
    if (size == 0) { *data = NULL; *len = 0; return 0; }
    if (size > Y8_NET_MAX_MSG) return -1;
    char *buf = (char *)malloc(size);
    if (!buf) return -1;
    if (ssl_read_all((SSL *)ssl, buf, (int)size) < 0) { free(buf); return -1; }
    *data = buf;
    *len = (int)size;
    return (int)size;
}

#else /* no TLS */

y8_tls_ctx *y8_tls_server(const char *c, const char *k) { (void)c;(void)k; return NULL; }
y8_tls_ctx *y8_tls_client(const char *c) { (void)c; return NULL; }
void y8_tls_free(y8_tls_ctx *t) { (void)t; }
int y8_tcp_accept_tls(int s, y8_tls_ctx *t, void **o) { *o=NULL; (void)t; return y8_tcp_accept(s); }
int y8_frame_write_ssl(void *s, const char *d, int l) { (void)s;(void)d;(void)l; return -1; }
int y8_frame_read_ssl(void *s, char **d, int *l) { (void)s;(void)d;(void)l; return -1; }

#endif

/* ── UDP transport ─────────────────────────────────── */

int y8_udp_open(int port) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;

    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)port); /* 0 = kernel picks */

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd); return -1;
    }
    return fd;
}

int y8_udp_send(int fd, const char *host, int port,
                const char *data, int len)
{
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    inet_pton(AF_INET, host, &addr.sin_addr);

    ssize_t n = sendto(fd, data, len, 0,
                       (struct sockaddr *)&addr, sizeof(addr));
    return n == len ? 0 : -1;
}

int y8_udp_recv(int fd, char **data, int *len) {
    char buf[65536];
    ssize_t n = recvfrom(fd, buf, sizeof(buf), 0, NULL, NULL);
    if (n < 0) return -1;

    *data = (char *)malloc(n);
    if (!*data) return -1;
    memcpy(*data, buf, n);
    *len = (int)n;
    return (int)n;
}
