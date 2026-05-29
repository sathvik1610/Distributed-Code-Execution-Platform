#!/bin/sh
# runner-wrapper.sh
# Reads user code from stdin, writes it to RAM (/tmp), executes it,
# collects cgroup peak memory metrics, and exits with correct exit status.

# 1. Detect language/extension from arguments
EXT="py"
case "$*" in
  *code.js*) EXT="js" ;;
  *code.py*) EXT="py" ;;
esac

CODE_FILE="/tmp/code.$EXT"

# 2. Read standard input and write to the container's unprivileged memory-backed tmpfs
cat > "$CODE_FILE"

# 3. Execute the user code in-place
if [ "$EXT" = "js" ]; then
  node /tmp/code.js
  EXIT_CODE=$?
else
  python -u /tmp/code.py
  EXIT_CODE=$?
fi

# 4. Read cgroup peak memory usage
PEAK_MEM=""
if [ -r /sys/fs/cgroup/memory.peak ]; then
  PEAK_MEM=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)
elif [ -r /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then
  PEAK_MEM=$(cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null)
elif [ -r /sys/fs/cgroup/memory.current ]; then
  PEAK_MEM=$(cat /sys/fs/cgroup/memory.current 2>/dev/null)
fi

# Print memory token for execution-worker interception
if [ -n "$PEAK_MEM" ]; then
  echo "___MEM_PEAK___: $PEAK_MEM"
fi

exit $EXIT_CODE
