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

    /// Security review B2: `type.*` covers that type's subtree, the same way
    /// `*` already does in a query path (DESIGN.md §4 — `preferences/food/*`
    /// means every type starting with `preferences.food`, not only that
    /// exact type). Before this fix `Selector::Type` matched only the exact
    /// type, so a narrowing rule like `preferences.food.* = ask` did nothing
    /// against a broader `preferences.* = auto` rule: every nested type
    /// (`preferences.food.cuisine`, `.dish`, `.restriction`, ...) still fell
    /// through to the compartment-level rule and released automatically.
    pub fn matches(&self, type_name: &str, field: &str) -> bool {
        match self {
            Selector::Compartment(c) => schema::compartment_of(type_name)
                .map(|cc| cc.as_str() == c)
                .unwrap_or(false),
            Selector::Type(t) => type_name == t || type_name.starts_with(&format!("{t}.")),
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

/// Security review S4: on a specificity tie between two matching rules, the
/// more restrictive one (`ask`) must win, never `auto`. `Iterator::max_by_key`
/// returns the *last* maximum, so ranking by `(specificity, is_ask)` — with
/// `is_ask` as `false < true` — makes an `ask` rule strictly greater than an
/// `auto` rule at equal specificity regardless of which one appears first in
/// `grant.rules` or is visited last by the iterator.
fn best_rule<'a>(grant: &'a Grant, type_name: &str, field: &str) -> Option<&'a GrantRule> {
    grant
        .rules
        .iter()
        .filter_map(|rule| Selector::parse(&rule.selector).map(|sel| (sel, rule)))
        .filter(|(sel, _)| sel.matches(type_name, field))
        .max_by_key(|(sel, rule)| (sel.specificity(), rule.mode == GrantMode::Ask))
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
        if store.is_destroyed(&node.compartment) {
            continue;
        }
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
///
/// Re-checks that the node is still `Accepted` and its compartment isn't
/// destroyed: time can pass between `evaluate()` offering a `ConsentItem`
/// and the person approving it, during which the node can be deleted,
/// rejected, or its whole compartment destroyed. Any of those makes the
/// once-offered value stale and it must not be released.
pub fn consent_item_to_fact(store: &Store, item: &ConsentItem) -> LatticeResult<Fact> {
    let node = store
        .get_node(&item.node_id)
        .ok_or_else(|| Error::new("not_found", "consented node no longer exists"))?;
    if node.status != Status::Accepted || store.is_destroyed(&node.compartment) {
        return Err(Error::new(
            "not_found",
            "consented node is no longer accepted",
        ));
    }
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
/// payload depends only on `request.id` and the (validated) `facts` — R5's
/// byte-identical claim for a no-match release follows directly from that.
/// Exactly one [`DisclosureEntry`] is appended per call (R12).
///
/// `release` does not simply trust the caller's `facts`: authorization is
/// re-derived here by calling `evaluate` again and keeping only facts that
/// still appear in its `auto` set or match one of its current `ask` items
/// (converted through [`consent_item_to_fact`], which itself re-checks the
/// node is still accepted and undestroyed). A fact the caller passes that
/// no longer matches — because a grant was revoked, a node was deleted, or
/// its compartment destroyed since `evaluate` was first called — is
/// silently dropped rather than released. The *approval* half (which `ask`
/// items the person actually consented to) still has to come from the
/// caller — that consent happened once, interactively, and isn't something
/// to re-derive — but every fact release still authorizes is one the
/// current grant state actually allows right now.
pub fn release(
    store: &mut Store,
    request: &Request,
    facts: Vec<Fact>,
    kind: DisclosureKind,
) -> LatticeResult<(ReleasePayload, DisclosureEntry)> {
    let fresh = evaluate(store, request)?;
    let mut currently_allowed = fresh.auto;
    for item in &fresh.ask {
        if let Ok(fact) = consent_item_to_fact(store, item) {
            currently_allowed.push(fact);
        }
    }
    let facts: Vec<Fact> = facts
        .into_iter()
        .filter(|f| {
            currently_allowed.iter().any(|a| {
                a.path == f.path && a.type_ == f.type_ && a.field == f.field && a.value == f.value
            })
        })
        .collect();

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

/// The result of a standing push: the facts to send, and the watermark to
/// pass to `standing_checkpoint` once they're actually sent (security review
/// S10 — see [`standing_diff`]).
#[derive(Debug, Clone, serde::Serialize)]
pub struct StandingDiffResult {
    pub facts: Vec<Fact>,
    pub max_seq: u64,
}

/// `standing_diff(grant_id, agent_fingerprint, since_seq?) -> Option<StandingDiffResult>`
/// (§7). `None` when the grant is revoked, has no standing, its standing has
/// expired (R13), or `agent_fingerprint` doesn't match the grant's (security
/// review B3); otherwise every accepted field under an `auto` selector whose
/// node was written after `since_seq`.
///
/// `agent_fingerprint` is required, not optional (decided while building):
/// `evaluate`/`release` already refuse a rotated key via `grant_is_valid_for`,
/// but nothing stopped a standing push from being computed and sent to
/// whatever key the caller happened to encrypt for, forever, even after the
/// agent's key rotated out from under the grant. Making the parameter
/// required (rather than defaulting it) means a caller cannot forget to
/// resolve and pass the agent's *current* fingerprint the way the on-demand
/// path already does.
///
/// `since_seq: None` (decided while building, persisted checkpoint) defaults
/// to [`Store::default_since_seq`] — the grant's last `standing_checkpoint`,
/// or its own creation seq if it has never been checkpointed — so a caller
/// no longer has to track the watermark itself between calls, and that
/// watermark survives a reload since it's a `system`-compartment record.
///
/// `max_seq` (security review S10) is the highest seq actually represented
/// in `facts` — not the store's global seq counter, which can have moved on
/// by the time a caller gets around to acking a network round trip later,
/// silently marking a write that raced the ack as already pushed when it was
/// never sent. When `facts` is empty, `max_seq` is the `since_seq` baseline
/// that was used, so it is always safe to pass straight to
/// `standing_checkpoint` — including as a no-op when nothing changed.
pub fn standing_diff(
    store: &Store,
    grant_id: &str,
    agent_fingerprint: &str,
    since_seq: Option<u64>,
    now: u64,
) -> Option<StandingDiffResult> {
    let grant = store.find_grant(grant_id)?;
    if grant.revoked.is_some() || grant.agent_fingerprint != agent_fingerprint {
        return None;
    }
    let standing = grant.standing.as_ref()?;
    if standing.expires_at < now {
        return None;
    }
    let since_seq = since_seq.unwrap_or_else(|| store.default_since_seq(grant_id));

    let auto_selectors: Vec<Selector> = grant
        .rules
        .iter()
        .filter(|r| r.mode == GrantMode::Auto)
        .filter_map(|r| Selector::parse(&r.selector))
        .collect();

    let mut facts = Vec::new();
    let mut max_seq = since_seq;
    for node in store.accepted_nodes() {
        if store.is_destroyed(&node.compartment) {
            continue;
        }
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
                max_seq = max_seq.max(seq);
            }
        }
    }
    Some(StandingDiffResult { facts, max_seq })
}
