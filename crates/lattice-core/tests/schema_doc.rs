//! `docs/SCHEMA.md` is a rendering of the schema in `src/schema.rs`. This
//! test fails when the committed file drifts from the crate. Regenerate it
//! with:
//!
//! ```text
//! UPDATE_SCHEMA_DOC=1 cargo test -p lattice-core schema_doc_is_fresh
//! ```

use std::fmt::Write as _;

use lattice_core::schema::{self, Compartment, FieldKind, COMPARTMENTS, LINKS, TYPES};

fn field_kind_label(kind: FieldKind) -> String {
    match kind {
        FieldKind::Text => "text".to_string(),
        FieldKind::Number => "number".to_string(),
        FieldKind::Bool => "bool".to_string(),
        FieldKind::Date => "date".to_string(),
        FieldKind::Enum(values) => format!("enum({})", values.join("\\|")),
        FieldKind::EnumList(values) => format!("enum_list({})", values.join("\\|")),
    }
}

fn render() -> String {
    let mut out = String::new();
    writeln!(out, "# Lattice schema").unwrap();
    writeln!(out).unwrap();
    writeln!(
        out,
        "Generated from `crates/lattice-core/src/schema.rs` by the `schema_doc_is_fresh` test. Do not hand-edit; run:"
    )
    .unwrap();
    writeln!(out).unwrap();
    writeln!(out, "```text").unwrap();
    writeln!(
        out,
        "UPDATE_SCHEMA_DOC=1 cargo test -p lattice-core schema_doc_is_fresh"
    )
    .unwrap();
    writeln!(out, "```").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "Schema version: **{}**", schema::SCHEMA_VERSION).unwrap();
    writeln!(out).unwrap();

    for compartment in COMPARTMENTS {
        if *compartment == Compartment::System {
            continue; // system never holds a fact about the person (§2)
        }
        writeln!(out, "## {}", compartment.as_str()).unwrap();
        writeln!(out).unwrap();
        writeln!(out, "| Type | Parent | Fields |").unwrap();
        writeln!(out, "| --- | --- | --- |").unwrap();
        for type_def in TYPES
            .iter()
            .filter(|t| schema::compartment_of(t.name) == Some(*compartment))
        {
            let parent = type_def.parent.unwrap_or("—");
            let mut field_strs = vec!["name: text (required)".to_string()];
            for field in type_def.fields {
                field_strs.push(format!(
                    "{}: {}{}",
                    field.name,
                    field_kind_label(field.kind),
                    if field.required { " (required)" } else { "" }
                ));
            }
            field_strs.push("note: text".to_string());
            writeln!(
                out,
                "| `{}` | {} | {} |",
                type_def.name,
                parent,
                field_strs.join("; ")
            )
            .unwrap();
        }
        writeln!(out).unwrap();
    }

    writeln!(out, "## Links").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "| Link | From | To |").unwrap();
    writeln!(out, "| --- | --- | --- |").unwrap();
    for link in LINKS {
        writeln!(
            out,
            "| `{}` | {} | {} |",
            link.name,
            link.from.join(", "),
            link.to.join(", ")
        )
        .unwrap();
    }
    writeln!(out).unwrap();

    out
}

#[test]
fn schema_doc_is_fresh() {
    let rendered = render();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/SCHEMA.md");

    if std::env::var("UPDATE_SCHEMA_DOC").as_deref() == Ok("1") {
        std::fs::write(path, &rendered).expect("failed to write docs/SCHEMA.md");
        return;
    }

    let committed = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        committed, rendered,
        "docs/SCHEMA.md is stale — regenerate with `UPDATE_SCHEMA_DOC=1 cargo test -p lattice-core schema_doc_is_fresh`"
    );
}
