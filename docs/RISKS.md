# Accepted risks (from the 2026-09-15 adversarial review)

Each item below was examined, judged not fixable inside the current design, and is recorded so nobody rediscovers it as a surprise. Findings that were fixed live in the commits; the review itself is not committed.


### A1. The server decides which grant applies and what the agent's key is

`requestHandler.js:45-48` asks `GET /api/v1/users/:username` for the fingerprint, and `:116-117` takes
`agent_id` from `msg.user.id`. Both come from Salt. A compromised server can therefore make any account
present as a granted agent with a matching key, and the release is encrypted for whichever members the
server names. State this plainly: in phase 1 the server is trusted for agent identity binding. The
stronger version is to derive the fingerprint from the sender's key in the chat payload the person already
holds, rather than asking the server who the sender is.

### A2. The root key is not behind the vault

`lattice.worker.js:340-341` loads the root from IndexedDB on `open()` with no vault gate, which is DESIGN
section 6 as written ("never derived from any password").

Verified clean on the narrow question: the raw bytes never reach redux, an action payload or a log.
`backup.js:114` hands them straight to `wrapRootForBackup`, `latticeSlice` holds only flags and is in the
persist blacklist (`store/store.js:157`), devTools are off in production (`store.js:248`), and
`importRootKey` (`crypto.js:91`) imports non-extractable.

The consequence to state: anything running on the origin with the device unlocked reads the entire graph
and every grant, vault locked or not. The vault protects only the off-device wrap. The strict CSP
(`script-src 'self'`, no inline) is the whole defence against an XSS reading all of Lattice.

One leak worth closing cheaply: `backup.js:69` logs the axios error, whose `config.data` carries the
base64 blob, and Sentry captures console breadcrumbs by default. The body is ciphertext, but B5's
plaintext manifest sits at its head.

### A3. The data half of the backup is write-only, and has no rollback defence for when it is wired

`importBackup` appears nowhere outside `src/lattice/vendor/` (verified by grep). `bootstrapRoot`
(`backup.js:106-112`) restores the root key and stops, so a new device opens an empty Lattice while the
server holds the blob. That is a recovery gap in its own right, and it is why the rollback attack is not
reachable today.

The moment import is wired it is reachable: nothing binds a blob to a version, so the server can serve an
older one and revive a destroyed compartment. `load_frame`'s destroyed check (`store.rs:146-149`) only
helps once the marker is applied, and a rolled-back `system` file has no marker in it.

**Fix when wiring it:** a monotonic counter inside the encrypted manifest, refused below the highest the
device has seen.

### A4. Bystanders see what an agent asked for, but never the answer

`actions.ts:359` encrypts the request for every member with a key, on purpose, so the phone can notice it
in-room and redirect. `messages.jsx:494` renders it as a `LatticeRequestMessage` card, so a bystander reads
the purpose and the selectors, for example "asked you for health conditions".

The redirect itself is clean, and this closes position (c). `chats_controller.rb:692-705` creates the lane
with exactly two memberships, the person and that agent, no observer, and `add_member` refuses lanes
outright (`:801-803`), as does `add_witness`. No observer human and no third agent can read a release into
a lane.

### A5. R6 is enforced only by the frontend

`requestHandler.js:120` hardcodes `channel: "private"`, so the crate's group guard
(`access.rs:114-119`) is unreachable. The real gate is `isGroupChat` (`:72-76`), a heuristic over the
locally cached chat payload. The practical risk is low, because a release is encrypted for the members the
phone knows about, so a member it has not seen cannot read one. Still, the crate-side rule that the design
names as R6 is currently dead code.

**Fix:** pass the real channel and let the crate refuse.

### A6. An agent reads its own grant, so it can stay on the auto side forever

`grants_controller.rb:19-28` serves an agent its own rules and modes, which PROTOCOL.md intends. The
consequence to state: an agent can ask only for auto selectors, never trigger a consent sheet, and harvest
continuously, with the disclosure log as the person's only visibility into it.

---

