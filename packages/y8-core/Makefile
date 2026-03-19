ROOT := $(dir $(lastword $(MAKEFILE_LIST)))../..
CC ?= gcc
CFLAGS ?= -O2 -Wall -std=c11 -fPIC
UNAME := $(shell uname -s)

ifeq ($(UNAME),Darwin)
  SO = liby8_core.dylib
  LDFLAGS = -dynamiclib
else
  SO = liby8_core.so
  LDFLAGS = -shared
endif

SOURCES = $(ROOT)/native/y8_qjson.c \
          $(ROOT)/vendor/libbf/libbf.c \
          $(ROOT)/vendor/libbf/cutils.c

all: $(SO)

$(SO): $(SOURCES)
	$(CC) $(CFLAGS) $(LDFLAGS) -DY8_USE_LIBBF \
		-I$(ROOT)/vendor/libbf \
		-o $@ $^ -lm

test: $(SO)
	python3 test_y8_core.py

clean:
	rm -f $(SO)

.PHONY: all test clean
