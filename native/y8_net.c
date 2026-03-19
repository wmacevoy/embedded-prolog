/* ============================================================
 * y8_net.c — QJSON wire framing + pipe transport
 *
 * Zero dependencies: POSIX only (read/write/close).
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

static int _y8_tcp_reconnect(y8_tcp_conn *c) {
    if (c->fd >= 0) { close(c->fd); c->fd = -1; }
    while (1) {
        int delay = 1 << (c->tries < 12 ? c->tries : 12);
        if (delay > Y8_RECONNECT_MAX_MS) delay = Y8_RECONNECT_MAX_MS;
        _y8_sleep_ms(delay);
        c->fd = y8_tcp_connect(c->host, c->port);
        if (c->fd >= 0) { c->tries = 0; return 0; }
        if (c->tries < 12) c->tries++;
    }
}

void y8_tcp_conn_init(y8_tcp_conn *c, const char *host, int port) {
    c->fd = -1;
    c->port = port;
    c->tries = 0;
    snprintf(c->host, sizeof(c->host), "%s", host);
    c->fd = y8_tcp_connect(host, port);
    /* If initial connect fails, first send/recv will reconnect */
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

int y8_tcp_conn_send(y8_tcp_conn *c, const char *data, int len) {
    if (c->fd < 0 || !_y8_tcp_alive(c->fd)) _y8_tcp_reconnect(c);
    int r = y8_frame_write(c->fd, data, len);
    if (r < 0) {
        _y8_tcp_reconnect(c);
        r = y8_frame_write(c->fd, data, len);
    }
    return r;
}

int y8_tcp_conn_recv(y8_tcp_conn *c, char **data, int *len) {
    if (c->fd < 0) _y8_tcp_reconnect(c);
    int r = y8_frame_read(c->fd, data, len);
    if (r < 0) {
        _y8_tcp_reconnect(c);
        r = y8_frame_read(c->fd, data, len);
    }
    return r;
}

void y8_tcp_conn_close(y8_tcp_conn *c) {
    if (c->fd >= 0) { close(c->fd); c->fd = -1; }
}

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
