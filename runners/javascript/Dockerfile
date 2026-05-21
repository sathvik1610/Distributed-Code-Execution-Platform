FROM node:20-alpine

# Create a non-root runner user with UID 2000 and GID 2000
RUN addgroup -g 2000 runner && adduser -u 2000 -G runner -s /bin/sh -D runner

# Set working directory
WORKDIR /app

# Change ownership
RUN chown runner:runner /app

# Switch to runner
USER runner

# Run the node app
CMD ["node", "/app/code.js"]
