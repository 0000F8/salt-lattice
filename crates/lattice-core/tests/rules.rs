//! One failing-then-passing test per rule in `docs/DESIGN.md` §2-§7
//! (R1-R14), plus a store round trip, an idempotent-open check and the
//! 5,000-node perf fixture (§10).

use std::collections::BTreeMap;

use lattice_core::access::{self, Selector};
use lattice_core::model::*;
use lattice_core::query::{self, Direction, QueryInput, TraverseInput};
use lattice_core::store::Store;
use lattice_core::{api, fixtures, schema, Env};

fn env() -> Env {
    Env::fixed(1_726_000_000_000, 12345)
}

fn fields(pairs: &[(&str, serde_json::Value)]) -> BTreeMap<String, serde_json::Value> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

fn you() -> Author {
    Author::you()
}

fn agent(fingerprint: &str) -> Author {
    Author {
        kind: AuthorKind::Agent,
        fingerprint: Some(fingerprint.to_string()),
    }
}

fn ion() -> Author {
    Author {
        kind: AuthorKind::Ion,
        fingerprint: None,
    }
}

fn put(store: &mut Store, type_: &str, parent: Option<&str>, name: &str, author: Author) -> Node {
    store
        .put_node(PutNodeInput {
            id: None,
            type_: type_.to_string(),
            parent: parent.map(|p| p.to_string()),
            fields: fields(&[("name", serde_json::json!(name))]),
            author,
        })
        .expect("valid write")
}

// --------------------------------------------------------------------- R1

#[test]
fn r1_closed_schema() {
    let mut store = Store::new(env());

    let err = store
        .put_node(PutNodeInput {
            id: None,
            type_: "nonsense.type".to_string(),
            parent: None,
            fields: fields(&[("name", serde_json::json!("x"))]),
            author: you(),
        })
        .unwrap_err();
    assert_eq!(err.code, "unknown_type");

    let food = put(&mut store, "preferences.food", None, "Food", you());
    let err2 = store
        .put_node(PutNodeInput {
            id: None,
            type_: "preferences.food.dish".to_string(),
            parent: Some(food.id.clone()),
            fields: fields(&[
                ("name", serde_json::json!("Ramen")),
                ("private_key", serde_json::json!("nope")),
            ]),
            author: you(),
        })
        .unwrap_err();
    assert_eq!(err2.code, "unknown_field");

    // An agent has no way to register a new type: there is no such op.
    let resp = api::call(&mut store, "define_type", "{}");
    let parsed: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(parsed["error"]["code"], "unknown_op");
}

// --------------------------------------------------------------------- R2

#[test]
fn r2_versions_kept() {
    let mut store = Store::new(env());
    let node = put(&mut store, "identity.person", None, "Ada", you());

    for i in 1..=2 {
        store
            .put_node(PutNodeInput {
                id: Some(node.id.clone()),
                type_: "identity.person".to_string(),
                parent: None,
                fields: fields(&[("name", serde_json::json!(format!("Ada v{i}")))]),
                author: you(),
            })
            .unwrap();
    }

    let versions = store.versions(&node.id).unwrap();
    assert_eq!(versions.len(), 3);
    let current = store.get_node(&node.id).unwrap();
    assert_eq!(current.version, 3);
    match versions.last().unwrap() {
        VersionEntry::Node(n) => assert_eq!(n.fields["name"], serde_json::json!("Ada v2")),
        _ => panic!("expected a node version"),
    }
}

// --------------------------------------------------------------------- R3

