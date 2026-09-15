//! Path queries, traversal and full-text search (`docs/DESIGN.md` §4).

use serde::{Deserialize, Serialize};

use crate::error::{Error, LatticeResult};
use crate::model::{Link, Node, Status};
use crate::schema;
use crate::store::Store;

#[derive(Debug, Clone, PartialEq, Eq)]
enum PathQuery {
    /// From a trailing `/*`: every node whose type equals, or starts with a
    /// `.`-prefix of, the given dotted type path.
    Prefix(String),
    ExactType(String),
    ExactTypeNamed(String, String),
}

fn parse_path(path: &str) -> LatticeResult<PathQuery> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err(Error::new("invalid_path", "path is empty"));
    }

    if *segments.last().unwrap() == "*" {
        let prefix = segments[..segments.len() - 1].join(".");
        return Ok(PathQuery::Prefix(prefix));
    }

    let full = segments.join(".");
    if schema::find_type(&full).is_some() {
        return Ok(PathQuery::ExactType(full));
    }

    if segments.len() >= 2 {
        let type_part = segments[..segments.len() - 1].join(".");
        if schema::find_type(&type_part).is_some() {
            return Ok(PathQuery::ExactTypeNamed(
                type_part,
                segments.last().unwrap().to_string(),
            ));
        }
    }

    Err(Error::new(
        "unknown_path",
        format!("no type matches path '{path}'"),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Contains,
    Gt,
    Lt,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QueryInput {
    pub path: String,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// `None` (the default) means accepted-only; `Some("all")` bypasses the
    /// status filter entirely; any other value must name a [`Status`].
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

fn status_matches(node: &Node, status_filter: &Option<String>) -> bool {
    match status_filter.as_deref() {
        None => node.status == Status::Accepted,
        Some("all") => true,
        Some(other) => match other {
            "accepted" => node.status == Status::Accepted,
            "pending" => node.status == Status::Pending,
            "rejected" => node.status == Status::Rejected,
            "deleted" => node.status == Status::Deleted,
            _ => false,
        },
    }
}

fn value_contains(haystack: &serde_json::Value, needle: &serde_json::Value) -> bool {
    match haystack {
        serde_json::Value::String(s) => needle
            .as_str()
            .map(|n| s.to_lowercase().contains(&n.to_lowercase()))
            .unwrap_or(false),
        serde_json::Value::Array(items) => items.iter().any(|v| v == needle),
        _ => false,
    }
}

fn as_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

fn filter_matches(node: &Node, filter: &Filter) -> bool {
    let field_value = node.fields.get(&filter.field);
    match filter.op {
        FilterOp::Eq => field_value == Some(&filter.value),
        FilterOp::Ne => field_value != Some(&filter.value),
        FilterOp::Contains => field_value
            .map(|v| value_contains(v, &filter.value))
            .unwrap_or(false),
        FilterOp::Gt => match (field_value.and_then(as_f64), as_f64(&filter.value)) {
            (Some(a), Some(b)) => a > b,
            _ => match (field_value.and_then(|v| v.as_str()), filter.value.as_str()) {
                (Some(a), Some(b)) => a > b,
                _ => false,
            },
        },
        FilterOp::Lt => match (field_value.and_then(as_f64), as_f64(&filter.value)) {
            (Some(a), Some(b)) => a < b,
            _ => match (field_value.and_then(|v| v.as_str()), filter.value.as_str()) {
                (Some(a), Some(b)) => a < b,
                _ => false,
            },
        },
    }
}

fn node_name(node: &Node) -> Option<&str> {
    node.fields.get("name").and_then(|v| v.as_str())
}

pub fn query(store: &Store, input: &QueryInput) -> LatticeResult<Vec<Node>> {
    let parsed = parse_path(&input.path)?;

    let mut matches: Vec<&Node> = store
        .all_nodes()
        .filter(|node| match &parsed {
            PathQuery::Prefix(prefix) => {
                node.type_ == *prefix || node.type_.starts_with(&format!("{prefix}."))
            }
            PathQuery::ExactType(t) => node.type_ == *t,
            PathQuery::ExactTypeNamed(t, name) => {
                node.type_ == *t
                    && node_name(node)
                        .map(|n| n.eq_ignore_ascii_case(name))
                        .unwrap_or(false)
            }
        })
        .filter(|node| status_matches(node, &input.status))
        .filter(|node| !store.is_destroyed(&node.compartment))
        .filter(|node| input.filters.iter().all(|f| filter_matches(node, f)))
        .collect();

    matches.sort_by(|a, b| (a.created, &a.id).cmp(&(b.created, &b.id)));

    let mut owned: Vec<Node> = matches.into_iter().cloned().collect();
    if let Some(limit) = input.limit {
        owned.truncate(limit);
    }
    Ok(owned)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Out,
    In,
    Both,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TraverseInput {
    pub from: String,
    #[serde(default)]
    pub link_types: Option<Vec<String>>,
    pub depth: u32,
    pub direction: Direction,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraverseResult {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
}

pub fn traverse(store: &Store, input: &TraverseInput) -> LatticeResult<TraverseResult> {
    if input.depth < 1 || input.depth > 4 {
        return Err(Error::new("invalid_depth", "depth must be between 1 and 4"));
    }
    if store.get_node(&input.from).is_none() {
        return Err(Error::new("not_found", "no node with that id"));
    }

    let mut visited_nodes: Vec<Node> = Vec::new();
    let mut visited_links: Vec<Link> = Vec::new();
    let mut seen_node_ids = std::collections::BTreeSet::new();
    let mut seen_link_ids = std::collections::BTreeSet::new();
    seen_node_ids.insert(input.from.clone());

    let mut frontier = vec![input.from.clone()];
    for _ in 0..input.depth {
        let mut next_frontier = Vec::new();
        for current in &frontier {
            for link in store.accepted_links() {
                if let Some(types) = &input.link_types {
                    if !types.contains(&link.type_) {
                        continue;
                    }
                }
                let (other, matches_direction) = if link.from == *current
                    && matches!(input.direction, Direction::Out | Direction::Both)
                {
                    (Some(link.to.clone()), true)
                } else if link.to == *current
                    && matches!(input.direction, Direction::In | Direction::Both)
                {
                    (Some(link.from.clone()), true)
                } else {
                    (None, false)
                };

                if !matches_direction {
                    continue;
                }
                let other = match other {
                    Some(o) => o,
                    None => continue,
                };

                if seen_link_ids.insert(link.id.clone()) {
                    visited_links.push(link.clone());
                }

                if let Some(node) = store.get_node(&other) {
                    if node.status == Status::Accepted
                        && !store.is_destroyed(&node.compartment)
                        && seen_node_ids.insert(other.clone())
                    {
                        visited_nodes.push(node.clone());
                        next_frontier.push(other);
                    }
                }
            }
        }
        if next_frontier.is_empty() {
            break;
        }
        frontier = next_frontier;
    }

    Ok(TraverseResult {
        nodes: visited_nodes,
        links: visited_links,
    })
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            current.extend(ch.to_lowercase());
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn indexed_tokens(node: &Node) -> Vec<String> {
    let mut text = String::new();
    if let Some(name) = node.fields.get("name").and_then(|v| v.as_str()) {
        text.push_str(name);
        text.push(' ');
    }
    if let Some(note) = node.fields.get("note").and_then(|v| v.as_str()) {
        text.push_str(note);
    }
    tokenize(&text)
}

/// On-device full text over `name`/`note` (§4): lowercase alphanumeric
/// tokens, the last query token matches by prefix, every other token must
/// match exactly; ranked by hit count then recency. Builds its token index
/// fresh from the current accepted nodes on every call rather than
/// maintaining one incrementally — simple and obviously correct, and search
/// isn't on the store's open-time budget (see DESIGN.md).
pub fn search(store: &Store, text: &str, limit: usize) -> Vec<Node> {
    let query_tokens = tokenize(text);
    if query_tokens.is_empty() {
        return Vec::new();
    }
    let last = query_tokens.last().unwrap();
    let exact = &query_tokens[..query_tokens.len() - 1];

    let mut scored: Vec<(u32, u64, &Node)> = Vec::new();
    for node in store.accepted_nodes() {
        if store.is_destroyed(&node.compartment) {
            continue;
        }
        let node_tokens = indexed_tokens(node);
        let mut hits = 0u32;
        for t in exact {
            if node_tokens.iter().any(|nt| nt == t) {
                hits += 1;
            }
        }
        if node_tokens.iter().any(|nt| nt.starts_with(last.as_str())) {
            hits += 1;
        }
        if hits as usize == query_tokens.len() {
            scored.push((hits, node.updated, node));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, n)| n.clone())
        .collect()
}
