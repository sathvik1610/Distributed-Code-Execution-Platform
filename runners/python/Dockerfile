# Runtime image. For production hardening, pin this tag to a trusted digest.
FROM python:3.11-slim

# Install nothing extra — minimal attack surface
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
      && rm -rf /var/lib/apt/lists/* 2>/dev/null || true

# Create a non-root runner user with UID 1000 and GID 1000
RUN groupadd -g 1000 runner && useradd -u 1000 -g runner -m -s /usr/sbin/nologin runner

# Set working directory and lock ownership
WORKDIR /app
RUN chown runner:runner /app

# Copy wrapper script
COPY runner-wrapper.sh /app/runner-wrapper.sh
RUN chmod +x /app/runner-wrapper.sh && chown runner:runner /app/runner-wrapper.sh

# Drop to non-root user
USER runner

# Use wrapper script to run python code and capture cgroup peak memory metrics
ENTRYPOINT ["/app/runner-wrapper.sh"]
CMD ["python", "-u", "/app/code.py"]
