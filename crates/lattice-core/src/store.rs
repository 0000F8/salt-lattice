//! The log-structured store (`docs/DESIGN.md` §5): records, frames in/out,
//! the in-memory index, versions, proposal accept/reject, destroy and
//! compact. This module also owns grants and the disclosure log, since both
//! are just `system`-compartment records like everything else (§2, §7).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::{Error, LatticeResult};
use crate::ids::{self, Env};
use crate::model::*;
use crate::schema;

/// One entry in the log. `seq` is global and monotonic across every
/// compartment; `compartment` says which encrypted file it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub seq: u64,
    pub ts: u64,
    pub compartment: String,
    pub body: RecordBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecordBody {
    Node(Node),
    Link(Link),
    Grant(Grant),
    RevokeGrant { grant_id: String, revoked_at: u64 },
    Disclosure(DisclosureEntry),
    DestroyCompartment { compartment: String, at: u64 },
}

#[derive(Debug, Clone, Serialize)]
pub struct CompartmentStats {
    pub nodes: usize,
    pub links: usize,
    pub versions: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub seq: u64,
    pub compartments: BTreeMap<String, CompartmentStats>,
}

pub struct Store {
    env: Env,

    next_seq: u64,
    applied_seqs: BTreeSet<u64>,
    loaded_compartments: BTreeSet<String>,
    destroyed: BTreeSet<String>,

    /// Every record ever applied, grouped by compartment, seq-ordered. The
    /// durable source `compact` and `versions` read from.
    by_compartment: BTreeMap<String, Vec<Record>>,
    /// Records written this session that the wrapper has not yet flushed.
    pending_out: BTreeMap<String, Vec<Record>>,
    /// Records handed to `load_frame`, waiting for `finish_open`.
    pending_in: Vec<Record>,

    nodes: BTreeMap<String, Node>,
    node_versions: BTreeMap<String, Vec<Node>>,
    node_seq: BTreeMap<String, u64>,

    links: BTreeMap<String, Link>,
    link_versions: BTreeMap<String, Vec<Link>>,

    grants: BTreeMap<String, Grant>,
    current_grant_by_agent: BTreeMap<String, String>,

    disclosures: Vec<DisclosureEntry>,
}

impl Store {
    pub fn new(env: Env) -> Self {
        Store {
            env,
            next_seq: 0,
            applied_seqs: BTreeSet::new(),
            loaded_compartments: BTreeSet::new(),
            destroyed: BTreeSet::new(),
            by_compartment: BTreeMap::new(),
            pending_out: BTreeMap::new(),
            pending_in: Vec::new(),
            nodes: BTreeMap::new(),
            node_versions: BTreeMap::new(),
            node_seq: BTreeMap::new(),
            links: BTreeMap::new(),
            link_versions: BTreeMap::new(),
            grants: BTreeMap::new(),
            current_grant_by_agent: BTreeMap::new(),
            disclosures: Vec::new(),
        }
    }

    pub fn env(&self) -> &Env {
        &self.env
    }

    pub fn now(&self) -> u64 {
        self.env.tick()
    }

    pub fn new_id(&self, prefix: &str) -> String {
        ids::generate_id(&self.env, prefix)
    }

    // ---------------------------------------------------------------- open

