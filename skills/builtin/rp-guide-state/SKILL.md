---
name: rp-guide-state
description: Design, inspect, validate, configure, reset, or diagnose Roleplay Session State; add State-driven world-book conditions; or assess MVU-to-rp.state conversion when the user explicitly asks about variables or State behavior.
---

# Roleplay State Guide

Treat `rp.state` as conversation-owned state. Use this guide for variable design and maintenance, not for ordinary story continuation.

## Choose the correct operation

- A namespace is a container such as `story`; ordinary variables are fields inside that namespace's JSON `value`, addressed by JSON Pointers such as `/affection`. A namespace may hold any schema-valid JSON value, but do not create one namespace per scalar unless it genuinely needs an independent schema and revision.
- `rp_state` configures a complete namespace. It has no add-variable, edit-variable, or delete-variable action. Add, rename, or remove a variable by updating the namespace's complete definition and complete affected values.
- A value change caused by the story is not configuration. Submit it only as a `state.update` effect in the final `rp_commit_turn` call.
- `reset` resets the complete namespace to its `initialValue`; `delete` deletes the complete namespace.

## Inspect before deciding

- Use `rp_state_read` with `action: "list"` to discover namespaces and with `action: "get"` plus the exact namespace to read its definition, initial value, current value, revision, rules, and diagnostics.
- Treat the returned projection as the only current State view. Do not infer a second state from a character card, world book, MVU template, prior tool output, or visible prose.
- Read [references/protocol.md](references/protocol.md) when a resource reader is available and the task needs advanced rules, condition expressions, or protocol diagnosis. The complete contract for ordinary variable configuration is included below.
- Read [references/mvu.md](references/mvu.md) only when importing, reviewing, or diagnosing MVU material.

## Configure a namespace

- Do not create, update, reset, or delete a namespace unless the user explicitly asks to change saved State configuration.
- In Agent mode, use `rp_state` for an explicit configuration change. Read the namespace immediately before `update`, `reset`, or `delete`, and pass its exact `expectedRevision`.
- Assemble one complete request before calling the tool; do not probe the validator with partial calls.
- `create` requires exactly `action`, `namespace`, `expectedRevision: 0`, `definition`, and `initialValue`.
- `update` requires `action`, `namespace`, the exact current `expectedRevision`, and a complete replacement `definition`. It may also carry complete replacement `initialValue` and `value`; include each one whenever the new schema would reject the saved counterpart.
- `reset` and `delete` require only `action`, `namespace`, and the exact current `expectedRevision`.
- Every `definition` must contain all four required fields: non-empty `title`; `updateMode` equal to `rules-required`, `schema-only`, or `disabled`; a restricted JSON `schema`; and `rules` as an array. `description` is the only optional definition field. When no semantic rules are needed, use `updateMode: "schema-only"` and `rules: []`—never omit either field.
- Namespace IDs and rule IDs use 1–128 lowercase ASCII letters, digits, dots, underscores, colons, or hyphens, starting with a letter or digit. Variable keys may be Chinese. Definition rules use `id` and `effect: { "op": ... }`; the live commit contract exposes them as `ruleId` and `op`. Copy the matching ID into each change; never copy the complete definition rule into a change.
- The schema may use only `type`, `title`, `description`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `minimum`, `maximum`, `minLength`, and `maxLength`. The complete `initialValue` and current `value` must validate against it.
- After a successful configuration call, rely on the refreshed run context. If refresh fails, stop before continuing the story.
- A successful configuration belongs to the assistant reply that invoked it. Editing only that reply's text preserves the configuration; deleting or regenerating the reply retracts it before any regenerated user input runs. Do not recreate a namespace until the refreshed State view confirms whether it still exists.
- Never emulate configuration with story prose, asset edits, JSON Patch, or a direct Session command.

For the first ordinary variable, prefer creating the shared `story` container. This is a complete valid request:

```json
{
  "action": "create",
  "namespace": "story",
  "expectedRevision": 0,
  "definition": {
    "title": "故事状态",
    "description": "当前对话中需要持续追踪的状态",
    "updateMode": "schema-only",
    "schema": {
      "type": "object",
      "properties": {
        "affection": {
          "type": "integer",
          "title": "好感度",
          "minimum": 0,
          "maximum": 100
        }
      },
      "required": ["affection"],
      "additionalProperties": false
    },
    "rules": []
  },
  "initialValue": {
    "affection": 0
  }
}
```

To add a variable to an existing namespace, copy the complete `definition`, `initialValue`, and `value` returned by `get`; add the field to `schema.properties` and, when required, to `schema.required`, `initialValue`, and `value`; then send the complete next definition and affected complete values in one `update`. Preserve every unrelated field and rule. Removing or renaming a variable uses the same full-replacement procedure; do not use namespace `delete` for a single field.

## Commit narrative changes

- For ordinary story continuation, do not call `rp_state`. Use the supplied `state_commit_contract` and express applicable variable changes as `state.update` effects in one successful `rp_commit_turn`; failed attempts may be corrected and retried.
- Use only `set`, `increment`, `append`, or `remove`; include a specific non-empty `reason` for every change.
- Respect the namespace update mode, the exact namespace revision, the restricted schema, rule targets, allowed operations, numeric ranges, and machine-checkable conditions.
- In `rules-required` mode, attach a listed `ruleId` to every change whose exact `path` and `op` match that rule's `target` and `op`. In `schema-only`, `ruleId` is optional, but supplying it still enforces the rule's target, operation, bounds, and condition. Group guidance does not authorize reusing a group rule ID on a child path. In `disabled`, submit no effect for that namespace.
- Treat `when` and `guidance` as semantic judgment, not executable conditions. A referenced `condition` is evaluated immediately before its change against values including earlier changes/effects in the same commit. Increment minimum/maximum constrain `by`; the schema constrains the resulting value.
- Review applicable `every-turn` rules and submit only changed values. The runtime can warn about an omitted target even when its value stayed unchanged; this warning does not block the commit. Never invent a change just to silence it.
- On failure, use the latest `retry.token` with only `retry.patches`. Add missing fields at the exact reported issue paths (for example `/effects/0/payload/changes/0/ruleId`); replace fields only if they already exist. These paths address the cached commit fields, not the namespace value. An empty patch list retries the unchanged draft and cannot fix invalid data. The saved prose is preserved separately and cannot be patched or repeated in this correction call.
- Omit parent-authored `extensions`; any enabled reply options are generated by the runtime.

## Configure State-driven lore

- Keep State values in `rp.state`; world books only reference them through `stateCondition`.
- Use exact namespace IDs and JSON Pointers. A variable-only entry uses `constant: true` plus `stateCondition`; keyword or constant activation and the State condition are combined with AND semantics.
- Validate the expression before saving the complete ordered world-book entry array. A failed or invalid condition keeps that entry inactive; it must not be presented as active lore.

Report validation failures in user-facing language, including the affected namespace or path and the correction needed. Do not expose internal event-log or projection mechanics unless the user is explicitly reviewing the protocol.