#[test]
fn r3_proposals() {
    let mut store = Store::new(env());

    // Untrusted agent write lands pending.
    let n1 = put(
        &mut store,
        "preferences.music",
        None,
        "Music",
        agent("fp-untrusted"),
    );
    assert_eq!(n1.status, Status::Pending);

    // Trusted-write agent write lands accepted.
    store
        .set_grant(
            "agent-1".to_string(),
            "fp-trusted".to_string(),
            vec![],
            vec!["preferences".to_string()],
            None,
        )
        .unwrap();
    let n2 = put(
        &mut store,
        "preferences.music",
        None,
        "Music2",
        agent("fp-trusted"),
    );
    assert_eq!(n2.status, Status::Accepted);

    // You always lands accepted.
    let n3 = put(&mut store, "preferences.music", None, "Music3", you());
    assert_eq!(n3.status, Status::Accepted);

    // Ion always lands pending, even with a matching trusted-write grant.
    let n4 = put(&mut store, "preferences.music", None, "Music4", ion());
    assert_eq!(n4.status, Status::Pending);

    store.accept(&n1.id).unwrap();
    assert_eq!(store.get_node(&n1.id).unwrap().status, Status::Accepted);
    store.reject(&n4.id).unwrap();
    assert_eq!(store.get_node(&n4.id).unwrap().status, Status::Rejected);
}

// --------------------------------------------------------------------- R4

