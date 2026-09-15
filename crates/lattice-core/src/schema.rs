//! The closed, versioned schema (`docs/DESIGN.md` §2): compartments, node
//! types and link types. Nothing here is mutable at runtime — an agent picks
//! from this list and cannot add to it (R1).

pub const SCHEMA_VERSION: u32 = 1;

/// The closed set of compartments. `System` never holds a fact about the
/// person (no node type has `system` as its first dotted segment) and no
/// grant selector may name it (R8).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Compartment {
    Identity,
    Health,
    Finances,
    Preferences,
    Relationships,
    Schedule,
    Work,
    System,
}

pub const COMPARTMENTS: &[Compartment] = &[
    Compartment::Identity,
    Compartment::Health,
    Compartment::Finances,
    Compartment::Preferences,
    Compartment::Relationships,
    Compartment::Schedule,
    Compartment::Work,
    Compartment::System,
];

impl Compartment {
    pub fn as_str(&self) -> &'static str {
        match self {
            Compartment::Identity => "identity",
            Compartment::Health => "health",
            Compartment::Finances => "finances",
            Compartment::Preferences => "preferences",
            Compartment::Relationships => "relationships",
            Compartment::Schedule => "schedule",
            Compartment::Work => "work",
            Compartment::System => "system",
        }
    }

    pub fn parse(s: &str) -> Option<Compartment> {
        match s {
            "identity" => Some(Compartment::Identity),
            "health" => Some(Compartment::Health),
            "finances" => Some(Compartment::Finances),
            "preferences" => Some(Compartment::Preferences),
            "relationships" => Some(Compartment::Relationships),
            "schedule" => Some(Compartment::Schedule),
            "work" => Some(Compartment::Work),
            "system" => Some(Compartment::System),
            _ => None,
        }
    }
}

/// A field's shape. `EnumList` is a decided-while-building extension beyond
/// the four kinds named in DESIGN.md §2 (`text|number|bool|date|enum`), added
/// for `schedule.routine.days` — see "Decided while building" in DESIGN.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Text,
    Number,
    Bool,
    Date,
    Enum(&'static [&'static str]),
    EnumList(&'static [&'static str]),
}

impl FieldKind {
    pub fn label(&self) -> &'static str {
        match self {
            FieldKind::Text => "text",
            FieldKind::Number => "number",
            FieldKind::Bool => "bool",
            FieldKind::Date => "date",
            FieldKind::Enum(_) => "enum",
            FieldKind::EnumList(_) => "enum_list",
        }
    }

    pub fn allowed_values(&self) -> Option<&'static [&'static str]> {
        match self {
            FieldKind::Enum(v) | FieldKind::EnumList(v) => Some(v),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FieldDef {
    pub name: &'static str,
    pub kind: FieldKind,
    pub required: bool,
}

/// The implicit fields every type carries (DESIGN.md §2): `name` (required,
/// what a row is called) and `note` (optional). Not repeated in [`TYPES`].
pub const NAME_FIELD: FieldDef = FieldDef {
    name: "name",
    kind: FieldKind::Text,
    required: true,
};
pub const NOTE_FIELD: FieldDef = FieldDef {
    name: "note",
    kind: FieldKind::Text,
    required: false,
};

#[derive(Debug, Clone, Copy)]
pub struct TypeDef {
    pub name: &'static str,
    /// The type a node of this type must nest under, or `None` for a
    /// top-level type. `TYPES` distinguishes top-level (2 dotted segments,
    /// e.g. `preferences.food`) from nested (3 segments, e.g.
    /// `preferences.food.cuisine`) types purely by this field.
    pub parent: Option<&'static str>,
    /// Fields *beyond* the implicit `name`/`note` (see [`NAME_FIELD`],
    /// [`NOTE_FIELD`]).
    pub fields: &'static [FieldDef],
}

#[derive(Debug, Clone, Copy)]
pub struct LinkDef {
    pub name: &'static str,
    pub from: &'static [&'static str],
    pub to: &'static [&'static str],
}

const SEVERITY: &[&str] = &["mild", "moderate", "severe"];
const PERIOD: &[&str] = &["weekly", "monthly", "yearly"];

