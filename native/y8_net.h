/* ============================================================
 * y8_net.h — QJSON wire framing + transport
 *
 * Length-prefixed QJSON messages over any stream (TCP, TLS,
 * pipe, Unix socket).  Zero dependencies for framing + pipe.
 * LibreSSL optional for TCP/TLS and UDP/DTLS.
 *
 *   int fd = y8_pipe_open(read_fd, write_fd);
 *   y8_frame_write(fd, qjson, len);
 *   y8_frame_read(fd, &buf, &len);  // caller frees buf
 *
 * Wire format: [4-byte big-endian length][QJSON payload]
 * Length 0 = keepalive ping.  Max 16 MB.
 * ============================================================ */

#ifndef Y8_NET_H
#define Y8_NET_H

#include <stdint.h>

/* ── Framing (over raw file descriptors) ─────────────── */

#define Y8_NET_MAX_MSG  (16 * 1024 * 1024)  /* 16 MB */
#define Y8_NET_PING_SEC 30
#define Y8_NET_DEAD_SEC 60

/* Write a length-prefixed frame.
   Returns 0 on success, -1 on error. */
int y8_frame_write(int fd, const char *data, int len);

/* Read a length-prefixed frame.  Allocates *data (caller frees).
   Returns payload length (>0), 0 for keepalive, -1 on error/EOF. */
int y8_frame_read(int fd, char **data, int *len);

/* Send keepalive ping (zero-length frame). */
int y8_frame_ping(int fd);

/* ── Pipe transport ──────────────────────────────────── */

typedef struct {
    int read_fd;
    int write_fd;
} y8_pipe;

/* Open a pipe transport over existing file descriptors.
   For stdin/stdout: y8_pipe_open(STDIN_FILENO, STDOUT_FILENO)
   For socketpair: use both fds from socketpair(). */
void y8_pipe_init(y8_pipe *p, int read_fd, int write_fd);

/* Send/recv over pipe (length-prefixed frames). */
int y8_pipe_send(y8_pipe *p, const char *data, int len);
int y8_pipe_recv(y8_pipe *p, char **data, int *len);

/* Close both fds. */
void y8_pipe_close(y8_pipe *p);

/* ── TCP transport ───────────────────────────────────── */
/* Plain TCP.  Uses framing layer for message boundaries.  */
/* For TLS: wrap the fd with LibreSSL SSL_read/SSL_write. */

/* Listen on a port.  Returns server fd, -1 on error. */
int y8_tcp_listen(int port);

/* Accept a connection.  Blocks.  Returns connection fd. */
int y8_tcp_accept(int server_fd);

/* Connect to host:port.  Returns connection fd, -1 on error. */
int y8_tcp_connect(const char *host, int port);

/* ── TCP with auto-reconnect ─────────────────────────── */
/* Exponential backoff: 1ms, 2ms, 4ms, ..., 4096ms cap.  */
/* Reconnects silently on send/recv failure.              */

#define Y8_RECONNECT_MAX_MS 4096

typedef struct {
    int  fd;
    char host[256];
    int  port;
    int  tries;      /* current backoff exponent */
} y8_tcp_conn;

/* Init a persistent connection.  Connects immediately. */
void y8_tcp_conn_init(y8_tcp_conn *c, const char *host, int port);

/* Send with auto-reconnect.  Returns 0 or -1 (after max retries). */
int y8_tcp_conn_send(y8_tcp_conn *c, const char *data, int len);

/* Recv with auto-reconnect.  Caller frees *data. */
int y8_tcp_conn_recv(y8_tcp_conn *c, char **data, int *len);

/* Close. */
void y8_tcp_conn_close(y8_tcp_conn *c);

/* ── UDP transport ───────────────────────────────────── */
/* Each datagram = one QJSON message.  No framing needed. */
/* Max payload: ~65507 bytes (UDP limit minus headers).   */

/* Open a UDP socket, optionally bound to port.
   port=0 for ephemeral (client).  Returns socket fd. */
int y8_udp_open(int port);

/* Send a QJSON message as one UDP datagram. */
int y8_udp_send(int fd, const char *host, int port,
                const char *data, int len);

/* Receive a QJSON message.  Caller frees *data.
   Returns payload length, -1 on error. */
int y8_udp_recv(int fd, char **data, int *len);

#endif /* Y8_NET_H */
