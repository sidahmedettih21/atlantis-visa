# Zero-Theft Architecture

- Bots are packaged with `pkg` into standalone binaries (V8 bytecode, no readable source).
- Binaries are stripped of symbols (`strip`).
- Runtime integrity: bots verify SHA256 of their own binary before each cycle; abort if mutated.
- Anti-debug: ptrace blocking, timing checks against stepping.
- Configuration never embedded; loaded from encrypted file or env.
- Soldier binaries communicate only with Commander API and TLScontact; no other outbound.
- Commander dashboard accessible only over Tailscale/WireGuard/SSH tunnel (not public internet).
- Remote lock: soldier polls `/api/lock/:clientId` before each cycle. Commander sets lock=true in lockState.json; soldier immediately pauses.