pub static TYPES: &[TypeDef] = &[
    // identity
    TypeDef {
        name: "identity.person",
        parent: None,
        fields: &[
            FieldDef {
                name: "birthday",
                kind: FieldKind::Date,
                required: false,
            },
            FieldDef {
                name: "pronouns",
                kind: FieldKind::Text,
                required: false,
            },
            // Decision: no free-text-list field kind exists, so a list of
            // languages is stored as one comma-separated text field.
            FieldDef {
                name: "languages",
                kind: FieldKind::Text,
                required: false,
            },
        ],
    },
    TypeDef {
        name: "identity.location",
        parent: None,
        fields: &[
            FieldDef {
                name: "kind",
                kind: FieldKind::Enum(&["home", "work", "other"]),
                required: true,
            },
            FieldDef {
                name: "city",
                kind: FieldKind::Text,
                required: false,
            },
            FieldDef {
                name: "country",
                kind: FieldKind::Text,
                required: false,
            },
        ],
    },
    TypeDef {
        name: "identity.contact_channel",
        parent: None,
        fields: &[
            FieldDef {
                name: "kind",
                kind: FieldKind::Enum(&["email", "phone", "handle"]),
                required: true,
            },
            FieldDef {
                name: "value",
                kind: FieldKind::Text,
                required: true,
            },
        ],
    },
    // preferences.food
    TypeDef {
        name: "preferences.food",
        parent: None,
        fields: &[],
    },
    TypeDef {
        name: "preferences.food.cuisine",
        parent: Some("preferences.food"),
        fields: &[FieldDef {
            name: "strength",
            kind: FieldKind::Number,
            required: false,
        }],
    },
    TypeDef {
        name: "preferences.food.dish",
        parent: Some("preferences.food"),
        fields: &[],
    },
    TypeDef {
        name: "preferences.food.restriction",
        parent: Some("preferences.food"),
        fields: &[
            FieldDef {
                name: "kind",
                kind: FieldKind::Enum(&["allergy", "diet", "dislike"]),
                required: true,
            },
            FieldDef {
                name: "severity",
                kind: FieldKind::Enum(SEVERITY),
                required: false,
            },
        ],
    },
    // preferences.music
    TypeDef {
        name: "preferences.music",
        parent: None,
        fields: &[],
    },
    TypeDef {
        name: "preferences.music.genre",
        parent: Some("preferences.music"),
        fields: &[],
    },
    TypeDef {
        name: "preferences.music.artist",
        parent: Some("preferences.music"),
        fields: &[],
    },
    // preferences.travel
    TypeDef {
        name: "preferences.travel",
        parent: None,
        fields: &[],
    },
    TypeDef {
        name: "preferences.travel.style",
        parent: Some("preferences.travel"),
        fields: &[],
    },
    TypeDef {
        name: "preferences.travel.place",
        parent: Some("preferences.travel"),
        fields: &[],
    },
    // relationships
    TypeDef {
        name: "relationships.person",
        parent: None,
        fields: &[FieldDef {
            name: "relation",
            kind: FieldKind::Enum(&["partner", "family", "friend", "colleague", "other"]),
            required: false,
        }],
    },
    TypeDef {
        name: "relationships.person.detail",
        parent: Some("relationships.person"),
        fields: &[FieldDef {
            name: "value",
            kind: FieldKind::Text,
            required: false,
        }],
    },
    TypeDef {
        name: "relationships.pet",
        parent: None,
        fields: &[FieldDef {
            name: "species",
            kind: FieldKind::Text,
            required: false,
        }],
    },
    // schedule
    TypeDef {
        name: "schedule.routine",
        parent: None,
        fields: &[
            FieldDef {
                name: "days",
                kind: FieldKind::EnumList(&[
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                ]),
                required: false,
            },
            FieldDef {
                name: "time",
                kind: FieldKind::Text,
                required: false,
            },
        ],
    },
    TypeDef {
        name: "schedule.event",
        parent: None,
        fields: &[
            FieldDef {
                name: "starts",
                kind: FieldKind::Date,
                required: false,
            },
            FieldDef {
                name: "ends",
                kind: FieldKind::Date,
                required: false,
            },
            FieldDef {
                name: "place",
                kind: FieldKind::Text,
                required: false,
            },
        ],
    },
    // work
    TypeDef {
        name: "work.employer",
        parent: None,
        fields: &[FieldDef {
            name: "city",
            kind: FieldKind::Text,
            required: false,
        }],
    },
    TypeDef {
        name: "work.role",
        parent: None,
        fields: &[FieldDef {
            name: "since",
            kind: FieldKind::Date,
            required: false,
        }],
    },
    TypeDef {
        name: "work.project",
        parent: None,
        fields: &[],
    },
    // health
    TypeDef {
        name: "health.condition",
        parent: None,
        fields: &[FieldDef {
            name: "since",
            kind: FieldKind::Date,
            required: false,
        }],
    },
    TypeDef {
        name: "health.allergy",
        parent: None,
        fields: &[FieldDef {
            name: "severity",
            kind: FieldKind::Enum(SEVERITY),
            required: false,
        }],
    },
    TypeDef {
        name: "health.medication",
        parent: None,
        fields: &[
            FieldDef {
                name: "dose",
                kind: FieldKind::Text,
                required: false,
            },
            FieldDef {
                name: "schedule",
                kind: FieldKind::Text,
                required: false,
            },
        ],
    },
    // finances
    TypeDef {
        name: "finances.budget",
        parent: None,
        fields: &[
            FieldDef {
                name: "amount",
                kind: FieldKind::Number,
                required: true,
            },
            FieldDef {
                name: "currency",
                kind: FieldKind::Text,
                required: true,
            },
            FieldDef {
                name: "period",
                kind: FieldKind::Enum(PERIOD),
                required: false,
            },
        ],
    },
    TypeDef {
        name: "finances.goal",
        parent: None,
        fields: &[
            FieldDef {
                name: "amount",
                kind: FieldKind::Number,
                required: true,
            },
            FieldDef {
                name: "currency",
                kind: FieldKind::Text,
                required: true,
            },
            FieldDef {
                name: "by",
                kind: FieldKind::Date,
                required: false,
            },
        ],
    },
    TypeDef {
        name: "finances.subscription",
        parent: None,
        fields: &[
            FieldDef {
                name: "amount",
                kind: FieldKind::Number,
                required: true,
            },
            FieldDef {
                name: "currency",
                kind: FieldKind::Text,
                required: true,
            },
            FieldDef {
                name: "period",
                kind: FieldKind::Enum(PERIOD),
                required: false,
            },
        ],
    },
];

