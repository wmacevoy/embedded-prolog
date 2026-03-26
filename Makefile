CC ?= gcc
CFLAGS = -O2 -std=gnu11 -fPIC -Wall -Wno-deprecated-declarations

# Paths
QJSON = vendor/qjson/native
LIBBF = vendor/qjson/native/libbf
QJS = vendor/quickjs

# LibreSSL (set LIBRESSL to the install prefix)
LIBRESSL ?= /usr/local

UNAME := $(shell uname -s)
ifeq ($(UNAME),Darwin)
  EXT = .dylib
  SHARED = -dynamiclib -undefined dynamic_lookup
else
  EXT = .so
  SHARED = -shared
endif

INCLUDES = -I$(QJSON) -I$(LIBBF) -I$(QJS) -Inative -I$(LIBRESSL)/include

# QuickJS cutils renamed dbuf_putc → __dbuf_putc but libbf still uses dbuf_putc.
# Solution: use QuickJS cutils only + libbf_shim.c for the missing symbol.
# Do NOT compile libbf/cutils.c — it conflicts with QuickJS/cutils.c.
QJSON_SRC = $(QJSON)/qjson.c $(QJSON)/qjson_sqlite_ext.c \
            $(LIBBF)/libbf.c native/libbf_shim.c

QJS_SRC = $(QJS)/quickjs.c $(QJS)/cutils.c \
          $(QJS)/libregexp.c $(QJS)/libunicode.c \
          $(QJS)/dtoa.c

WYATT_SRC = native/wyatt.c

ALL_SRC = $(WYATT_SRC) $(QJSON_SRC) $(QJS_SRC)

FLAGS = -DQJSON_USE_LIBBF -DCONFIG_VERSION=\"2024\"

LIBS = -lm -lpthread

# Default: SQLCipher build (crypto always included)
all: libwyatt$(EXT)

libwyatt$(EXT): $(ALL_SRC)
	$(CC) $(CFLAGS) $(SHARED) $(FLAGS) $(INCLUDES) \
		-o $@ $^ $(LIBS) -lsqlite3

# With crypto (LibreSSL)
libwyatt_crypto$(EXT): $(ALL_SRC) $(QJSON)/qjson_crypto.c
	$(CC) $(CFLAGS) $(SHARED) $(FLAGS) -DQJSON_USE_CRYPTO $(INCLUDES) \
		-o $@ $^ $(LIBS) $(LIBRESSL)/lib/libcrypto.a

# Test binary
test_wyatt: native/test_wyatt.c $(ALL_SRC)
	$(CC) $(CFLAGS) $(FLAGS) $(INCLUDES) \
		-o $@ $^ $(LIBS) -lsqlite3

test: test_wyatt
	./test_wyatt

clean:
	rm -f libwyatt$(EXT) libwyatt_crypto$(EXT) test_wyatt

.PHONY: all test clean
