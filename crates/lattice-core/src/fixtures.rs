//! Perf-test fixture: builds many nodes spread across compartments. Gated
//! behind the `fixtures` feature (on by default) so `api::call("build_fixture", ...)`
//! works from the browser too (see DESIGN.md §10 / the perf gate).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::model::{Author, PutNodeInput};
use crate::schema::{self, FieldKind, TypeDef};
use crate::store::Store;
use crate::Env;

fn value_for_kind(kind: FieldKind, i: usize) -> Value {
    match kind {
        FieldKind::Text => Value::String(format!("value-{i}")),
        FieldKind::Number => Value::from(i as f64),
        FieldKind::Bool => Value::Bool(i.is_multiple_of(2)),
        FieldKind::Date => Value::String("2026-01-01".to_string()),
        FieldKind::Enum(values) => Value::String(values[i % values.len()].to_string()),
        FieldKind::EnumList(values) => {
            Value::Array(vec![Value::String(values[i % values.len()].to_string())])
        }
    }
}

fn fields_for(type_def: &TypeDef, i: usize) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::new();
    fields.insert(
        "name".to_string(),
        Value::String(format!("{} {i}", type_def.name)),
    );
    for field in type_def.fields.iter().filter(|f| f.required) {
        fields.insert(field.name.to_string(), value_for_kind(field.kind, i));
    }
    fields
}

/// Write `count` nodes into `store`, cycling through every top-level type
/// (one per non-system compartment or more) so the nodes spread across
/// compartments. All authored as `you`, so every write lands accepted
/// immediately — the perf gate is about opening the store, not proposals.
/// Decision: only top-level (parentless) types are used, which already
/// covers every non-system compartment without the added complexity of
/// building parent chains for thousands of nested nodes (see DESIGN.md).
pub fn populate(store: &mut Store, count: usize) {
    let top_level: Vec<&'static TypeDef> = schema::TYPES
        .iter()
        .filter(|t| t.parent.is_none())
        .collect();
    assert!(
        !top_level.is_empty(),
        "schema must have at least one top-level type"
    );

    for i in 0..count {
        let type_def = top_level[i % top_level.len()];
        let input = PutNodeInput {
            id: None,
            type_: type_def.name.to_string(),
            parent: None,
            fields: fields_for(type_def, i),
            author: Author::you(),
        };
        store
            .put_node(input)
            .expect("fixture writes are always schema-valid");
    }
}

/// Build a fresh [`Store`] with 5,000 nodes across compartments, as used by
/// the `perf_fixture_5000` test.
pub fn build_5000(env: Env) -> Store {
    let mut store = Store::new(env);
    populate(&mut store, 5000);
    store
}