/// `attends, works_with, prefers_over, related_to, lives_at, works_at` are
/// named as a minimum in DESIGN.md §2 with no `from`/`to` given; the sets
/// below are a decided-while-building call (see DESIGN.md).
pub static LINKS: &[LinkDef] = &[
    LinkDef {
        name: "attends",
        from: &["identity.person", "relationships.person"],
        to: &["schedule.event"],
    },
    LinkDef {
        name: "works_with",
        from: &["identity.person", "relationships.person"],
        to: &["identity.person", "relationships.person"],
    },
    LinkDef {
        name: "prefers_over",
        from: &[
            "preferences.food.cuisine",
            "preferences.food.dish",
            "preferences.music.genre",
            "preferences.music.artist",
            "preferences.travel.style",
            "preferences.travel.place",
        ],
        to: &[
            "preferences.food.cuisine",
            "preferences.food.dish",
            "preferences.music.genre",
            "preferences.music.artist",
            "preferences.travel.style",
            "preferences.travel.place",
        ],
    },
    LinkDef {
        name: "related_to",
        from: &["relationships.person"],
        to: &["relationships.person"],
    },
    LinkDef {
        name: "lives_at",
        from: &["identity.person", "relationships.person"],
        to: &["identity.location"],
    },
    LinkDef {
        name: "works_at",
        from: &["identity.person", "relationships.person"],
        to: &["work.employer"],
    },
];

pub fn find_type(name: &str) -> Option<&'static TypeDef> {
    TYPES.iter().find(|t| t.name == name)
}

pub fn find_link(name: &str) -> Option<&'static LinkDef> {
    LINKS.iter().find(|l| l.name == name)
}

/// The compartment a type (or a dotted field-selector rooted at a type)
/// belongs to: its first dotted segment.
pub fn compartment_of(type_name: &str) -> Option<Compartment> {
    let seg = type_name.split('.').next()?;
    Compartment::parse(seg)
}

/// Closed field lookup: `name`/`note` are always valid (implicit on every
/// type); anything else must be declared on `type_name`'s [`TypeDef`].
pub fn find_field(type_name: &str, field_name: &str) -> Option<FieldDef> {
    if field_name == "name" {
        return Some(NAME_FIELD);
    }
    if field_name == "note" {
        return Some(NOTE_FIELD);
    }
    find_type(type_name)?
        .fields
        .iter()
        .find(|f| f.name == field_name)
        .copied()
}

fn field_json(f: &FieldDef) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "name": f.name,
        "kind": f.kind.label(),
        "required": f.required,
    });
    if let Some(values) = f.kind.allowed_values() {
        obj.as_object_mut()
            .expect("object literal")
            .insert("values".to_string(), serde_json::json!(values));
    }
    obj
}

/// The schema, exported verbatim as JSON. `docs/SCHEMA.md` is a rendering of
/// exactly this (see the `schema_doc_is_fresh` test).
pub fn schema_json() -> String {
    let types: Vec<serde_json::Value> = TYPES
        .iter()
        .map(|t| {
            let mut fields = vec![field_json(&NAME_FIELD)];
            fields.extend(t.fields.iter().map(field_json));
            fields.push(field_json(&NOTE_FIELD));
            serde_json::json!({
                "name": t.name,
                "parent": t.parent,
                "compartment": compartment_of(t.name).map(|c| c.as_str()),
                "fields": fields,
            })
        })
        .collect();

    let links: Vec<serde_json::Value> = LINKS
        .iter()
        .map(|l| serde_json::json!({ "name": l.name, "from": l.from, "to": l.to }))
        .collect();

    let compartments: Vec<&str> = COMPARTMENTS.iter().map(|c| c.as_str()).collect();

    serde_json::json!({
        "version": SCHEMA_VERSION,
        "compartments": compartments,
        "types": types,
        "links": links,
    })
    .to_string()
}
