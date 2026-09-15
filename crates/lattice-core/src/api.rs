//! The single JSON-in/JSON-out dispatcher (`docs/DESIGN.md` §8) the wasm
//! wrapper (and these tests) call every op through. `loadFrame`/`finishOpen`/
//! `takeFrame`/`pendingCompartments`/`compact` are direct [`Store`] methods,
//! not ops here — they move raw bytes, which don't round-trip through JSON
//! cleanly, and §8 lists them as separate wasm-bindgen methods anyway.

use serde::{Deserialize, Serialize};

use crate::access;
use crate::error::Error;
use crate::model::*;
use crate::query::{self, QueryInput, TraverseInput};
use crate::store::Store;
use crate::LatticeResult;

#[derive(Debug, Deserialize)]
struct IdArgs {
    id: String,
}

#[derive(Debug, Deserialize)]
struct SearchArgs {
    text: String,
    #[serde(default = "default_search_limit")]
    limit: usize,
}
fn default_search_limit() -> usize {
    20
}

#[derive(Debug, Deserialize)]
struct SetGrantArgs {
    agent_id: String,
    agent_fingerprint: String,
    rules: Vec<GrantRule>,
    #[serde(default)]
    trusted_writes: Vec<String>,
    #[serde(default)]
    standing: Option<Standing>,
}

#[derive(Debug, Deserialize)]
struct RevokeGrantArgs {
    grant_id: String,
}

#[derive(Debug, Deserialize)]
struct EvaluateArgs {
    request: Request,
}

#[derive(Debug, Deserialize)]
struct ReleaseArgs {
    request: Request,
    facts: Vec<Fact>,
    #[serde(default = "default_disclosure_kind")]
    kind: DisclosureKind,
}
fn default_disclosure_kind() -> DisclosureKind {
    DisclosureKind::OnDemand
}

#[derive(Debug, Deserialize)]
struct StandingDiffArgs {
    grant_id: String,
    /// Required (security review B3): the caller must resolve and pass the
    /// agent's *current* key fingerprint, the same way it already does for
    /// `evaluate`/`release`. Not defaulted or made optional on purpose — a
    /// missing value is a `bad_request` parse error, not a silent bypass.
    agent_fingerprint: String,
    /// Optional (decided while building): omit or pass `null` to default to
    /// the grant's persisted checkpoint, or its creation seq if none exists
    /// yet — see `access::standing_diff`.
    #[serde(default)]
    since_seq: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct StandingCheckpointArgs {
    grant_id: String,
    seq: u64,
}

#[derive(Debug, Deserialize)]
struct DisclosureLogArgs {
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default = "default_disclosure_limit")]
    limit: usize,
    #[serde(default)]
    before: Option<String>,
}
fn default_disclosure_limit() -> usize {
    50
}

#[derive(Debug, Deserialize)]
struct DestroyCompartmentArgs {
    compartment: String,
}

#[derive(Debug, Deserialize)]
struct BuildFixtureArgs {
    #[serde(default = "default_fixture_count")]
    count: usize,
}
fn default_fixture_count() -> usize {
    5000
}

fn parse_args<T: serde::de::DeserializeOwned>(args: &str) -> LatticeResult<T> {
    serde_json::from_str(args).map_err(|e| Error::new("bad_request", format!("bad args: {e}")))
}

fn to_value<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).expect("every result type here serializes")
}

