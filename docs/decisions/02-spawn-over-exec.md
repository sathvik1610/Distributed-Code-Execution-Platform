# Decision: `child_process.spawn` over `child_process.exec`

**Date**: 2026-05-21  
**Status**: Accepted  
**Component**: Execution Worker — Docker sandbox invocation

---

## Context

The execution worker must invoke `docker run` to execute user code. Node.js provides two primary ways to spawn child processes:

- `child_process.exec(command, callback)` — runs command in a shell, buffers all output
- `child_process.spawn(command, args)` — runs command directly, streams output incrementally

---

## Decision

We exclusively use **`child_process.spawn`**.

---

## Reasons

### 1. Streaming — The Core Requirement

The platform streams execution output in real-time to connected WebSocket clients. This requires output to be delivered incrementally as it is produced, not buffered until process exit.

`exec` buffers **all** stdout/stderr in memory and delivers it only after the process exits. This means:
- No real-time streaming is possible with `exec`.
- A job that prints 1000 lines and then sleeps would show nothing to the user for 5 seconds, then dump everything at once.

`spawn` emits `stdout.on('data')` events with each chunk as it arrives.

### 2. Memory Safety

`exec` has a hard `maxBuffer` limit (default: 1MB). If a submission produces more output than the buffer, `exec` crashes with `Error: stdout maxBuffer exceeded`.

With `spawn`, we implement our own 64KB soft cap (`MAX_OUTPUT_SIZE`). Output beyond this cap is discarded but the process continues safely. No crash, no memory explosion.

### 3. Shell Injection Prevention

`exec` runs the command through `/bin/sh -c "command"`. Shell injection is a real risk if any argument contains special characters.

`spawn` takes the command and arguments as separate tokens (`spawn('docker', ['run', ..., imageName])`). This is inherently safe — no shell is involved, no injection surface exists.

---

## Code Pattern

```typescript
// WRONG — never use this
const child = exec(`docker run --rm ${imageName}`);

// CORRECT — always use this
const child = spawn('docker', [
  'run', '--rm',
  '--network', 'none',
  '--memory', '128m',
  imageName
]);

child.stdout.on('data', (chunk) => {
  // Stream incrementally
  publishChunk('stdout', chunk.toString());
});
```

---

## Conclusion

`spawn` is the only correct choice for this use case. `exec` is fundamentally incompatible with streaming, unsafe for high-output workloads, and has a larger injection surface. This is a non-negotiable engineering decision.
