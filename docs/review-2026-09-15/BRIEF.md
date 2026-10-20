# Adversarial review brief: Lattice

You are one expert in a contrarian review swarm. Your job is to ATTACK Lattice, not to admire it. Assume the design is wrong until the code proves otherwise. The owner explicitly asked for caveats, bottlenecks, stupid ideas, and solutions.

## What Lattice is
A typed, hierarchical graph of facts about one person, stored encrypted on the person's phone inside the Salt web app (E2E encrypted chat + crypto payments; agents are third-party bots in chats). Rust → wasm in a Web Worker, files in OPFS, keys in WebCrypto/IndexedDB. Agents ask for facts via a grant → request → evaluate → consent → release → log flow that rides INSIDE encrypted chat messages; the Salt server sees only grant shapes and an opaque backup blob. Ion is the on-device model meant to fill Lattice from conversations (baseline currently poor).

## Read these first (all absolute paths, all under /Users/z1ggy/projects/salt)
- salt-lattice/CLAUDE.md, salt-lattice/docs/DESIGN.md, docs/PROTOCOL.md, docs/RISKS.md (six risks ALREADY accepted: A1–A6; you may dispute that they should have been accepted), docs/GATES.md, docs/SCHEMA.md
- Crate: salt-lattice/crates/lattice-core/src/{access,api,store,query,schema,model,ids}.rs
- Worker + client: salt-lattice/web/{lattice.worker.js,lattice.js,crypto.js}
- Web app glue: salt-fe/src/lattice/{requestHandler,backup,backupKey,sync,client,markers}.js ; salt-fe/src/components/lattice/{LatticeRequestHandler,LatticeConsentSheet,LatticePage}.jsx
- API: salt-api/app/controllers/api/v1/lattice/*.rb, salt-api/app/models/lattice_grant.rb, lattice_backup.rb, salt-api/app/services/lattice_schema.rb
- Agent side: salt-agent-sdk/src/lattice.ts ; salt-claude-agent (grep -ri lattice src/)
- Ion: salt-ion/docs/DESIGN.md, docs/BASELINE.md
- Context: /Users/z1ggy/projects/salt/CLAUDE.md (sections on Lattice, sidechains, vault, agents)

Read the code, not just the docs. Cite file:line for every claim. If you assert something is missing, confirm with two differently-shaped searches.

## Output
Write your full report to /Users/z1ggy/.claude/jobs/1721d84f/tmp/swarm/<your-lens>.md and ALSO return it as your final message. Format, strictly:

```
# <Lens> review
## Verdict (3 sentences, contrarian, honest)
## Findings
### F1. <title>
- Kind: caveat | bottleneck | stupid-idea | premise-attack
- Severity: critical | high | medium | low
- Evidence: file:line, quoted snippet or measured fact
- Attack: what goes wrong, concretely (inputs → outcome)
- Solution: the smallest change that closes it, or "accept, because …"
- Cost: S | M | L
### F2 …
## The one thing I'd kill or change first
## What is actually good (max 3 bullets; be stingy)
```
Aim for 6–10 findings. No padding. No generic advice ("add more tests"). Every finding must be specific to THIS code or THIS design. Under 1800 words.
