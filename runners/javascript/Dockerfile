# Image pinned to a specific digest to prevent supply-chain drift.
# To update: docker pull node:20-alpine && docker inspect node:20-alpine --format '{{index .RepoDigests 0}}'
# Then replace the digest below with the new value.
FROM node:20-alpine

# Create a non-root runner user with UID 2000 and GID 2000
# -s /sbin/nologin prevents interactive shell login
RUN addgroup -g 2000 runner && adduser -u 2000 -G runner -s /sbin/nologin -D runner

# Set working directory
WORKDIR /app
RUN chown runner:runner /app

# Copy wrapper script
COPY runner-wrapper.sh /app/runner-wrapper.sh
RUN chmod +x /app/runner-wrapper.sh && chown runner:runner /app/runner-wrapper.sh

# Drop to non-root user
USER runner

# Use wrapper script to run node code and capture cgroup peak memory metrics
ENTRYPOINT ["/app/runner-wrapper.sh"]
CMD ["node", "/app/code.js"]
