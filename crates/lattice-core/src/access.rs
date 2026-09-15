//! Grant evaluation, release and the disclosure log (`docs/DESIGN.md` §7).
//! Rules decide access; nothing here ever asks a model.

use crate::error::{Error, LatticeResult};
use crate::model::*;
use crate::schema::{self, Compartment};
use crate::store::Store;

/// A grant rule / request ask selector: `compartment.*`, `type.*` or
/// `type.field`, most-specific-wins in that order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selector {
    Compartment(String),
    Type(String),
    Field(String, String),
}

impl Selector {
    /// Parse against the schema: a selector that doesn't resolve to a real
    /// compartment/type/field is not a valid selector at all.
    pub fn parse(s: &str) -> Option<Selector> {
        if let Some(prefix) = s.strip_suffix(".*") {
            if !prefix.contains('.') && Compartment::parse(prefix).is_some() {
                return Some(Selector::Compartment(prefix.to_string()));
            }
            if schema::find_type(prefix).is_some() {
                return Some(Selector::Type(prefix.to_string()));
            }
            return None;
        }
        let (type_part, field_part) = s.rsplit_once('.')?;
        if schema::find_field(type_part, field_part).is_some() {
            return Some(Selector::Field(
                type_part.to_string(),
                field_part.to_string(),
            ));
        }
        None
    }

    pub fn specificity(&self) -> u8 {
        match self {
            Selector::Compartment(_) => 0,
            Selector::Type(_) => 1,
            Selector::Field(_, _) => 2,
        }
    }

    pub fn compartment_name(&self) -> &str {
        match self {
            Selector::Compartment(c) => c,
            Selector::Type(t) | Selector::Field(t, _) => t
                .split('.')
                .next()
                .expect("a valid type name has at least one segment"),
        }
    }

    pub fn matches(&self, type_name: &str, field: &str) -> bool {
        match self {
            Selector::Compartment(c) => schema::compartment_of(type_name)
                .map(|cc| cc.as_str() == c)
                .unwrap_or(false),
            Selector::Type(t) => t == type_name,
            Selector::Field(t, f) => t == type_name && f == field,
        }
    }
}

fn map_author(author: &Author) -> FactAuthor {
    // Decision: Ion is on-device and first-party (it fills Lattice from the
    // person's own conversations), so it is masked as "you"; only a
    // third-party Agent author is masked as "agent" (DESIGN.md §7).
    match author.kind {
        AuthorKind::You | AuthorKind::Ion => FactAuthor::You,
        AuthorKind::Agent => FactAuthor::Agent,
    }
}

/// The query-path-shaped identifier a released [`Fact`] carries: the type's
/// path under its compartment, with the node's `name` field as the last
/// segment (matching the `path` syntax in DESIGN.md §4, e.g.
/// `preferences/food/cuisine/Japanese`).
pub fn node_path(node: &Node) -> String {
    let type_path = node.type_.replace('.', "/");
    let name = node
        .fields
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    format!("{type_path}/{name}")
}

fn grant_is_valid_for(grant: &Grant, request: &Request) -> bool {
    grant.revoked.is_none() && grant.agent_fingerprint == request.agent_fingerprint
}

fn best_rule<'a>(grant: &'a Grant, type_name: &str, field: &str) -> Option<&'a GrantRule> {
    grant
        .rules
        .iter()
        .filter_map(|rule| Selector::parse(&rule.selector).map(|sel| (sel, rule)))
        .filter(|(sel, _)| sel.matches(type_name, field))
        .max_by_key(|(sel, _)| sel.specificity())
        .map(|(_, rule)| rule)
}

