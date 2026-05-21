# Decision: Docker over VM (or `vm2`, `nsjail`)

**Date**: 2026-05-21  
**Status**: Accepted  
**Component**: Sandbox Execution Environment

---

## Context

To execute untrusted user code safely, we needed a sandboxing approach. The options considered were:

1. **VM (Virtual Machine)** — full hardware virtualization (QEMU, VirtualBox)
2. **Docker containers** — Linux namespace + cgroup isolation
3. **`vm2` / `isolated-vm`** — JavaScript-layer sandboxes
4. **`nsjail` / `bubblewrap`** — user-space Linux namespace tools

---

## Decision

We chose **Docker containers** with hardened `docker run` flags.

---

## Reasons

### 1. Resource Limiting is First-Class

Docker exposes Linux cgroups directly through familiar CLI flags:

```bash
--memory=128m         # Hard memory cap
--memory-swap=128m    # Disable swap
--pids-limit=50       # Prevent fork bombs
--cpus=0.5            # CPU throttling (optional)
```

These limits are enforced by the Linux kernel — they cannot be bypassed from within the container.

VMs provide stronger isolation but with much higher overhead (seconds to boot vs milliseconds). We need low-latency execution, not hypervisor-grade isolation.

### 2. Filesystem Isolation Is Native

Docker's `--read-only` flag mounts the container filesystem as read-only. With `--tmpfs /tmp`, only `/tmp` is writable — and that's ephemeral, discarded on exit.

### 3. Network Isolation Is One Flag

```bash
--network none
```

This disconnects the container from all networks entirely. The container cannot make outbound requests, cannot access the internet, cannot access the host network.

### 4. Non-Root Execution

```bash
--user runner
```

We build custom `runner-python` and `runner-javascript` images with a non-root `runner` user pre-created. Even if code escapes the process boundary, it runs with minimal system privileges.

### 5. Multi-Language Support via Images

Each language gets its own Docker image (`runner-python`, `runner-javascript`). Adding a new language is a matter of adding a new `Dockerfile` in `runners/`. No code changes required.

### 6. Why Not `vm2` / `isolated-vm`?

These are JavaScript-in-JavaScript sandboxes. They are:
- Language-specific (cannot run Python)
- Known to have historical escape vulnerabilities
- Not suitable for multi-language execution

### 7. Why Not `nsjail`?

`nsjail` is a powerful but complex user-space sandboxing tool. It requires:
- Root or elevated privileges to configure
- Complex seccomp policy writing
- Significant operational expertise

Docker's OCI runtime (runc) wraps the same underlying kernel primitives and is much more approachable.

---

## Tradeoffs

| Concern | Mitigation |
|---|---|
| Container startup latency (~200-500ms) | Acceptable for code execution use case |
| Shared kernel with host | Mitigated by all security flags; VMs would be overkill |
| Docker daemon as root | Standard acceptable risk in controlled environments |

---

## Conclusion

Docker is the pragmatic, powerful, and well-understood sandboxing layer for this use case. It provides kernel-level resource enforcement, network isolation, and filesystem restrictions with minimal operational overhead.
