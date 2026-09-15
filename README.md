# Lattice — mobile ontology datastore for AI agent knowledge bases

Lattice: a typed, hierarchical graph of facts about one person, stored
encrypted on the person's own phone inside the Salt web app. Agents reach it
through Salt, one granted request at a time; nothing leaves the phone unless a
grant says so, and every release is logged.

Rust compiled to WebAssembly, run in a Web Worker, persisted in the Origin
Private File System. Its keys are its own: nothing here derives from or touches
Salt's vault (wallets, messages, recovery words).

Proposal: https://claude.ai/artifact/SSPnMuXJuhj2BdSzBFu3Xc
