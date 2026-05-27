# Image pinned to a specific digest to prevent supply-chain drift.
# To update: docker pull python:3.11-slim && docker inspect python:3.11-slim --format '{{index .RepoDigests 0}}'
# Then replace the digest below with the new value.
FROM python:3.11-slim@sha256:ad48727891de5cfa5e44c7e5a0e2f0f6f5c9bb6e9f7bb56e3f2aff17a8a3b7c

# Install nothing extra — minimal attack surface
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
      && rm -rf /var/lib/apt/lists/* 2>/dev/null || true

# Create a non-root runner user with UID 1000 and GID 1000
RUN groupadd -g 1000 runner && useradd -u 1000 -g runner -m -s /usr/sbin/nologin runner

# Set working directory and lock ownership
WORKDIR /app
RUN chown runner:runner /app

# Drop to non-root user
USER runner

# The sandbox mounts code at /app/code.py via -v
CMD ["python", "/app/code.py"]
