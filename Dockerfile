FROM oven/bun:latest

# Add gcc and python3 for C and Python examples
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libc6-dev python3 libssl-dev openssl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Build qjson SQLite extension for Datalog cross-path queries
RUN cd vendor/qjson && make qjson_ext.so 2>/dev/null || true