    /// Parse one decrypted frame's plaintext (newline-separated JSON
    /// records) and queue its records for `finish_open`. A frame for an
    /// already-destroyed compartment is ignored: the file should not exist
    /// any more, but if a stale one is handed in anyway it must not
    /// resurrect data.
    pub fn load_frame(&mut self, compartment: &str, bytes: &[u8]) -> LatticeResult<()> {
        if self.destroyed.contains(compartment) {
            return Ok(());
        }
        self.loaded_compartments.insert(compartment.to_string());
        let text = std::str::from_utf8(bytes)
            .map_err(|e| Error::new("bad_frame", format!("frame is not utf-8: {e}")))?;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let record: Record = serde_json::from_str(line)
                .map_err(|e| Error::new("bad_frame", format!("bad record json: {e}")))?;
            self.pending_in.push(record);
        }
        Ok(())
    }

    /// Sort everything queued by `load_frame` by `seq` and apply it. Safe to
    /// call repeatedly (e.g. after loading another compartment later): each
    /// record is applied at most once (`applied_seqs`), and only the newly
    /// queued records are processed each time.
    pub fn finish_open(&mut self) {
        let mut batch = std::mem::take(&mut self.pending_in);
        batch.sort_by_key(|r| r.seq);
        for record in batch {
            self.next_seq = self.next_seq.max(record.seq + 1);
            self.apply_record(record, true);
        }
    }

    pub fn is_loaded(&self, compartment: &str) -> bool {
        self.loaded_compartments.contains(compartment)
    }

    // --------------------------------------------------------------- flush

    /// Bytes to append to `compartment`'s file: every record written since
    /// the last `take_frame` for it. Empty if nothing is pending.
    pub fn take_frame(&mut self, compartment: &str) -> Vec<u8> {
        let records = self.pending_out.remove(compartment).unwrap_or_default();
        encode_frame(&records)
    }

    pub fn pending_compartments(&self) -> Vec<String> {
        self.pending_out.keys().cloned().collect()
    }

    /// One frame's worth of plaintext holding every record this store has
    /// ever applied for `compartment` — for the worker to rewrite the file
    /// as a single frame instead of many. Read-only: does not mutate
    /// `pending_out`/`by_compartment` (compaction is not run automatically
    /// in phase 1; see DESIGN.md).
    pub fn compact(&self, compartment: &str) -> Vec<u8> {
        let records = self
            .by_compartment
            .get(compartment)
            .cloned()
            .unwrap_or_default();
        encode_frame(&records)
    }

    // ------------------------------------------------------------- commit

    fn commit(&mut self, compartment: String, body: RecordBody) {
        let seq = self.next_seq;
        self.next_seq += 1;
        let ts = self.now();
        let record = Record {
            seq,
            ts,
            compartment,
            body,
        };
        self.apply_record(record, false);
    }

    /// Apply one record to the in-memory index. `is_replay` is false only
    /// for a record freshly committed this call (which also needs to be
    /// queued for `take_frame`); replayed records (from `finish_open`) only
    /// update the index.
    fn apply_record(&mut self, record: Record, is_replay: bool) {
        if !self.applied_seqs.insert(record.seq) {
            return; // already applied (idempotent re-load)
        }

        let compartment = record.compartment.clone();
        self.by_compartment
            .entry(compartment.clone())
            .or_default()
            .push(record.clone());
        if !is_replay {
            self.pending_out
                .entry(compartment)
                .or_default()
                .push(record.clone());
        }

        match record.body {
            RecordBody::Node(node) => {
                let id = node.id.clone();
                self.node_versions
                    .entry(id.clone())
                    .or_default()
                    .push(node.clone());
                self.node_seq.insert(id.clone(), record.seq);
                self.nodes.insert(id, node);
            }
            RecordBody::Link(link) => {
                let id = link.id.clone();
                self.link_versions
                    .entry(id.clone())
                    .or_default()
                    .push(link.clone());
                self.links.insert(id, link);
            }
            RecordBody::Grant(grant) => {
                let agent_id = grant.agent_id.clone();
                let id = grant.id.clone();
                let is_active = grant.revoked.is_none();
                self.grants.insert(id.clone(), grant);
                if is_active {
                    self.current_grant_by_agent.insert(agent_id, id);
                }
            }
            RecordBody::RevokeGrant {
                grant_id,
                revoked_at,
            } => {
                if let Some(grant) = self.grants.get_mut(&grant_id) {
                    grant.revoked = Some(revoked_at);
                    let agent_id = grant.agent_id.clone();
                    if self.current_grant_by_agent.get(&agent_id) == Some(&grant_id) {
                        self.current_grant_by_agent.remove(&agent_id);
                    }
                }
            }
            RecordBody::Disclosure(entry) => {
                self.disclosures.push(entry);
            }
            RecordBody::DestroyCompartment { compartment, .. } => {
                self.purge_compartment(&compartment);
            }
        }
    }

    fn purge_compartment(&mut self, compartment: &str) {
        self.destroyed.insert(compartment.to_string());
        let dead_nodes: Vec<String> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.compartment == compartment)
            .map(|(id, _)| id.clone())
            .collect();
        for id in dead_nodes {
            self.nodes.remove(&id);
            self.node_versions.remove(&id);
            self.node_seq.remove(&id);
        }
        let dead_links: Vec<String> = self
            .links
            .iter()
            .filter(|(id, _)| self.link_record_compartment(id).as_deref() == Some(compartment))
            .map(|(id, _)| id.clone())
            .collect();
        for id in dead_links {
            self.links.remove(&id);
            self.link_versions.remove(&id);
        }
        self.by_compartment.remove(compartment);
        self.pending_out.remove(compartment);
    }

    fn link_record_compartment(&self, link_id: &str) -> Option<String> {
        self.link_versions
            .get(link_id)
            .and_then(|v| v.last())
            .and_then(|link| self.get_node(&link.from))
            .map(|n| n.compartment.clone())
    }

    // ------------------------------------------------------------- writes

    fn initial_status(&self, author: &Author, compartment: &str) -> Status {
        match author.kind {
            AuthorKind::You => Status::Accepted,
            AuthorKind::Ion => Status::Pending,
            AuthorKind::Agent => {
                let trusted = author
                    .fingerprint
                    .as_deref()
                    .and_then(|fp| self.find_grant_by_fingerprint(fp))
                    .map(|g| g.trusted_writes.iter().any(|c| c == compartment))
                    .unwrap_or(false);
                if trusted {
                    Status::Accepted
                } else {
                    Status::Pending
                }
            }
        }
    }

    pub fn put_node(&mut self, input: PutNodeInput) -> LatticeResult<Node> {
        let type_def = schema::find_type(&input.type_)
            .ok_or_else(|| Error::new("unknown_type", format!("no such type: {}", input.type_)))?;

        validate_fields(&input.type_, &input.fields)?;
        validate_parent(self, type_def, input.parent.as_deref())?;

        let compartment = schema::compartment_of(&input.type_)
            .expect("a valid type name always has a valid compartment segment")
            .as_str()
            .to_string();

        let (id, created, version) = match &input.id {
            Some(id) => {
                let existing = self
                    .get_node(id)
                    .ok_or_else(|| Error::new("not_found", format!("no node with id {id}")))?;
                if existing.type_ != input.type_ {
                    return Err(Error::new(
                        "type_mismatch",
                        "an edit cannot change a node's type",
                    ));
                }
                (id.clone(), existing.created, existing.version + 1)
            }
            None => (self.new_id("n_"), self.now(), 1),
        };

        let status = self.initial_status(&input.author, &compartment);
        let now = self.now();
        let node = Node {
            id,
            type_: input.type_,
            parent: input.parent,
            fields: input.fields,
            compartment: compartment.clone(),
            author: input.author,
            status,
            version,
            created,
            updated: now,
        };

        self.commit(compartment, RecordBody::Node(node.clone()));
        Ok(node)
    }

    pub fn put_link(&mut self, input: PutLinkInput) -> LatticeResult<Link> {
        let link_def = schema::find_link(&input.type_).ok_or_else(|| {
            Error::new(
                "unknown_link_type",
                format!("no such link type: {}", input.type_),
            )
        })?;

        let from_node = self
            .get_node(&input.from)
            .ok_or_else(|| Error::new("not_found", format!("no node with id {}", input.from)))?;
        let to_node = self
            .get_node(&input.to)
            .ok_or_else(|| Error::new("not_found", format!("no node with id {}", input.to)))?;

        if !link_def.from.contains(&from_node.type_.as_str()) {
            return Err(Error::new(
                "invalid_link_endpoint",
                "from node's type is not valid for this link",
            ));
        }
        if !link_def.to.contains(&to_node.type_.as_str()) {
            return Err(Error::new(
                "invalid_link_endpoint",
                "to node's type is not valid for this link",
            ));
        }

        let compartment = from_node.compartment.clone();
        let status = match self.initial_status(&input.author, &compartment) {
            Status::Accepted => LinkStatus::Accepted,
            _ => LinkStatus::Pending,
        };

        let link = Link {
            id: self.new_id("l_"),
            type_: input.type_,
            from: input.from,
            to: input.to,
            author: input.author,
            status,
            created: self.now(),
        };

        self.commit(compartment, RecordBody::Link(link.clone()));
        Ok(link)
    }

    fn record_id_kind(id: &str) -> LatticeResult<&'static str> {
        if id.starts_with("n_") {
            Ok("node")
        } else if id.starts_with("l_") {
            Ok("link")
        } else {
            Err(Error::new("not_found", format!("no record with id {id}")))
        }
    }

    pub fn accept(&mut self, id: &str) -> LatticeResult<()> {
        self.transition_pending(id, Status::Accepted, LinkStatus::Accepted)
    }

    pub fn reject(&mut self, id: &str) -> LatticeResult<()> {
        self.transition_pending(id, Status::Rejected, LinkStatus::Deleted)
    }

    fn transition_pending(
        &mut self,
        id: &str,
        node_to: Status,
        link_to: LinkStatus,
    ) -> LatticeResult<()> {
        match Self::record_id_kind(id)? {
            "node" => {
                let node = self
                    .get_node(id)
                    .ok_or_else(|| Error::new("not_found", "no such node"))?;
                if node.status != Status::Pending {
                    return Err(Error::new(
                        "not_pending",
                        "only a pending node can be accepted or rejected",
                    ));
                }
                let mut next = node.clone();
                next.status = node_to;
                next.version += 1;
                next.updated = self.now();
                let compartment = next.compartment.clone();
                self.commit(compartment, RecordBody::Node(next));
                Ok(())
            }
            _ => {
                let link = self
                    .links
                    .get(id)
                    .ok_or_else(|| Error::new("not_found", "no such link"))?;
                if link.status != LinkStatus::Pending {
                    return Err(Error::new(
                        "not_pending",
                        "only a pending link can be accepted or rejected",
                    ));
                }
                let mut next = link.clone();
                next.status = link_to;
                let compartment = self
                    .get_node(&next.from)
                    .map(|n| n.compartment.clone())
                    .unwrap_or_else(|| "identity".to_string());
                self.commit(compartment, RecordBody::Link(next));
                Ok(())
            }
        }
    }

    /// Delete only ever runs as `you` (phase-1 decision, see DESIGN.md): an
    /// agent's pending write can be rejected but never used to delete
    /// standing data, which avoids the ambiguity of what a *pending delete*
    /// would even mean for `accept`.
    pub fn delete_node(&mut self, id: &str) -> LatticeResult<()> {
        let node = self
            .get_node(id)
            .ok_or_else(|| Error::new("not_found", "no such node"))?;
        if node.status == Status::Deleted {
            return Ok(());
        }
        let mut next = node.clone();
        next.status = Status::Deleted;
        next.version += 1;
        next.updated = self.now();
        let compartment = next.compartment.clone();
        self.commit(compartment, RecordBody::Node(next));
        Ok(())
    }

    pub fn delete_link(&mut self, id: &str) -> LatticeResult<()> {
        let link = self
            .links
            .get(id)
            .ok_or_else(|| Error::new("not_found", "no such link"))?;
        if link.status == LinkStatus::Deleted {
            return Ok(());
        }
        let mut next = link.clone();
        next.status = LinkStatus::Deleted;
        let compartment = self
            .get_node(&next.from)
            .map(|n| n.compartment.clone())
            .unwrap_or_else(|| "identity".to_string());
        self.commit(compartment, RecordBody::Link(next));
        Ok(())
    }

    // ------------------------------------------------------------- reads

    pub fn get_node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn get_link(&self, id: &str) -> Option<&Link> {
        self.links.get(id)
    }

    pub fn accepted_nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values().filter(|n| n.status == Status::Accepted)
    }

    pub fn all_nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn accepted_links(&self) -> impl Iterator<Item = &Link> {
        self.links
            .values()
            .filter(|l| l.status == LinkStatus::Accepted)
    }

    pub fn seq_of(&self, id: &str) -> Option<u64> {
        self.node_seq.get(id).copied()
    }

    pub fn versions(&self, id: &str) -> LatticeResult<Vec<VersionEntry>> {
        match Self::record_id_kind(id)? {
            "node" => self
                .node_versions
                .get(id)
                .map(|v| v.iter().cloned().map(VersionEntry::Node).collect())
                .ok_or_else(|| Error::new("not_found", "no such node")),
            _ => self
                .link_versions
                .get(id)
                .map(|v| v.iter().cloned().map(VersionEntry::Link).collect())
                .ok_or_else(|| Error::new("not_found", "no such link")),
        }
    }

    // ------------------------------------------------------------ grants

    pub fn find_grant(&self, id: &str) -> Option<&Grant> {
        self.grants.get(id)
    }

    pub fn current_grant_for_agent(&self, agent_id: &str) -> Option<&Grant> {
        self.current_grant_by_agent
            .get(agent_id)
            .and_then(|id| self.grants.get(id))
    }

    pub fn find_grant_by_fingerprint(&self, fingerprint: &str) -> Option<&Grant> {
        self.current_grant_by_agent
            .values()
            .filter_map(|id| self.grants.get(id))
            .find(|g| g.agent_fingerprint == fingerprint)
    }

    pub fn list_grants(&self) -> Vec<Grant> {
        self.current_grant_by_agent
            .values()
            .filter_map(|id| self.grants.get(id))
            .filter(|g| g.revoked.is_none())
            .cloned()
            .collect()
    }

    pub fn all_grants_including_revoked(&self) -> Vec<Grant> {
        self.grants.values().cloned().collect()
    }

    /// Create (or, for the same `agent_id`, supersede) a grant. R8: a
    /// selector naming the `system` compartment is refused outright.
    pub fn set_grant(
        &mut self,
        agent_id: String,
        agent_fingerprint: String,
        rules: Vec<GrantRule>,
        trusted_writes: Vec<String>,
        standing: Option<Standing>,
    ) -> LatticeResult<Grant> {
        for rule in &rules {
            let selector = crate::access::Selector::parse(&rule.selector).ok_or_else(|| {
                Error::new(
                    "invalid_selector",
                    format!("unknown selector: {}", rule.selector),
                )
            })?;
            if selector.compartment_name() == schema::Compartment::System.as_str() {
                return Err(Error::new(
                    "grant_names_system",
                    "a grant may never name the system compartment",
                ));
            }
        }

        if let Some(prev_id) = self.current_grant_by_agent.get(&agent_id).cloned() {
            let now = self.now();
            self.commit(
                "system".to_string(),
                RecordBody::RevokeGrant {
                    grant_id: prev_id,
                    revoked_at: now,
                },
            );
        }

        let grant = Grant {
            id: self.new_id("g_"),
            agent_id,
            agent_fingerprint,
            rules,
            trusted_writes,
            standing,
            created: self.now(),
            revoked: None,
        };
        self.commit("system".to_string(), RecordBody::Grant(grant.clone()));
        Ok(grant)
    }

    pub fn revoke_grant(&mut self, grant_id: &str) -> LatticeResult<()> {
        if !self.grants.contains_key(grant_id) {
            return Err(Error::new("not_found", "no such grant"));
        }
        let now = self.now();
        self.commit(
            "system".to_string(),
            RecordBody::RevokeGrant {
                grant_id: grant_id.to_string(),
                revoked_at: now,
            },
        );
        Ok(())
    }

    // -------------------------------------------------------- disclosure

    pub fn append_disclosure(&mut self, entry: DisclosureEntry) {
        self.commit("system".to_string(), RecordBody::Disclosure(entry));
    }

    /// Newest first, optionally scoped to one agent, paged by `before` (an
    /// exclusive disclosure id cursor).
    pub fn disclosure_log(
        &self,
        agent_id: Option<&str>,
        limit: usize,
        before: Option<&str>,
    ) -> Vec<DisclosureEntry> {
        let mut all: Vec<&DisclosureEntry> = self.disclosures.iter().collect();
        all.reverse(); // newest first (disclosures is append-ordered)

        let mut started = before.is_none();
        let mut out = Vec::new();
        for entry in all {
            if let Some(agent) = agent_id {
                if entry.agent_id != agent {
                    continue;
                }
            }
            if !started {
                if entry.id == before.unwrap() {
                    started = true;
                }
                continue;
            }
            out.push(entry.clone());
            if out.len() >= limit {
                break;
            }
        }
        out
    }

    // ----------------------------------------------------------- destroy

    pub fn destroy_compartment(&mut self, compartment: &str) {
        let at = self.now();
        self.commit(
            "system".to_string(),
            RecordBody::DestroyCompartment {
                compartment: compartment.to_string(),
                at,
            },
        );
    }

    pub fn is_destroyed(&self, compartment: &str) -> bool {
        self.destroyed.contains(compartment)
    }

    // ------------------------------------------------------------- stats

    pub fn stats(&self) -> Stats {
        let mut compartments: BTreeMap<String, CompartmentStats> = BTreeMap::new();
        for node in self.nodes.values() {
            let entry = compartments
                .entry(node.compartment.clone())
                .or_insert(CompartmentStats {
                    nodes: 0,
                    links: 0,
                    versions: 0,
                });
            entry.nodes += 1;
        }
        for (id, versions) in &self.node_versions {
            if let Some(node) = self.nodes.get(id) {
                let entry =
                    compartments
                        .entry(node.compartment.clone())
                        .or_insert(CompartmentStats {
                            nodes: 0,
                            links: 0,
                            versions: 0,
                        });
                entry.versions += versions.len();
            }
        }
        for (id, link) in &self.links {
            let compartment = self
                .link_record_compartment(id)
                .unwrap_or_else(|| "identity".to_string());
            let entry = compartments.entry(compartment).or_insert(CompartmentStats {
                nodes: 0,
                links: 0,
                versions: 0,
            });
            entry.links += 1;
            let _ = link;
        }
        Stats {
            seq: self.next_seq,
            compartments,
        }
    }
}