/// `evaluate(request) -> Evaluation` (§7). Only accepted nodes are ever
/// considered (R4). R6: a group-channel request is refused outright. R5: no
/// grant, a revoked grant, or a fingerprint mismatch all yield an empty
/// evaluation with every asked field counted in `omitted`. R13: an expired
/// *standing* grant still evaluates normally on demand.
pub fn evaluate(store: &Store, request: &Request) -> LatticeResult<Evaluation> {
    if request.channel == Channel::Group {
        return Err(Error::new(
            "group_channel",
            "a request from a group channel is refused",
        ));
    }

    let ask_selectors: Vec<Selector> = request
        .asks
        .iter()
        .filter_map(|s| Selector::parse(s))
        .collect();
    let grant = store.current_grant_for_agent(&request.agent_id);
    let grant_valid = grant
        .map(|g| grant_is_valid_for(g, request))
        .unwrap_or(false);

    let mut auto = Vec::new();
    let mut ask = Vec::new();
    let mut omitted = 0usize;

    for node in store.accepted_nodes() {
        for (field_name, value) in node.fields.iter() {
            if !ask_selectors
                .iter()
                .any(|sel| sel.matches(&node.type_, field_name))
            {
                continue;
            }
            if !grant_valid {
                omitted += 1;
                continue;
            }
            let grant = grant.expect("grant_valid implies grant is Some");
            match best_rule(grant, &node.type_, field_name) {
                Some(rule) if rule.mode == GrantMode::Auto => {
                    auto.push(Fact {
                        path: node_path(node),
                        type_: node.type_.clone(),
                        field: field_name.clone(),
                        value: value.clone(),
                        author: map_author(&node.author),
                        updated: node.updated,
                    });
                }
                Some(rule) => {
                    debug_assert_eq!(rule.mode, GrantMode::Ask);
                    ask.push(ConsentItem {
                        selector: rule.selector.clone(),
                        node_id: node.id.clone(),
                        field: field_name.clone(),
                        value: value.clone(),
                    });
                }
                None => omitted += 1,
            }
        }
    }

    Ok(Evaluation { auto, ask, omitted })
}

/// Turn an approved [`ConsentItem`] into a [`Fact`] by looking its node back
/// up (a `ConsentItem` doesn't carry `author`/`updated` on its own).
pub fn consent_item_to_fact(store: &Store, item: &ConsentItem) -> LatticeResult<Fact> {
    let node = store
        .get_node(&item.node_id)
        .ok_or_else(|| Error::new("not_found", "consented node no longer exists"))?;
    Ok(Fact {
        path: node_path(node),
        type_: node.type_.clone(),
        field: item.field.clone(),
        value: item.value.clone(),
        author: map_author(&node.author),
        updated: node.updated,
    })
}

/// `release(request, facts) -> (ReleasePayload, DisclosureEntry)` (§7). The
/// payload depends only on `request.id` and `facts` — R5's byte-identical
/// claim for a no-match release follows directly from that. Exactly one
/// [`DisclosureEntry`] is appended per call (R12).
pub fn release(
    store: &mut Store,
    request: &Request,
    facts: Vec<Fact>,
    kind: DisclosureKind,
) -> LatticeResult<(ReleasePayload, DisclosureEntry)> {
    let grant_id = store
        .current_grant_for_agent(&request.agent_id)
        .map(|g| g.id.clone())
        .or_else(|| {
            store
                .find_grant_by_fingerprint(&request.agent_fingerprint)
                .map(|g| g.id.clone())
        })
        .unwrap_or_default();

    let fields: Vec<DisclosureFieldRef> = facts
        .iter()
        .map(|f| DisclosureFieldRef {
            path: f.path.clone(),
            field: f.field.clone(),
        })
        .collect();

    let entry = DisclosureEntry {
        id: store.new_id("d_"),
        ts: store.now(),
        agent_id: request.agent_id.clone(),
        agent_fingerprint: request.agent_fingerprint.clone(),
        grant_id,
        request_id: request.id.clone(),
        purpose: request.purpose.clone(),
        kind,
        fields,
    };
    store.append_disclosure(entry.clone());

    let payload = ReleasePayload {
        request_id: request.id.clone(),
        facts,
    };
    Ok((payload, entry))
}

/// `standing_diff(grant_id, since_seq) -> Option<[Fact]>` (§7). `None` when
/// the grant is revoked, has no standing, or its standing has expired (R13);
/// otherwise every accepted field under an `auto` selector whose node was
/// written after `since_seq`.
pub fn standing_diff(store: &Store, grant_id: &str, since_seq: u64, now: u64) -> Option<Vec<Fact>> {
    let grant = store.find_grant(grant_id)?;
    if grant.revoked.is_some() {
        return None;
    }
    let standing = grant.standing.as_ref()?;
    if standing.expires_at < now {
        return None;
    }

    let auto_selectors: Vec<Selector> = grant
        .rules
        .iter()
        .filter(|r| r.mode == GrantMode::Auto)
        .filter_map(|r| Selector::parse(&r.selector))
        .collect();

    let mut facts = Vec::new();
    for node in store.accepted_nodes() {
        let seq = store.seq_of(&node.id).unwrap_or(0);
        if seq <= since_seq {
            continue;
        }
        for (field_name, value) in node.fields.iter() {
            if auto_selectors
                .iter()
                .any(|sel| sel.matches(&node.type_, field_name))
            {
                facts.push(Fact {
                    path: node_path(node),
                    type_: node.type_.clone(),
                    field: field_name.clone(),
                    value: value.clone(),
                    author: map_author(&node.author),
                    updated: node.updated,
                });
            }
        }
    }
    Some(facts)
}
