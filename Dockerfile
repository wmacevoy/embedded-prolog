FROM oven/bun:latest

# Add gcc and python3 for C and Python examples
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libc6-dev python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
