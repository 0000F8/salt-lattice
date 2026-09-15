//! The domain model (`docs/DESIGN.md` §3, §5, §7): nodes, links, records,
//! grants, requests, evaluation and disclosure types.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Fields = BTreeMap<String, serde_json::Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorKind {
    You,
    Agent,
    Ion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Author {
    pub kind: AuthorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

impl Author {
    pub fn you() -> Self {
        Author {
            kind: AuthorKind::You,
            fingerprint: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Accepted,
    Pending,
    Rejected,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub parent: Option<String>,
    pub fields: Fields,
    pub compartment: String,
    pub author: Author,
    pub status: Status,
    pub version: u32,
    pub created: u64,
    pub updated: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    Accepted,
    Pending,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub from: String,
    pub to: String,
    pub author: Author,
    pub status: LinkStatus,
    pub created: u64,
}

/// One version of a node or a link, as returned by `versions(id)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum VersionEntry {
    Node(Node),
    Link(Link),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantMode {
    Auto,
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantRule {
    pub selector: String,
    pub mode: GrantMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Standing {
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grant {
    pub id: String,
    pub agent_id: String,
    pub agent_fingerprint: String,
    pub rules: Vec<GrantRule>,
    #[serde(default)]
    pub trusted_writes: Vec<String>,
    #[serde(default)]
    pub standing: Option<Standing>,
    pub created: u64,
    #[serde(default)]
    pub revoked: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Private,
    Group,
}

/// An incoming ask from an agent. Not itself a stored [`crate::store::RecordBody`]
/// variant: it lives only for the duration of an `evaluate`/`release` call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    pub agent_id: String,
    pub agent_fingerprint: String,
    pub purpose: String,
    pub asks: Vec<String>,
    pub channel: Channel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactAuthor {
    You,
    Agent,
}

/// One disclosed field. `author` is masked to `you`/`agent` only (R7) —
/// never a fingerprint, id or name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fact {
    pub path: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub field: String,
    pub value: serde_json::Value,
    pub author: FactAuthor,
    pub updated: u64,
}

/// One field awaiting the person's consent. Carries `node_id` (not just a
/// path) so the consent sheet can resolve it, and no `updated`/`author` —
/// those are only assigned once a fact is actually released.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsentItem {
    pub selector: String,
    pub node_id: String,
    pub field: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evaluation {
    pub auto: Vec<Fact>,
    pub ask: Vec<ConsentItem>,
    pub omitted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleasePayload {
    pub request_id: String,
    pub facts: Vec<Fact>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisclosureKind {
    OnDemand,
    Standing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisclosureFieldRef {
    pub path: String,
    pub field: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisclosureEntry {
    pub id: String,
    pub ts: u64,
    pub agent_id: String,
    pub agent_fingerprint: String,
    pub grant_id: String,
    pub request_id: String,
    pub purpose: String,
    pub kind: DisclosureKind,
    pub fields: Vec<DisclosureFieldRef>,
}

/// Input to `Store::put_node`. `id: Some(_)` is an edit (replaces the whole
/// field set — PUT semantics, not a merge); `id: None` creates.
#[derive(Debug, Clone, Deserialize)]
pub struct PutNodeInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(default)]
    pub parent: Option<String>,
    pub fields: Fields,
    pub author: Author,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PutLinkInput {
    #[serde(rename = "type")]
    pub type_: String,
    pub from: String,
    pub to: String,
    pub author: Author,
}
