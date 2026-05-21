FROM python:3.11-slim

# Create a non-root runner user with UID 1000 and GID 1000
RUN groupadd -g 1000 runner && useradd -u 1000 -g runner -m runner

# Set working directory
WORKDIR /app

# Change ownership of /app to runner
RUN chown runner:runner /app

# Switch to the runner user
USER runner

# Run python on the code.py file
CMD ["python", "/app/code.py"]