#[test]
fn r4_pending_never_released() {
    let mut store = Store::new(env());
    let pending = put(
        &mut store,
        "preferences.music",
        None,
        "Secret Genre",
        agent("fp-x"),
    );
    assert_eq!(pending.status, Status::Pending);

    let found = query::query(
        &store,
        &QueryInput {
            path: "preferences/music".to_string(),
            filters: vec![],
            status: None,
            limit: None,
        },
    )
    .unwrap();
    assert!(found.iter().all(|n| n.id != pending.id));

    store
        .set_grant(
            "agent-y".to_string(),
            "fp-x".to_string(),
            vec![GrantRule {
                selector: "preferences.music.name".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            None,
        )
        .unwrap();
    let request = Request {
        id: "r_1".to_string(),
        agent_id: "agent-y".to_string(),
        agent_fingerprint: "fp-x".to_string(),
        purpose: "test".to_string(),
        asks: vec!["preferences.music.name".to_string()],
        channel: Channel::Private,
    };
    let evaluation = access::evaluate(&store, &request).unwrap();
    assert!(evaluation.auto.is_empty());
    assert_eq!(evaluation.omitted, 0); // never asked about because it's not accepted
}

// --------------------------------------------------------------------- R5

#[test]
fn r5_no_grant_is_indistinguishable_from_no_match() {
    let mut store = Store::new(env());
    put(&mut store, "preferences.food", None, "Food", you());

    let request_no_grant = Request {
        id: "r_shared".to_string(),
        agent_id: "agent-none".to_string(),
        agent_fingerprint: "fp-none".to_string(),
        purpose: "p".to_string(),
        asks: vec!["preferences.food.name".to_string()],
        channel: Channel::Private,
    };
    let eval_no_grant = access::evaluate(&store, &request_no_grant).unwrap();
    assert!(eval_no_grant.auto.is_empty() && eval_no_grant.ask.is_empty());

    // A valid grant whose selector matches no data at all.
    store
        .set_grant(
            "agent-none".to_string(),
            "fp-none".to_string(),
            vec![GrantRule {
                selector: "health.condition.name".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            None,
        )
        .unwrap();
    let eval_valid_no_match = access::evaluate(&store, &request_no_grant).unwrap();
    assert!(eval_valid_no_match.auto.is_empty() && eval_valid_no_match.ask.is_empty());

    let (payload_a, _) = access::release(
        &mut store,
        &request_no_grant,
        eval_no_grant.auto.clone(),
        DisclosureKind::OnDemand,
    )
    .unwrap();
    let (payload_b, _) = access::release(
        &mut store,
        &request_no_grant,
        eval_valid_no_match.auto.clone(),
        DisclosureKind::OnDemand,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&payload_a).unwrap(),
        serde_json::to_string(&payload_b).unwrap()
    );

    // Revoked grant and fingerprint mismatch behave the same way.
    store
        .set_grant(
            "agent-rev".to_string(),
            "fp-rev".to_string(),
            vec![GrantRule {
                selector: "preferences.food.name".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            None,
        )
        .unwrap();
    let grants = store.list_grants();
    let revoked_id = grants
        .iter()
        .find(|g| g.agent_id == "agent-rev")
        .unwrap()
        .id
        .clone();
    store.revoke_grant(&revoked_id).unwrap();
    let request_revoked = Request {
        id: "r2".to_string(),
        agent_id: "agent-rev".to_string(),
        agent_fingerprint: "fp-rev".to_string(),
        purpose: "p".to_string(),
        asks: vec!["preferences.food.name".to_string()],
        channel: Channel::Private,
    };
    let eval_revoked = access::evaluate(&store, &request_revoked).unwrap();
    assert!(eval_revoked.auto.is_empty() && eval_revoked.ask.is_empty());

    store
        .set_grant(
            "agent-fp".to_string(),
            "fp-real".to_string(),
            vec![GrantRule {
                selector: "preferences.food.name".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            None,
        )
        .unwrap();
    let request_wrong_fp = Request {
        id: "r3".to_string(),
        agent_id: "agent-fp".to_string(),
        agent_fingerprint: "fp-different".to_string(),
        purpose: "p".to_string(),
        asks: vec!["preferences.food.name".to_string()],
        channel: Channel::Private,
    };
    let eval_wrong_fp = access::evaluate(&store, &request_wrong_fp).unwrap();
    assert!(eval_wrong_fp.auto.is_empty() && eval_wrong_fp.ask.is_empty());
}

// --------------------------------------------------------------------- R6

#[test]
fn r6_group_channel_refused() {
    let store = Store::new(env());
    let request = Request {
        id: "r_1".to_string(),
        agent_id: "agent-1".to_string(),
        agent_fingerprint: "fp-1".to_string(),
        purpose: "p".to_string(),
        asks: vec!["preferences.food.name".to_string()],
        channel: Channel::Group,
    };
    let err = access::evaluate(&store, &request).unwrap_err();
    assert_eq!(err.code, "group_channel");
}

// --------------------------------------------------------------------- R7

#[test]
fn r7_author_masked_on_release() {
    let mut store = Store::new(env());
    store
        .set_grant(
            "agent-a".to_string(),
            "fp-a".to_string(),
            vec![],
            vec!["relationships".to_string()],
            None,
        )
        .unwrap();
    let node = put(&mut store, "relationships.pet", None, "Fido", agent("fp-a"));
    assert_eq!(
        node.status,
        Status::Accepted,
        "agent-a is trusted for relationships"
    );
    assert_eq!(node.author.kind, AuthorKind::Agent);

    store
        .set_grant(
            "agent-b".to_string(),
            "fp-b".to_string(),
            vec![GrantRule {
                selector: "relationships.pet.name".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            None,
        )
        .unwrap();
    let request = Request {
        id: "r_1".to_string(),
        agent_id: "agent-b".to_string(),
        agent_fingerprint: "fp-b".to_string(),
        purpose: "p".to_string(),
        asks: vec!["relationships.pet.name".to_string()],
        channel: Channel::Private,
    };
    let evaluation = access::evaluate(&store, &request).unwrap();
    assert_eq!(evaluation.auto.len(), 1);
    assert_eq!(evaluation.auto[0].author, FactAuthor::Agent);
    let serialized = serde_json::to_string(&evaluation.auto[0]).unwrap();
    assert!(
        !serialized.contains("fp-a"),
        "fingerprint of the writing agent must never leak"
    );
}

// --------------------------------------------------------------------- R8

#[test]
fn r8_grant_cannot_name_system() {
    let mut store = Store::new(env());
    let err = store
        .set_grant(
            "agent-1".to_string(),
            "fp-1".to_string(),
            vec![GrantRule {
                selector: "system.*".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            None,
        )
        .unwrap_err();
    assert_eq!(err.code, "grant_names_system");
}

// --------------------------------------------------------------------- R9

#[test]
fn r9_ask_never_in_auto_and_partial_approval_releases_exactly_that() {
    let mut store = Store::new(env());
    store
        .put_node(PutNodeInput {
            id: None,
            type_: "identity.person".to_string(),
            parent: None,
            fields: fields(&[
                ("name", serde_json::json!("Ada")),
                ("birthday", serde_json::json!("1990-01-01")),
            ]),
            author: you(),
        })
        .unwrap();

    store
        .set_grant(
            "agent-1".to_string(),
            "fp-1".to_string(),
            vec![
                GrantRule {
                    selector: "identity.person.name".to_string(),
                    mode: GrantMode::Auto,
                },
                GrantRule {
                    selector: "identity.person.birthday".to_string(),
                    mode: GrantMode::Ask,
                },
            ],
            vec![],
            None,
        )
        .unwrap();

    let request = Request {
        id: "r_1".to_string(),
        agent_id: "agent-1".to_string(),
        agent_fingerprint: "fp-1".to_string(),
        purpose: "p".to_string(),
        asks: vec![
            "identity.person.name".to_string(),
            "identity.person.birthday".to_string(),
        ],
        channel: Channel::Private,
    };
    let evaluation = access::evaluate(&store, &request).unwrap();
    assert_eq!(evaluation.auto.len(), 1);
    assert_eq!(evaluation.auto[0].field, "name");
    assert_eq!(evaluation.ask.len(), 1);
    assert_eq!(evaluation.ask[0].field, "birthday");
    assert!(evaluation.ask.iter().all(|item| item.field != "name"));

    let approved_fact = access::consent_item_to_fact(&store, &evaluation.ask[0]).unwrap();
    let mut facts = evaluation.auto.clone();
    facts.push(approved_fact);
    let (payload, _) =
        access::release(&mut store, &request, facts, DisclosureKind::OnDemand).unwrap();
    assert_eq!(payload.facts.len(), 2);
    assert!(payload.facts.iter().any(|f| f.field == "birthday"));
}

// -------------------------------------------------------------------- R10

#[test]
fn r10_grant_rules_change_is_a_new_version() {
    let mut store = Store::new(env());
    let g1 = store
        .set_grant(
            "agent-1".to_string(),
            "fp-1".to_string(),
            vec![],
            vec![],
            None,
        )
        .unwrap();
    let g2 = store
        .set_grant(
            "agent-1".to_string(),
            "fp-1".to_string(),
            vec![GrantRule {
                selector: "preferences.*".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            None,
        )
        .unwrap();
    assert_ne!(g1.id, g2.id);

    let current = store.list_grants();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].id, g2.id);

    let history = store.all_grants_including_revoked();
    assert_eq!(history.len(), 2);
    let old = history.iter().find(|g| g.id == g1.id).unwrap();
    assert!(
        old.revoked.is_some(),
        "the superseded grant stays in the log, marked revoked"
    );
}

// -------------------------------------------------------------------- R11

#[test]
fn r11_destroy_compartment() {
    let mut store = Store::new(env());
    put(&mut store, "preferences.food", None, "Food", you());
    put(&mut store, "preferences.music", None, "Music", you());
    put(&mut store, "health.condition", None, "Condition", you());

    store.destroy_compartment("preferences");

    let remaining = query::query(
        &store,
        &QueryInput {
            path: "preferences/*".to_string(),
            filters: vec![],
            status: Some("all".to_string()),
            limit: None,
        },
    )
    .unwrap();
    assert!(remaining.is_empty());

    let health_still_there = query::query(
        &store,
        &QueryInput {
            path: "health/*".to_string(),
            filters: vec![],
            status: None,
            limit: None,
        },
    )
    .unwrap();
    assert_eq!(health_still_there.len(), 1);
}

// -------------------------------------------------------------------- R12

#[test]
fn r12_every_release_writes_exactly_one_disclosure() {
    let mut store = Store::new(env());
    let node = put(&mut store, "preferences.food", None, "Sushi", you());
    store
        .set_grant(
            "agent-1".to_string(),
            "fp-1".to_string(),
            vec![GrantRule {
                selector: "preferences.food.name".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            None,
        )
        .unwrap();
    let request = Request {
        id: "r_1".to_string(),
        agent_id: "agent-1".to_string(),
        agent_fingerprint: "fp-1".to_string(),
        purpose: "p".to_string(),
        asks: vec!["preferences.food.name".to_string()],
        channel: Channel::Private,
    };

    assert_eq!(store.disclosure_log(None, 100, None).len(), 0);
    let evaluation = access::evaluate(&store, &request).unwrap();
    access::release(
        &mut store,
        &request,
        evaluation.auto.clone(),
        DisclosureKind::OnDemand,
    )
    .unwrap();
    assert_eq!(store.disclosure_log(None, 100, None).len(), 1);

    let request2 = Request {
        id: "r_2".to_string(),
        ..request.clone()
    };
    access::release(&mut store, &request2, vec![], DisclosureKind::OnDemand).unwrap();
    let all = store.disclosure_log(None, 100, None);
    assert_eq!(all.len(), 2);
    // newest first
    assert_eq!(all[0].request_id, "r_2");
    assert_eq!(all[1].request_id, "r_1");

    let scoped = store.disclosure_log(Some("agent-1"), 100, None);
    assert_eq!(scoped.len(), 2);
    let _ = node;
}

// -------------------------------------------------------------------- R13

#[test]
fn r13_expired_standing_only_affects_standing_diff() {
    let mut store = Store::new(env());
    let now = store.now();
    put(&mut store, "preferences.food", None, "Sushi", you());

    let grant = store
        .set_grant(
            "agent-1".to_string(),
            "fp-1".to_string(),
            vec![GrantRule {
                selector: "preferences.food.name".to_string(),
                mode: GrantMode::Auto,
            }],
            vec![],
            Some(Standing {
                expires_at: now.saturating_sub(1),
            }),
        )
        .unwrap();

    let now2 = store.now();
    assert!(access::standing_diff(&store, &grant.id, 0, now2).is_none());

    let request = Request {
        id: "r_1".to_string(),
        agent_id: "agent-1".to_string(),
        agent_fingerprint: "fp-1".to_string(),
        purpose: "p".to_string(),
        asks: vec!["preferences.food.name".to_string()],
        channel: Channel::Private,
    };
    let evaluation = access::evaluate(&store, &request).unwrap();
    assert_eq!(
        evaluation.auto.len(),
        1,
        "evaluate still works on demand despite expired standing"
    );
}

// -------------------------------------------------------------------- R14

#[test]
fn r14_no_secret_types() {
    let banned = [
        "private_key",
        "privatekey",
        "private key",
        "seed",
        "mnemonic",
        "password",
        "account_number",
        "account number",
        "card",
    ];
    let check = |s: &str, context: &str| {
        let lower = s.to_lowercase();
        for word in banned {
            assert!(
                !lower.contains(word),
                "'{s}' ({context}) looks like a secret-holding name (matched '{word}')"
            );
        }
    };

    for type_def in schema::TYPES {
        check(type_def.name, "type name");
        for field in type_def.fields {
            check(field.name, "field name");
            if let Some(values) = field.kind.allowed_values() {
                for v in values {
                    check(v, "enum value");
                }
            }
        }
    }
    for link in schema::LINKS {
        check(link.name, "link name");
    }
}

// -------------------------------------------------------------- extra tests

#[test]
fn store_roundtrip() {
    let mut store = Store::new(env());
    let food = put(&mut store, "preferences.food", None, "Food", you());
    put(
        &mut store,
        "preferences.food.cuisine",
        Some(&food.id),
        "Japanese",
        you(),
    );
    put(&mut store, "health.condition", None, "Allergy", you());

    let mut frames = Vec::new();
    for compartment in ["preferences", "health"] {
        frames.push((compartment.to_string(), store.take_frame(compartment)));
    }

    let before = query::query(
        &store,
        &QueryInput {
            path: "preferences/*".to_string(),
            filters: vec![],
            status: None,
            limit: None,
        },
    )
    .unwrap();

    let mut reloaded = Store::new(env());
    for (compartment, bytes) in &frames {
        reloaded.load_frame(compartment, bytes).unwrap();
    }
    reloaded.finish_open();

    let after = query::query(
        &reloaded,
        &QueryInput {
            path: "preferences/*".to_string(),
            filters: vec![],
            status: None,
            limit: None,
        },
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&before).unwrap(),
        serde_json::to_string(&after).unwrap()
    );
    assert_eq!(reloaded.versions(&food.id).unwrap().len(), 1);
}

#[test]
fn open_idempotent() {
    let mut store = Store::new(env());
    put(&mut store, "preferences.food", None, "Food", you());
    let bytes = store.take_frame("preferences");

    let mut reloaded = Store::new(env());
    reloaded.load_frame("preferences", &bytes).unwrap();
    reloaded.finish_open();
    reloaded.load_frame("preferences", &bytes).unwrap(); // same frame again
    reloaded.finish_open();

    let nodes = query::query(
        &reloaded,
        &QueryInput {
            path: "preferences/*".to_string(),
            filters: vec![],
            status: None,
            limit: None,
        },
    )
    .unwrap();
    assert_eq!(
        nodes.len(),
        1,
        "re-loading the same frame must not duplicate a node"
    );
    assert_eq!(reloaded.versions(&nodes[0].id).unwrap().len(), 1);
}

#[test]
fn perf_fixture_5000() {
    let built = fixtures::build_5000(env());

    let mut frames = Vec::new();
    for compartment in [
        "identity",
        "health",
        "finances",
        "preferences",
        "relationships",
        "schedule",
        "work",
    ] {
        let bytes = built.compact(compartment);
        if !bytes.is_empty() {
            frames.push((compartment.to_string(), bytes));
        }
    }

    let mut reloaded = Store::new(env());
    let start = std::time::Instant::now();
    for (compartment, bytes) in &frames {
        reloaded.load_frame(compartment, bytes).unwrap();
    }
    reloaded.finish_open();
    let elapsed = start.elapsed();
    println!("perf_fixture_5000: reloaded in {elapsed:?}");

    let total: usize = reloaded
        .stats()
        .compartments
        .values()
        .map(|c| c.nodes)
        .sum();
    assert_eq!(total, 5000);
}

// ------------------------------------------------------- selector parsing

#[test]
fn selector_specificity_and_system_guard() {
    assert!(matches!(
        Selector::parse("preferences.*"),
        Some(Selector::Compartment(_))
    ));
    assert!(matches!(
        Selector::parse("preferences.food.*"),
        Some(Selector::Type(_))
    ));
    assert!(matches!(
        Selector::parse("preferences.food.name"),
        Some(Selector::Field(_, _))
    ));
    assert!(Selector::parse("not.a.real.type").is_none());
    assert_eq!(
        Selector::parse("system.*").unwrap().compartment_name(),
        "system"
    );
}

#[test]
fn api_call_roundtrip_via_json() {
    let mut store = Store::new(env());
    let resp = api::call(
        &mut store,
        "put_node",
        r#"{"type":"identity.person","fields":{"name":"Ada"},"author":{"kind":"you"}}"#,
    );
    let parsed: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(parsed["ok"]["fields"]["name"], "Ada");
    assert_eq!(parsed["ok"]["status"], "accepted");

    let bad = api::call(
        &mut store,
        "put_node",
        r#"{"type":"nope.nope","fields":{},"author":{"kind":"you"}}"#,
    );
    let parsed_bad: serde_json::Value = serde_json::from_str(&bad).unwrap();
    assert_eq!(parsed_bad["error"]["code"], "unknown_type");
}

#[test]
fn traverse_and_search_basics() {
    let mut store = Store::new(env());
    let ada = put(&mut store, "identity.person", None, "Ada", you());
    let event = store
        .put_node(PutNodeInput {
            id: None,
            type_: "schedule.event".to_string(),
            parent: None,
            fields: fields(&[("name", serde_json::json!("Launch Party"))]),
            author: you(),
        })
        .unwrap();
    store
        .put_link(PutLinkInput {
            type_: "attends".to_string(),
            from: ada.id.clone(),
            to: event.id.clone(),
            author: you(),
        })
        .unwrap();

    let result = query::traverse(
        &store,
        &TraverseInput {
            from: ada.id.clone(),
            link_types: None,
            depth: 1,
            direction: Direction::Out,
        },
    )
    .unwrap();
    assert_eq!(result.nodes.len(), 1);
    assert_eq!(result.nodes[0].id, event.id);

    let found = query::search(&store, "launch", 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, event.id);
}