fn dispatch(store: &mut Store, op: &str, args: &str) -> LatticeResult<serde_json::Value> {
    match op {
        "schema" => {
            Ok(serde_json::from_str(&crate::schema::schema_json())
                .expect("schema_json always parses"))
        }
        "stats" => Ok(to_value(&store.stats())),

        "put_node" => {
            let input: PutNodeInput = parse_args(args)?;
            Ok(to_value(&store.put_node(input)?))
        }
        "put_link" => {
            let input: PutLinkInput = parse_args(args)?;
            Ok(to_value(&store.put_link(input)?))
        }
        "accept" => {
            let a: IdArgs = parse_args(args)?;
            store.accept(&a.id)?;
            Ok(serde_json::json!({ "id": a.id }))
        }
        "reject" => {
            let a: IdArgs = parse_args(args)?;
            store.reject(&a.id)?;
            Ok(serde_json::json!({ "id": a.id }))
        }
        "delete_node" => {
            let a: IdArgs = parse_args(args)?;
            store.delete_node(&a.id)?;
            Ok(serde_json::json!({ "id": a.id }))
        }
        "delete_link" => {
            let a: IdArgs = parse_args(args)?;
            store.delete_link(&a.id)?;
            Ok(serde_json::json!({ "id": a.id }))
        }
        "versions" => {
            let a: IdArgs = parse_args(args)?;
            Ok(to_value(&store.versions(&a.id)?))
        }

        "query" => {
            let input: QueryInput = parse_args(args)?;
            Ok(to_value(&query::query(store, &input)?))
        }
        "traverse" => {
            let input: TraverseInput = parse_args(args)?;
            Ok(to_value(&query::traverse(store, &input)?))
        }
        "search" => {
            let a: SearchArgs = parse_args(args)?;
            Ok(to_value(&query::search(store, &a.text, a.limit)))
        }

        "set_grant" => {
            let a: SetGrantArgs = parse_args(args)?;
            let grant = store.set_grant(
                a.agent_id,
                a.agent_fingerprint,
                a.rules,
                a.trusted_writes,
                a.standing,
            )?;
            Ok(to_value(&grant))
        }
        "revoke_grant" => {
            let a: RevokeGrantArgs = parse_args(args)?;
            store.revoke_grant(&a.grant_id)?;
            Ok(serde_json::json!({ "grant_id": a.grant_id }))
        }
        "list_grants" => Ok(to_value(&store.list_grants())),

        "evaluate" => {
            let a: EvaluateArgs = parse_args(args)?;
            Ok(to_value(&access::evaluate(store, &a.request)?))
        }
        "release" => {
            let a: ReleaseArgs = parse_args(args)?;
            let (payload, entry) = access::release(store, &a.request, a.facts, a.kind)?;
            Ok(serde_json::json!({ "payload": payload, "disclosure": entry }))
        }
        "consent_to_fact" => {
            let item: ConsentItem = parse_args(args)?;
            Ok(to_value(&access::consent_item_to_fact(store, &item)?))
        }
        "standing_diff" => {
            let a: StandingDiffArgs = parse_args(args)?;
            let now = store.now();
            Ok(to_value(&access::standing_diff(
                store,
                &a.grant_id,
                &a.agent_fingerprint,
                a.since_seq,
                now,
            )))
        }
        "standing_checkpoint" => {
            let a: StandingCheckpointArgs = parse_args(args)?;
            store.set_standing_checkpoint(&a.grant_id, a.seq)?;
            Ok(serde_json::json!({ "grant_id": a.grant_id, "seq": a.seq }))
        }
        "disclosure_log" => {
            let a: DisclosureLogArgs = parse_args(args)?;
            Ok(to_value(&store.disclosure_log(
                a.agent_id.as_deref(),
                a.limit,
                a.before.as_deref(),
            )))
        }

        "destroy_compartment" => {
            let a: DestroyCompartmentArgs = parse_args(args)?;
            store.destroy_compartment(&a.compartment);
            Ok(serde_json::json!({ "compartment": a.compartment }))
        }

        #[cfg(feature = "fixtures")]
        "build_fixture" => {
            let a: BuildFixtureArgs = parse_args(args)?;
            crate::fixtures::populate(store, a.count);
            Ok(serde_json::json!({ "built": a.count }))
        }

        _ => Err(Error::new("unknown_op", format!("no such op: {op}"))),
    }
}

/// `call(op, argsJson) -> resultJson`: `{"ok": ...}` on success,
/// `{"error": {"code", "message"}}` on failure. Never panics on caller
/// input — every failure path here is a typed [`Error`], not an unwrap.
pub fn call(store: &mut Store, op: &str, args: &str) -> String {
    match dispatch(store, op, args) {
        Ok(value) => serde_json::json!({ "ok": value }).to_string(),
        Err(e) => {
            serde_json::json!({ "error": { "code": e.code, "message": e.message } }).to_string()
        }
    }
}