fn encode_frame(records: &[Record]) -> Vec<u8> {
    let mut out = String::new();
    for record in records {
        out.push_str(&serde_json::to_string(record).expect("Record always serializes"));
        out.push('\n');
    }
    out.into_bytes()
}

fn validate_parent(
    store: &Store,
    type_def: &schema::TypeDef,
    parent: Option<&str>,
) -> LatticeResult<()> {
    match (type_def.parent, parent) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err(Error::new(
            "invalid_parent",
            "this type is top-level and takes no parent",
        )),
        (Some(_), None) => Err(Error::new("invalid_parent", "this type requires a parent")),
        (Some(expected), Some(parent_id)) => {
            let parent_node = store
                .get_node(parent_id)
                .ok_or_else(|| Error::new("invalid_parent", "parent node does not exist"))?;
            if parent_node.type_ != expected {
                return Err(Error::new(
                    "invalid_parent",
                    format!(
                        "parent must be of type {expected}, got {}",
                        parent_node.type_
                    ),
                ));
            }
            Ok(())
        }
    }
}

/// Closed-schema field validation (R1): every field name must be declared on
/// the type (or be the implicit `name`/`note`), every `required` field must
/// be present, and an `enum`/`enum_list` value must be one of the allowed
/// values.
fn validate_fields(type_name: &str, fields: &Fields) -> LatticeResult<()> {
    let type_def = schema::find_type(type_name).expect("caller already checked the type exists");

    for (name, value) in fields {
        let field_def = schema::find_field(type_name, name).ok_or_else(|| {
            Error::new(
                "unknown_field",
                format!("{type_name} has no field '{name}'"),
            )
        })?;
        validate_value(&field_def, value)?;
    }

    if !fields.contains_key("name") {
        return Err(Error::new(
            "missing_required_field",
            "field 'name' is required",
        ));
    }
    for field_def in type_def.fields.iter().filter(|f| f.required) {
        if !fields.contains_key(field_def.name) {
            return Err(Error::new(
                "missing_required_field",
                format!("field '{}' is required", field_def.name),
            ));
        }
    }
    Ok(())
}

fn validate_value(field_def: &schema::FieldDef, value: &serde_json::Value) -> LatticeResult<()> {
    match field_def.kind {
        schema::FieldKind::Enum(values) => {
            let s = value.as_str().ok_or_else(|| {
                Error::new(
                    "invalid_field_value",
                    format!("'{}' must be a string", field_def.name),
                )
            })?;
            if !values.contains(&s) {
                return Err(Error::new(
                    "invalid_enum_value",
                    format!("'{s}' is not a valid value for '{}'", field_def.name),
                ));
            }
        }
        schema::FieldKind::EnumList(values) => {
            let arr = value.as_array().ok_or_else(|| {
                Error::new(
                    "invalid_field_value",
                    format!("'{}' must be an array", field_def.name),
                )
            })?;
            for item in arr {
                let s = item.as_str().ok_or_else(|| {
                    Error::new(
                        "invalid_field_value",
                        format!("'{}' entries must be strings", field_def.name),
                    )
                })?;
                if !values.contains(&s) {
                    return Err(Error::new(
                        "invalid_enum_value",
                        format!("'{s}' is not a valid value for '{}'", field_def.name),
                    ));
                }
            }
        }
        _ => {}
    }
    Ok(())
}
