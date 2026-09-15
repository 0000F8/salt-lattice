# Lattice over Salt: the wire protocol (phase 2 contract)

Everything below rides INSIDE encrypted message plaintext, exactly like `[[SALT-DELEGATION]]`. The server
never sees a request, a release, or a fact; it stores grant shapes (names, never values) and an opaque
backup. Markers are one line, then a JSON body on the following lines.

## Request (agent → person)

```
[[SALT-LATTICE-REQUEST id=01J8XK3V9Q4R5S6T7U8V9W0XYZ]]
{"purpose":"pick a restaurant for Friday","asks":["preferences.food.cuisine.*","preferences.food.restriction.*"]}
```

- `id`: a ULID minted by the agent. `asks`: selectors (`compartment.*`, `type.*`, `type.field`).
- Sent in a 1:1 with the person or in the agent's private lane (sidechain) of a group. If it arrives in a
  group chat, the phone never answers there: it opens (or reuses) a sidechain with that agent and answers
  inside it (DESIGN R6).
- The agent may only ask for what its grant names; asking for more is not an error, the extra is simply
  absent from the release (R5). Agents learn their grant's field names from `GET /api/v1/lattice/grants`.

## Release (person's phone → agent)

```
[[SALT-LATTICE-RELEASE id=01J8XK3V9Q4R5S6T7U8V9W0XYZ]]
{"request_id":"01J8XK3V9Q4R5S6T7U8V9W0XYZ","facts":[{"path":"preferences/food/cuisine/Japanese","type":"preferences.food.cuisine","field":"strength","value":0.8,"author":"you","updated":1789580100000}]}
```

- Always a reply to a request id; `facts: []` for "nothing" (indistinguishable from "withheld"). `author` is
  `you` or `agent`, never who. Encrypted for the lane's members (the person and that agent).
- The phone answers when the app is open. An agent must treat a release as something that may arrive after
  its own request timed out (the SDK resolves a pending request by id; a late release reaches
  `onLatticeRelease`).

## Standing push (person's phone → agent, opt-in per grant)

```
[[SALT-LATTICE-RELEASE id=01J8XKA... standing=g_01J8W...]]
{"grant_id":"g_01J8W...","since_seq":1240,"facts":[...]}
```

Only `auto` fields of that grant, only changes since the last push, only while the grant's `expires_at` is
in the future. Each push is a logged release of kind `standing`.

## Proposal (agent → person's phone)

```
[[SALT-LATTICE-PROPOSE id=01J8XKB...]]
{"proposals":[{"type":"preferences.food.cuisine","parent_name":"Food","fields":{"name":"Japanese","strength":0.8}}]}
```

Lands `pending` unless the agent's grant lists the compartment in `trusted_writes` (R3). The phone replies
nothing; the person sees it in Lattice › Proposals. Unknown type or field → the proposal is dropped and
nothing is said (closed schema, R1).

## Salt API (salt-api, all under `/api/v1/lattice`)

| Route | Who | Body / result |
|---|---|---|
| `GET /schema` | anyone signed in | the crate's `schema_json()` (checked-in copy `public/lattice/schema.v1.json`) |
| `GET /grants` | person: own grants; agent: grants naming it (rules, modes, standing expiry — names only) | `[{id, agent:{id, username, display_name}, agent_fingerprint, key_changed, rules:[{selector, mode}], trusted_writes:[], standing:{expires_at}|null, version, created_at, revoked_at}]` |
| `POST /grants` | person | `{agent_id, rules, trusted_writes?, standing?: bool}` → binds `agent_fingerprint` from the agent's current `UserKey#public_fingerprint`; standing sets `expires_at = now + 90 days`; refuses `system.*` selectors and unknown selector shapes (422) |
| `PATCH /grants/:id` | person (owner) | rules / trusted_writes / standing; bumps `version`; re-binds the fingerprint (that is "approve again") |
| `POST /grants/:id/renew` | person | standing `expires_at = now + 90 days` |
| `DELETE /grants/:id` | person | sets `revoked_at` (row kept) |
| `GET /backup` | person | `{version, blob, key_wrap, updated_at}` or 404 |
| `PUT /backup` | person | `{version (expected current, 0 for first), blob (base64 ciphertext), key_wrap (base64 ciphertext, optional, carried forward when omitted)}` → 200 `{version}`; 409 on version mismatch |

`key_changed` is computed on read: the grant's bound fingerprint differs from the agent's current key.
Grants are the server's rows; the phone mirrors them into its `system` compartment on open and on change
(`set_grant` with the server's id), and evaluates locally.

Notifications (`Notification::KINDS`): `lattice_standing_expiring` (7 days before, daily sweep
`LatticeGrantExpirySweepJob`) and `lattice_standing_expired`. Requests and releases are invisible to the
server, so there is no server-side notification for them; the phone handles those locally.

## Key backup

The vault's messages DEK wraps Lattice's raw root key (AES-GCM, via `encryptPayload` from
`walletVault.js`, the ONE place Lattice touches the vault modules: `salt-fe/src/lattice/backupKey.js`).
The ciphertext is `key_wrap` on the backup row. After a vault recovery the messages DEK is back, so the
wrap opens; the vault row itself is never changed by Lattice.
