FROM emscripten/emsdk:3.1.74

ARG SQLITE_VERSION=3490100
ARG SQLITE_YEAR=2025

WORKDIR /build

# Download SQLite amalgamation
RUN wget -q "https://www.sqlite.org/${SQLITE_YEAR}/sqlite-amalgamation-${SQLITE_VERSION}.zip" \
      -O sqlite.zip && \
    unzip -q sqlite.zip && \
    mv "sqlite-amalgamation-${SQLITE_VERSION}" sqlite

# Source files (copied from host at build time)
COPY wyatt_wasm.c /build/src/wyatt_wasm.c
COPY shim.js      /build/src/shim.js
COPY build.sh     /build/build.sh

RUN chmod +x /build/build.sh && mkdir -p /out

ENTRYPOINT ["bash", "/build/build.sh"]
