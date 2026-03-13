FROM oven/bun:latest
WORKDIR /app
COPY src/ src/
COPY examples/greenhouse/dashboard/ examples/greenhouse/dashboard/
CMD ["bun", "run", "examples/greenhouse/dashboard/server.js"]
